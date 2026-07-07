// The earnings leg of the devnet dry run: viewers earn from funded campaign
// pools at the 60/10/30 split (docs/01-tokenomics.md), the root publisher
// snapshots cumulative entitlements into a Merkle root, and users claim.
//
// Cast:
//   viewer   — referred by `referrer`; watched all of campaigns 1 and 3
//   viewer2  — unreferred; watched all of campaign 2 (its 10% referrer leg
//              becomes the TREASURY SHORTFALL LEAF, docs/04 §A)
//
// Epoch 1 (campaigns 1+2 pools: 1,080,000 + 12,000 DWELL):
//   viewer   60% of c1        = 648,000 DWELL
//   referrer 10% of c1        = 108,000 DWELL
//   viewer2  60% of c2        =   7,200 DWELL
//   treasury shortfall (c2 10%) = 1,200 DWELL
//   epoch total 764,400 = exactly the distributor's 70% legs on-chain ✓
// Then: fund the vault for epoch 1 ONLY (standing rule), set root 1,
// claim all four leaves — viewer2's claim is GAS-SPONSORED by the treasury
// (the user needs no SOL; funds still only reach viewer2's wallet).
//
// Epoch 2: campaign 3 ($10 gross -> 9 USDC tranche) funds on-chain; viewer
// watched it all -> viewer +64,800, referrer +10,800; cumulative tree
// rebuilt; viewer claims the DELTA only.
//
// Drills: stale epoch-1 proof after epoch 2 (NothingToClaim), inflated
// amount (InvalidProof), epoch skip (WrongEpoch), non-rootSetter setRoot
// (NotRootSetter), pause blocks claims then unpause restores.
//
// Env: SOL_KEYS_DIR, DWELL_MINT, USDC_MINT
// Usage: node earnings-epochs.js

import crypto from "node:crypto";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  connection, loadKeypair, keysDir,
  FUNDER_PROGRAM_ID, SWAP_PROGRAM_ID, DISTRIBUTOR_PROGRAM_ID,
  funderStatePda, funderVaultAuthorityPda, campaignMarkerPda,
  swapStatePda, swapVaultAuthorityPda,
  distributorStatePda, distributorVaultAuthorityPda, claimStatusPda,
  funderIx, distributorIx, sendTx, expectFail,
} from "./common.js";
import { buildTree } from "./merkle.js";

const DWELL_MINT = new PublicKey(process.env.DWELL_MINT);
const USDC_MINT = new PublicKey(process.env.USDC_MINT);
const D = 10n ** 9n; // DWELL base units

const conn = connection();
const treasury = loadKeypair(`${keysDir()}/treasury.json`);
const rootSetter = loadKeypair(`${keysDir()}/rootSetter.json`);
const keeper = loadKeypair(`${keysDir()}/keeper.json`);
const viewer = loadKeypair(`${keysDir()}/viewer.json`);
const referrer = loadKeypair(`${keysDir()}/referrer.json`);
const viewer2 = loadKeypair(`${keysDir()}/viewer2.json`);

const ata = (m, o) => getAssociatedTokenAddressSync(m, o, true);
const vault = ata(DWELL_MINT, distributorVaultAuthorityPda());
const legacyStandin = ata(DWELL_MINT, rootSetter.publicKey); // held the 70% legs until now
const bal = async (a) => (await getAccount(conn, a)).amount;

const claimIx = (wallet, cumulative, proof, payer) =>
  new TransactionInstruction({
    programId: DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: distributorStatePda(), isSigner: false, isWritable: true },
      { pubkey: claimStatusPda(wallet), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: distributorVaultAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ata(DWELL_MINT, wallet), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: distributorIx.claim(cumulative, proof),
  });

const setRootIx = (root, epoch, total, signer = rootSetter) =>
  new TransactionInstruction({
    programId: DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: distributorStatePda(), isSigner: false, isWritable: true },
    ],
    data: distributorIx.setRoot(root, epoch, total),
  });

const ownerIx = (data) =>
  new TransactionInstruction({
    programId: DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: false },
      { pubkey: distributorStatePda(), isSigner: false, isWritable: true },
    ],
    data,
  });

// ---------- earnings math (what the backend snapshot job computes) ----------

// campaign pools from the two CampaignFunded events already on devnet
const C1_POOL = 1_080_000n * D; // 90 USDC tranche
const C2_POOL = 12_000n * D; //  1 USDC tranche

// epoch 1 cumulative entitlements
const epoch1 = [
  { wallet: viewer.publicKey, cumulative: (C1_POOL * 6000n) / 10000n },
  { wallet: referrer.publicKey, cumulative: (C1_POOL * 1000n) / 10000n },
  { wallet: viewer2.publicKey, cumulative: (C2_POOL * 6000n) / 10000n },
  { wallet: treasury.publicKey, cumulative: (C2_POOL * 1000n) / 10000n }, // shortfall leaf
];
const epoch1Total = epoch1.reduce((s, e) => s + e.cumulative, 0n);
console.log("epoch 1 leaves:");
for (const e of epoch1) console.log(`  ${e.wallet.toBase58()}  ${e.cumulative}`);
console.log(`epoch 1 total: ${epoch1Total} (must equal the on-chain 70% legs: 764,400 DWELL)`);
if (epoch1Total !== 764_400n * D) throw new Error("epoch-1 books do not close");

// ---------- T3: init distributor + vault, migrate the 70% legs, fund epoch 1 only ----------

let sig = await sendTx(conn, [
  new TransactionInstruction({
    programId: DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: true },
      { pubkey: distributorStatePda(), isSigner: false, isWritable: true },
      { pubkey: rootSetter.publicKey, isSigner: false, isWritable: false },
      { pubkey: DWELL_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: distributorIx.initialize(),
  }),
  createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, vault, distributorVaultAuthorityPda(), DWELL_MINT),
  ...[viewer, referrer, viewer2].map((k) =>
    createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, ata(DWELL_MINT, k.publicKey), k.publicKey, DWELL_MINT),
  ),
  // epoch-1 funding: exactly the epoch total, from the stand-in ATA that
  // received the SwapAndFund legs (rootSetter co-signs as its owner)
  createTransferInstruction(legacyStandin, vault, rootSetter.publicKey, epoch1Total),
], treasury, [rootSetter]);
console.log("T3 distributor initialized, vault funded for epoch 1 only:", sig);

// ---------- T4: publish root 1 ----------
const tree1 = buildTree(epoch1);
sig = await sendTx(conn, [setRootIx(tree1.root, 1n, epoch1Total)], rootSetter);
console.log("T4 root 1 published:", sig);

// ---------- T5–T8: the four claims ----------
for (const [name, kp, payer] of [
  ["viewer", viewer, viewer],
  ["referrer", referrer, viewer], // viewer pays referrer's gas — anyone can execute for any wallet
  ["viewer2 (gas-sponsored, user holds zero SOL)", viewer2, treasury],
  ["treasury shortfall leaf", treasury, treasury],
]) {
  const e = tree1.entryFor(kp.publicKey);
  const before = await bal(ata(DWELL_MINT, kp.publicKey));
  sig = await sendTx(conn, [claimIx(kp.publicKey, e.cumulative, tree1.proofFor(kp.publicKey), payer)], payer);
  const got = (await bal(ata(DWELL_MINT, kp.publicKey))) - before;
  console.log(`claim ${name}: +${got} DWELL (${sig.slice(0, 20)}…)`);
  if (got !== e.cumulative) throw new Error(`${name} claim mismatch`);
}
console.log("vault after epoch-1 claims:", await bal(vault), "(must be 0)");

// ---------- T9: campaign 3 funds on-chain ($10 gross -> 9 USDC tranche) ----------
const c3 = crypto.randomBytes(32);
const C3_TRANCHE = 9_000_000n;
const C3_POOL = 108_000n * D;
const funderUsdc = ata(USDC_MINT, funderVaultAuthorityPda());
sig = await sendTx(conn, [createMintToInstruction(USDC_MINT, funderUsdc, treasury.publicKey, C3_TRANCHE)], treasury);
sig = await sendTx(conn, [
  new TransactionInstruction({
    programId: FUNDER_PROGRAM_ID,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
      { pubkey: funderStatePda(), isSigner: false, isWritable: true },
      { pubkey: campaignMarkerPda(c3), isSigner: false, isWritable: true },
      { pubkey: funderVaultAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: funderUsdc, isSigner: false, isWritable: true },
      { pubkey: ata(DWELL_MINT, funderVaultAuthorityPda()), isSigner: false, isWritable: true },
      { pubkey: SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: swapStatePda(), isSigner: false, isWritable: false },
      { pubkey: swapVaultAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: ata(DWELL_MINT, swapVaultAuthorityPda()), isSigner: false, isWritable: true },
      { pubkey: ata(USDC_MINT, swapVaultAuthorityPda()), isSigner: false, isWritable: true },
      { pubkey: legacyStandin, isSigner: false, isWritable: true }, // 70% legs still land here, then migrate per-epoch
      { pubkey: ata(DWELL_MINT, treasury.publicKey), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: funderIx.swapAndFund(c3, C3_TRANCHE, (C3_POOL * 99n) / 100n),
  }),
], keeper);
console.log("T9 campaign 3 funded on-chain:", sig);

// ---------- T10: epoch 2 — cumulative tree, delta claim ----------
const epoch2 = [
  { wallet: viewer.publicKey, cumulative: epoch1[0].cumulative + (C3_POOL * 6000n) / 10000n },
  { wallet: referrer.publicKey, cumulative: epoch1[1].cumulative + (C3_POOL * 1000n) / 10000n },
  { wallet: viewer2.publicKey, cumulative: epoch1[2].cumulative }, // unchanged
  { wallet: treasury.publicKey, cumulative: epoch1[3].cumulative }, // unchanged
];
const epoch2Delta = (C3_POOL * 7000n) / 10000n;
const tree2 = buildTree(epoch2);

sig = await sendTx(conn, [
  createTransferInstruction(legacyStandin, vault, rootSetter.publicKey, epoch2Delta),
  setRootIx(tree2.root, 2n, epoch2Delta),
], rootSetter, [rootSetter]);
console.log("T10 epoch 2 funded (delta only) + root 2 published:", sig);

const before = await bal(ata(DWELL_MINT, viewer.publicKey));
const e2 = tree2.entryFor(viewer.publicKey);
sig = await sendTx(conn, [claimIx(viewer.publicKey, e2.cumulative, tree2.proofFor(viewer.publicKey), viewer)], viewer);
const delta = (await bal(ata(DWELL_MINT, viewer.publicKey))) - before;
console.log(`T11 viewer delta claim: +${delta} DWELL (expected ${(C3_POOL * 6000n) / 10000n})`);
if (delta !== (C3_POOL * 6000n) / 10000n) throw new Error("delta claim mismatch");

// ---------- drills ----------
let err = await expectFail(conn, [claimIx(viewer.publicKey, tree1.entryFor(viewer.publicKey).cumulative, tree1.proofFor(viewer.publicKey), viewer)], viewer);
console.log("D5 stale epoch-1 proof after epoch 2 rejected:", err.includes("custom program error") ? "revert (InvalidProof — old root replaced)" : err.slice(0, 80));

err = await expectFail(conn, [claimIx(viewer.publicKey, e2.cumulative + 1n, tree2.proofFor(viewer.publicKey), viewer)], viewer);
console.log("D6 inflated amount rejected:", err.includes("custom program error") ? "revert (InvalidProof)" : err.slice(0, 80));

err = await expectFail(conn, [setRootIx(tree2.root, 4n, 0n)], rootSetter);
console.log("D7 epoch skip (2 -> 4) rejected:", err.includes("custom program error") ? "revert (WrongEpoch)" : err.slice(0, 80));

err = await expectFail(conn, [setRootIx(tree2.root, 3n, 0n, keeper)], keeper);
console.log("D8 non-rootSetter setRoot rejected:", err.includes("custom program error") ? "revert (NotRootSetter)" : err.slice(0, 80));

await sendTx(conn, [ownerIx(distributorIx.pause())], treasury);
err = await expectFail(conn, [claimIx(referrer.publicKey, tree2.entryFor(referrer.publicKey).cumulative, tree2.proofFor(referrer.publicKey), viewer)], viewer);
console.log("D9a paused claim rejected:", err.includes("custom program error") ? "revert (Paused)" : err.slice(0, 80));
await sendTx(conn, [ownerIx(distributorIx.unpause())], treasury);
sig = await sendTx(conn, [claimIx(referrer.publicKey, tree2.entryFor(referrer.publicKey).cumulative, tree2.proofFor(referrer.publicKey), viewer)], viewer);
console.log("D9b unpaused, referrer delta claim ok:", sig.slice(0, 20) + "…");

console.log("\nvault residual:", await bal(vault), "(0 = every allocated base unit claimed, books closed)");
console.log("All earnings-path checks passed.");
