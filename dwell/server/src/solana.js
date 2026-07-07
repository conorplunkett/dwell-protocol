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

// Well-known program ids.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMZWEyttqmoTLK";
const USDC_DECIMALS = 6;

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

  async function jupiterQuote(amountMicroUsdc) {
    const q = new URLSearchParams({
      inputMint: config.usdcMint,
      outputMint: config.dwellMint,
      amount: String(amountMicroUsdc),
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

  async function jupiterSwapInstructions({ quoteResponse, userPublicKey }) {
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
        wrapAndUnwrapSol: false, // USDC in, SPL out — no SOL legs
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
  // key) + order-id memo + the Jupiter swap of the 90% tranche.
  async function buildOrderTransaction({ order, payer, quoteResponse }) {
    if (!isPubkey(payer)) throw Object.assign(new Error("payer must be a Solana pubkey"), { code: "BAD_ACCOUNT" });
    const usdcAccount = await findUsdcAccount(payer);
    if (!usdcAccount) throw Object.assign(new Error("no USDC account for this wallet"), { code: "NO_USDC" });
    const need = BigInt(order.price_micro_usdc);
    if (usdcAccount.amount < need) {
      throw Object.assign(new Error(`insufficient USDC: need ${need}, have ${usdcAccount.amount}`), { code: "NO_USDC" });
    }
    const swap = await jupiterSwapInstructions({ quoteResponse, userPublicKey: payer });
    const { value } = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]).then((r) => ({ value: r.value || r }));
    const instructions = [
      ...(swap.computeBudgetInstructions || []),
      transferCheckedInstruction({
        source: usdcAccount.pubkey,
        mint: config.usdcMint,
        destination: config.treasuryUsdcAta,
        owner: payer,
        amount: order.fee_micro_usdc,
        decimals: USDC_DECIMALS,
        reference: order.reference_pubkey,
      }),
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
  //   - treasury USDC account gained >= the fee leg,
  //   - distributor DWELL account gained >= the slippage floor (minDwellOut).
  // Amount deltas come from the runtime's own pre/post token balances — never
  // from anything the client claims. Returns { ok, dwellOut, feePaid } or
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

    const feePaid = delta(config.treasuryUsdcAta, config.usdcMint);
    if (feePaid === null || feePaid < BigInt(order.fee_micro_usdc)) return { ok: false, reason: "fee_short" };

    const dwellOut = delta(config.distributorDwellAta, config.dwellMint);
    if (dwellOut === null || dwellOut <= 0n) return { ok: false, reason: "no_dwell_out" };
    if (dwellOut < BigInt(order.min_dwell_out)) return { ok: false, reason: "slippage_floor" };

    return { ok: true, dwellOut, feePaid, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null };
  }

  return {
    isPubkey,
    newReferencePubkey,
    jupiterQuote,
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
  memoInstruction,
  TOKEN_PROGRAM,
  MEMO_PROGRAM,
};
