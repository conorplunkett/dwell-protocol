// Solana helpers for the USDC advertiser checkout (dwell/docs/08).
//
// Non-custodial by construction: this module BUILDS unsigned transactions and
// VERIFIES finalized ones read-only. There are no signing keys anywhere in the
// API — the advertiser's wallet is the only signer, and the single atomic
// transaction it signs (a) pays the 10% USDC fee to the treasury and (b)
// market-buys DWELL via a Jupiter route delivered straight to the distributor
// vault. Either everything lands or nothing does.
//
// Dependency-light like the rest of the server: raw fetch against the Solana
// JSON-RPC and Jupiter swap API, plus a hand-rolled legacy-transaction encoder
// (base58, compact-u16, message layout). We request asLegacyTransaction from
// Jupiter so no address-lookup-table resolution is needed; a route that still
// demands v0 is rejected and the client re-quotes.

const crypto = require("node:crypto");

// Well-known program ids and mints.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_DECIMALS = 6;
// Headroom the payer keeps for tx fees + wSOL rent when paying in SOL (~0.01 SOL).
const SOL_GAS_HEADROOM_LAMPORTS = 10_000_000n;

// ---------- base58 (Bitcoin alphabet) ----------
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = Object.fromEntries([...B58_ALPHABET].map((c, i) => [c, BigInt(i)]));

function base58Decode(s) {
  if (typeof s !== "string" || !s.length) throw new Error("bad base58");
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error("bad base58 char");
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

function base58Encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}

// A syntactically valid Solana pubkey: base58, 32 bytes.
function isPubkey(s) {
  try { return base58Decode(s).length === 32; } catch { return false; }
}

// Fresh throwaway keypair-less reference key (Solana Pay): any unique pubkey
// works — it's appended as a read-only account so the transaction is findable
// by getSignaturesForAddress. Random 32 bytes are (astronomically) unique and
// need no private key since nothing is ever signed or held by it.
function newReferencePubkey() {
  return base58Encode(crypto.randomBytes(32));
}

// ---------- binary encoding ----------
// Solana "compact-u16" (shortvec) length prefix.
function compactU16(n) {
  const out = [];
  let rem = n;
  for (;;) {
    let byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) { out.push(byte); break; }
    out.push(byte | 0x80);
  }
  return Buffer.from(out);
}

function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

// Compile instructions into a LEGACY message + serialize an unsigned
// transaction (signature slots zeroed; the wallet fills them). Instruction
// shape matches Jupiter's /swap-instructions JSON: { programId,
// accounts: [{ pubkey, isSigner, isWritable }], data: base64 }.
function serializeUnsignedTransaction({ feePayer, recentBlockhash, instructions }) {
  // Merge account metas: signer/writable are OR-ed across instructions.
  const metas = new Map(); // pubkey -> { isSigner, isWritable }
  const touch = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey) || { isSigner: false, isWritable: false };
    m.isSigner = m.isSigner || isSigner;
    m.isWritable = m.isWritable || isWritable;
    metas.set(pubkey, m);
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    touch(ix.programId, false, false);
    for (const a of ix.accounts) touch(a.pubkey, !!a.isSigner, !!a.isWritable);
  }

  // Canonical ordering: fee payer, writable signers, read-only signers,
  // writable non-signers, read-only non-signers.
  const rank = (k, m) => {
    if (k === feePayer) return 0;
    if (m.isSigner && m.isWritable) return 1;
    if (m.isSigner) return 2;
    if (m.isWritable) return 3;
    return 4;
  };
  const keys = [...metas.entries()]
    .sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k);
  const index = new Map(keys.map((k, i) => [k, i]));

  // Every account key AND the blockhash must be exactly 32 bytes, or the
  // message is silently truncated and no wallet can parse it. A wrong program
  // constant is the classic cause — fail loud at build time instead. (Verified
  // against @solana/web3.js: correct keys serialize byte-identically.)
  for (const k of [...keys, recentBlockhash]) {
    if (base58Decode(k).length !== 32) throw new Error(`not a 32-byte Solana key: ${k}`);
  }

  let numSigners = 0, numReadonlySigned = 0, numReadonlyUnsigned = 0;
  for (const k of keys) {
    const m = metas.get(k);
    if (m.isSigner) { numSigners++; if (!m.isWritable) numReadonlySigned++; }
    else if (!m.isWritable) numReadonlyUnsigned++;
  }

  const parts = [
    Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]),
    compactU16(keys.length),
    ...keys.map((k) => base58Decode(k)),
    base58Decode(recentBlockhash),
    compactU16(instructions.length),
  ];
  for (const ix of instructions) {
    const data = Buffer.from(ix.data, "base64");
    parts.push(
      Buffer.from([index.get(ix.programId)]),
      compactU16(ix.accounts.length),
      Buffer.from(ix.accounts.map((a) => index.get(a.pubkey))),
      compactU16(data.length),
      data
    );
  }
  const message = Buffer.concat(parts);
  const tx = Buffer.concat([compactU16(numSigners), Buffer.alloc(64 * numSigners), message]);
  return tx.toString("base64");
}

// SPL Token TransferChecked (ix 12): fee leg, USDC -> treasury vault. The
// Solana Pay reference key rides as an extra read-only account (the token
// program ignores extras) so the payment is findable on-chain by reference.
function transferCheckedInstruction({ source, mint, destination, owner, amount, decimals, reference }) {
  return {
    programId: TOKEN_PROGRAM,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      ...(reference ? [{ pubkey: reference, isSigner: false, isWritable: false }] : []),
    ],
    data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])]).toString("base64"),
  };
}

// System-program transfer (ix 2): the fee leg when paying in SOL — native
// lamports to the treasury. Same Solana Pay trick: the reference key rides as
// an extra read-only account (the system program ignores extras).
function systemTransferInstruction({ from, to, lamports, reference }) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      ...(reference ? [{ pubkey: reference, isSigner: false, isWritable: false }] : []),
    ],
    data: data.toString("base64"),
  };
}

// Memo carrying the order id — human-readable join handle in explorers.
function memoInstruction(text) {
  return { programId: MEMO_PROGRAM, accounts: [], data: Buffer.from(text, "utf8").toString("base64") };
}

function createSolana({ config, fetchImpl }) {
  const doFetch = fetchImpl || fetch;

  async function rpc(method, params) {
    const res = await doFetch(config.solanaRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`solana rpc ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`solana rpc ${method}: ${body.error.message}`);
    return body.result;
  }

  // The payer's USDC token account with the largest balance — the source of
  // both legs. RPC lookup instead of ATA derivation keeps this module free of
  // PDA/curve math (and honors payers whose USDC sits in a non-ATA account).
  async function findUsdcAccount(owner) {
    const result = await rpc("getTokenAccountsByOwner", [
      owner, { mint: config.usdcMint }, { encoding: "jsonParsed" },
    ]);
    const accounts = (result?.value || [])
      .map((a) => ({ pubkey: a.pubkey, amount: BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || "0") }))
      .sort((a, b) => (a.amount > b.amount ? -1 : 1));
    return accounts[0] || null;
  }

  async function jupiterQuote({ inputMint, outputMint, amount }) {
    const q = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amount),
      slippageBps: String(config.maxSlippageBps),
      swapMode: "ExactIn",
      asLegacyTransaction: "true", // no ALTs -> our legacy encoder suffices
    });
    const res = await doFetch(`${config.jupiterBaseUrl}/quote?${q}`);
    if (!res.ok) throw new Error(`jupiter quote: HTTP ${res.status}`);
    const quote = await res.json();
    if (quote.error) throw new Error(`jupiter quote: ${quote.error}`);
    if (!quote.outAmount) throw new Error("jupiter quote: no route");
    return quote;
  }

  // The swap leg's quote for an order: USDC pays the tranche in micro-USDC;
  // SOL pays it in lamports (priced first via priceOrderInSol).
  function tranchQuoteParams(order) {
    return order.pay_currency === "sol"
      ? { inputMint: WSOL_MINT, outputMint: config.dwellMint, amount: BigInt(order.pay_total_units) - BigInt(order.pay_fee_units) }
      : { inputMint: config.usdcMint, outputMint: config.dwellMint, amount: order.tranche_micro_usdc };
  }

  // How many lamports the order's USD price is worth right now, via a
  // USDC -> wSOL quote of the exact price. Re-run on every build, like the
  // slippage floor — the wallet always sees a current number.
  async function priceOrderInSol(priceMicroUsdc, feeBps) {
    const pricing = await jupiterQuote({ inputMint: config.usdcMint, outputMint: WSOL_MINT, amount: priceMicroUsdc });
    const total = BigInt(pricing.outAmount);
    const fee = (total * BigInt(feeBps)) / 10000n;
    return { totalLamports: total, feeLamports: fee, trancheLamports: total - fee };
  }

  async function jupiterSwapInstructions({ quoteResponse, userPublicKey, wrapSol = false }) {
    const res = await doFetch(`${config.jupiterBaseUrl}/swap-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        // The whole point: the bought DWELL lands in the distributor vault,
        // never in a company hot wallet and never back with the payer.
        destinationTokenAccount: config.distributorDwellAta,
        asLegacyTransaction: true,
        // USDC in: no SOL legs. SOL in: Jupiter wraps the payer's native SOL.
        wrapAndUnwrapSol: wrapSol,
      }),
    });
    if (!res.ok) throw new Error(`jupiter swap-instructions: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`jupiter swap-instructions: ${body.error}`);
    if (body.addressLookupTableAddresses?.length) {
      // Shouldn't happen with asLegacyTransaction, but a v0-only route can't be
      // encoded here — surface it so the client re-quotes (thinner route).
      throw new Error("jupiter returned a v0-only route — re-quote");
    }
    return body;
  }

  // One atomic unsigned transaction for an order: fee transfer (with reference
  // key) + order-id memo + the Jupiter swap of the 90% tranche. Rail-aware:
  // USDC pays the fee as an SPL transfer; SOL as a native lamport transfer.
  async function buildOrderTransaction({ order, payer, quoteResponse }) {
    if (!isPubkey(payer)) throw Object.assign(new Error("payer must be a Solana pubkey"), { code: "BAD_ACCOUNT" });
    const isSol = order.pay_currency === "sol";
    let feeInstruction;
    if (isSol) {
      const bal = await rpc("getBalance", [payer, { commitment: "finalized" }]);
      const lamports = BigInt(bal?.value ?? bal ?? 0);
      const need = BigInt(order.pay_total_units) + SOL_GAS_HEADROOM_LAMPORTS;
      if (lamports < need) {
        throw Object.assign(new Error(`insufficient SOL: need ${need} lamports (incl. gas headroom), have ${lamports}`), { code: "NO_FUNDS" });
      }
      feeInstruction = systemTransferInstruction({
        from: payer,
        to: config.treasurySolAccount,
        lamports: order.pay_fee_units,
        reference: order.reference_pubkey,
      });
    } else {
      const usdcAccount = await findUsdcAccount(payer);
      if (!usdcAccount) throw Object.assign(new Error("no USDC account for this wallet"), { code: "NO_FUNDS" });
      const need = BigInt(order.price_micro_usdc);
      if (usdcAccount.amount < need) {
        throw Object.assign(new Error(`insufficient USDC: need ${need}, have ${usdcAccount.amount}`), { code: "NO_FUNDS" });
      }
      feeInstruction = transferCheckedInstruction({
        source: usdcAccount.pubkey,
        mint: config.usdcMint,
        destination: config.treasuryUsdcAta,
        owner: payer,
        amount: order.fee_micro_usdc,
        decimals: USDC_DECIMALS,
        reference: order.reference_pubkey,
      });
    }
    const swap = await jupiterSwapInstructions({ quoteResponse, userPublicKey: payer, wrapSol: isSol });
    const { value } = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]).then((r) => ({ value: r.value || r }));
    const instructions = [
      ...(swap.computeBudgetInstructions || []),
      feeInstruction,
      memoInstruction(`dwell-usdc-order:${order.id}`),
      ...(swap.setupInstructions || []),
      swap.swapInstruction,
      ...(swap.cleanupInstruction ? [swap.cleanupInstruction] : []),
    ];
    return serializeUnsignedTransaction({
      feePayer: payer,
      recentBlockhash: value.blockhash,
      instructions,
    });
  }

  // Signatures that touched the order's reference key — how a poll discovers
  // the payment without webhooks (Solana Pay findReference).
  async function findReferenceSignatures(referencePubkey) {
    const result = await rpc("getSignaturesForAddress", [referencePubkey, { limit: 5 }]);
    return (result || []).map((r) => r.signature);
  }

  // Read-only verification of a finalized transaction against the order:
  //   - executed without error,
  //   - carries the order's reference key,
  //   - treasury gained >= the fee leg (USDC token delta, or native lamport
  //     delta when the order pays in SOL),
  //   - distributor DWELL account gained >= the slippage floor (minDwellOut).
  // Amount deltas come from the runtime's own pre/post balances — never from
  // anything the client claims. Returns { ok, dwellOut, feePaid } or
  // { ok: false, reason }.
  async function verifyOrderTransaction({ signature, order }) {
    const tx = await rpc("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) return { ok: false, reason: "not_found" };
    if (tx.meta?.err) return { ok: false, reason: "tx_failed" };

    const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
    if (!keys.includes(order.reference_pubkey)) return { ok: false, reason: "reference_missing" };

    const delta = (account, mint) => {
      const find = (list) => (list || []).find((b) => keys[b.accountIndex] === account && b.mint === mint);
      const pre = find(tx.meta?.preTokenBalances);
      const post = find(tx.meta?.postTokenBalances);
      if (!post && !pre) return null; // account untouched by this tx
      return BigInt(post?.uiTokenAmount?.amount || "0") - BigInt(pre?.uiTokenAmount?.amount || "0");
    };

    let feePaid;
    if (order.pay_currency === "sol") {
      const idx = keys.indexOf(config.treasurySolAccount);
      if (idx < 0) return { ok: false, reason: "fee_short" };
      feePaid = BigInt(tx.meta?.postBalances?.[idx] ?? 0) - BigInt(tx.meta?.preBalances?.[idx] ?? 0);
      if (feePaid < BigInt(order.pay_fee_units)) return { ok: false, reason: "fee_short" };
    } else {
      feePaid = delta(config.treasuryUsdcAta, config.usdcMint);
      if (feePaid === null || feePaid < BigInt(order.fee_micro_usdc)) return { ok: false, reason: "fee_short" };
    }

    const dwellOut = delta(config.distributorDwellAta, config.dwellMint);
    if (dwellOut === null || dwellOut <= 0n) return { ok: false, reason: "no_dwell_out" };
    if (dwellOut < BigInt(order.min_dwell_out)) return { ok: false, reason: "slippage_floor" };

    return { ok: true, dwellOut, feePaid, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null };
  }

  return {
    isPubkey,
    newReferencePubkey,
    jupiterQuote,
    tranchQuoteParams,
    priceOrderInSol,
    buildOrderTransaction,
    findReferenceSignatures,
    verifyOrderTransaction,
  };
}

module.exports = {
  createSolana,
  // exported for tests and the edge-function mirror
  base58Decode,
  base58Encode,
  compactU16,
  serializeUnsignedTransaction,
  transferCheckedInstruction,
  systemTransferInstruction,
  memoInstruction,
  TOKEN_PROGRAM,
  MEMO_PROGRAM,
  SYSTEM_PROGRAM,
  WSOL_MINT,
};
