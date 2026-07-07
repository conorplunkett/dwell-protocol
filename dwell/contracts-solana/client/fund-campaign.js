// The dry run's core transaction (docs/06 Phase 1 item 4, Solana leg):
// a paid campaign's 90% tranche buys DWELL and splits 70/30 to the
// distributor and treasury — then the failure drills.
//
//   T1: sweeper stand-in mints the USDC tranche to the funder's vault
//       (in production: Stripe payout -> USDC -> this vault)
//   T2: keeper calls SwapAndFund -> assert balances + campaign marker
//   D1: replaying the same campaign_id fails (AlreadyFunded)
//   D2: a non-keeper signer fails (NotKeeper)
//   D3: min_dwell_out above the rate fails (InsufficientOutput slippage guard)
//   D4: owner pauses -> funding fails (Paused) -> unpause -> a second
//       campaign funds fine
//
// Env: SOL_KEYS_DIR, DWELL_MINT, USDC_MINT
// Usage: node fund-campaign.js

import crypto from "node:crypto";
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  connection, loadKeypair, keysDir,
  FUNDER_PROGRAM_ID, SWAP_PROGRAM_ID,
  funderStatePda, funderVaultAuthorityPda, campaignMarkerPda,
  swapStatePda, swapVaultAuthorityPda,
  funderIx, sendTx, expectFail,
} from "./common.js";

const DWELL_MINT = new PublicKey(process.env.DWELL_MINT);
const USDC_MINT = new PublicKey(process.env.USDC_MINT);
const RATE_DWELL_PER_USDC = 12_000n; // must match setup.js

const conn = connection();
const treasury = loadKeypair(`${keysDir()}/treasury.json`);
const keeper = loadKeypair(`${keysDir()}/keeper.json`);
const distributor = loadKeypair(`${keysDir()}/rootSetter.json`);
const viewer = loadKeypair(`${keysDir()}/viewer.json`); // stands in as the non-keeper attacker in D2

const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true);
const funderUsdc = ata(USDC_MINT, funderVaultAuthorityPda());
const funderDwell = ata(DWELL_MINT, funderVaultAuthorityPda());
const routerDwell = ata(DWELL_MINT, swapVaultAuthorityPda());
const routerUsdc = ata(USDC_MINT, swapVaultAuthorityPda());
const distributorDwell = ata(DWELL_MINT, distributor.publicKey);
const treasuryDwell = ata(DWELL_MINT, treasury.publicKey);

const bal = async (addr) => (await getAccount(conn, addr)).amount;

function swapAndFundIx(campaignId32, usdcAmount, minDwellOut, signer = keeper) {
  return new TransactionInstruction({
    programId: FUNDER_PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: funderStatePda(), isSigner: false, isWritable: true },
      { pubkey: campaignMarkerPda(campaignId32), isSigner: false, isWritable: true },
      { pubkey: funderVaultAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: funderUsdc, isSigner: false, isWritable: true },
      { pubkey: funderDwell, isSigner: false, isWritable: true },
      { pubkey: SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: swapStatePda(), isSigner: false, isWritable: false },
      { pubkey: swapVaultAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: routerDwell, isSigner: false, isWritable: true },
      { pubkey: routerUsdc, isSigner: false, isWritable: true },
      { pubkey: distributorDwell, isSigner: false, isWritable: true },
      { pubkey: treasuryDwell, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: funderIx.swapAndFund(campaignId32, usdcAmount, minDwellOut),
  });
}

const pauseIx = (p) =>
  new TransactionInstruction({
    programId: FUNDER_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: false },
      { pubkey: funderStatePda(), isSigner: false, isWritable: true },
    ],
    data: p ? funderIx.pause() : funderIx.unpause(),
  });

// --- T1: the sweeper leg. Campaign: $100 gross -> $90 tranche (90_000_000 micro-USDC).
const campaignId = crypto.randomBytes(32);
const TRANCHE = 90_000_000n;
console.log("campaign_id:", campaignId.toString("hex"));

let sig = await sendTx(conn, [
  createMintToInstruction(USDC_MINT, funderUsdc, treasury.publicKey, TRANCHE),
], treasury);
console.log("T1 sweeper minted 90 USDC tranche to funder vault:", sig);

// --- T2: the buy. Expected out: 90 USDC * 12,000 = 1,080,000 DWELL.
const expectedOut = (TRANCHE * RATE_DWELL_PER_USDC * 10n ** 9n) / 10n ** 6n;
const minOut = (expectedOut * 99n) / 100n; // 1% slippage floor, like the EVM keeper's quote
const before = {
  distributor: await bal(distributorDwell),
  treasury: await bal(treasuryDwell),
  funderUsdc: await bal(funderUsdc),
};

sig = await sendTx(conn, [swapAndFundIx(campaignId, TRANCHE, minOut)], keeper);
console.log("T2 SwapAndFund:", sig);

const after = {
  distributor: await bal(distributorDwell),
  treasury: await bal(treasuryDwell),
  funderUsdc: await bal(funderUsdc),
  routerUsdc: await bal(routerUsdc),
};
const gotDistributor = after.distributor - before.distributor;
const gotTreasury = after.treasury - before.treasury;
const dwellOut = gotDistributor + gotTreasury;

console.log(`  dwell_out:       ${dwellOut} (expected ${expectedOut})`);
console.log(`  to_distributor:  ${gotDistributor} (70%: ${(expectedOut * 7000n) / 10000n})`);
console.log(`  to_treasury:     ${gotTreasury} (30%: ${(expectedOut * 3000n) / 10000n})`);
console.log(`  funder USDC:     ${before.funderUsdc} -> ${after.funderUsdc}`);
console.log(`  router USDC:     ${after.routerUsdc}`);

if (dwellOut !== expectedOut) throw new Error("dwell_out mismatch");
if (gotTreasury !== (expectedOut * 3000n) / 10000n) throw new Error("treasury split mismatch");
if (gotDistributor !== expectedOut - gotTreasury) throw new Error("distributor split mismatch");
if (after.funderUsdc !== before.funderUsdc - TRANCHE) throw new Error("funder USDC not drained by tranche");
console.log("T2 split verified: 70/30 exact");

// --- D1: replay the same campaign
let err = await expectFail(conn, [swapAndFundIx(campaignId, TRANCHE, 1n)], keeper);
console.log("D1 replay rejected (AlreadyFunded):", err.includes("custom program error") ? "revert" : err);

// --- D2: non-keeper signer
const c2 = crypto.randomBytes(32);
err = await expectFail(conn, [swapAndFundIx(c2, 1_000_000n, 1n, viewer)], viewer);
console.log("D2 non-keeper rejected (NotKeeper):", err.includes("custom program error") ? "revert" : err);

// --- D3: slippage guard — demand more than the rate can pay
sig = await sendTx(conn, [createMintToInstruction(USDC_MINT, funderUsdc, treasury.publicKey, 1_000_000n)], treasury);
err = await expectFail(conn, [swapAndFundIx(c2, 1_000_000n, expectedOut * 10n)], keeper);
console.log("D3 slippage floor rejected (InsufficientOutput):", err.includes("custom program error") ? "revert" : err);

// --- D4: pause blocks funding; unpause restores it
await sendTx(conn, [pauseIx(true)], treasury);
err = await expectFail(conn, [swapAndFundIx(c2, 1_000_000n, 1n)], keeper);
console.log("D4a paused funding rejected (Paused):", err.includes("custom program error") ? "revert" : err);
await sendTx(conn, [pauseIx(false)], treasury);
sig = await sendTx(conn, [swapAndFundIx(c2, 1_000_000n, 11_000_000_000_000n)], keeper);
console.log("D4b unpaused, campaign 2 funded (1 USDC tranche):", sig);

console.log("\nAll funding-path checks passed.");
