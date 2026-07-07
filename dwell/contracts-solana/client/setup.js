// One-time devnet wiring after both programs are deployed and the two mints
// exist (docs/06 Phase 1 item 4's Solana leg — see ../README.md):
//   1. create the four PDA-owned vaults + the distributor + treasury DWELL ATAs
//   2. initialize mock-jupiter-swap (fixed rate) and seed its DWELL liquidity
//   3. initialize dwell-funder (treasury_bps), set keeper + swap program
//   4. gas the keeper
//
// Env: SOL_KEYS_DIR, DWELL_MINT, USDC_MINT
// Usage: node setup.js

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  connection, loadKeypair, keysDir,
  FUNDER_PROGRAM_ID, SWAP_PROGRAM_ID,
  funderStatePda, funderVaultAuthorityPda, swapStatePda, swapVaultAuthorityPda,
  funderIx, swapIx, sendTx,
} from "./common.js";

const DWELL_MINT = new PublicKey(process.env.DWELL_MINT);
const USDC_MINT = new PublicKey(process.env.USDC_MINT);
// 1 USDC (1e6) buys 12,000 DWELL (12e12 base units at 9 dp) — the raise's
// implied launch price ≈ $0.000083/DWELL (docs/07-starfun-launch.md).
const RATE = 12_000n * 10n ** 9n;
const ROUTER_LIQUIDITY_DWELL = 50_000_000n * 10n ** 9n; // 50M DWELL to the router vault
const TREASURY_BPS = 3000;

const conn = connection();
const treasury = loadKeypair(`${keysDir()}/treasury.json`);
const keeper = loadKeypair(`${keysDir()}/keeper.json`);
const distributor = loadKeypair(`${keysDir()}/rootSetter.json`); // distributor stand-in until the Merkle program lands

const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true);
const vaults = {
  routerDwell: ata(DWELL_MINT, swapVaultAuthorityPda()),
  routerUsdc: ata(USDC_MINT, swapVaultAuthorityPda()),
  funderDwell: ata(DWELL_MINT, funderVaultAuthorityPda()),
  funderUsdc: ata(USDC_MINT, funderVaultAuthorityPda()),
  distributorDwell: ata(DWELL_MINT, distributor.publicKey),
  treasuryDwell: ata(DWELL_MINT, treasury.publicKey),
};

console.log("funder_state:        ", funderStatePda().toBase58());
console.log("funder vault auth:   ", funderVaultAuthorityPda().toBase58());
console.log("swap_state:          ", swapStatePda().toBase58());
console.log("swap vault auth:     ", swapVaultAuthorityPda().toBase58());
for (const [k, v] of Object.entries(vaults)) console.log(`${k}:`.padEnd(22), v.toBase58());

// 1. all token accounts (idempotent — safe to re-run)
let sig = await sendTx(conn, [
  createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, vaults.routerDwell, swapVaultAuthorityPda(), DWELL_MINT),
  createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, vaults.routerUsdc, swapVaultAuthorityPda(), USDC_MINT),
  createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, vaults.funderDwell, funderVaultAuthorityPda(), DWELL_MINT),
  createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, vaults.funderUsdc, funderVaultAuthorityPda(), USDC_MINT),
  createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, vaults.distributorDwell, distributor.publicKey, DWELL_MINT),
], treasury);
console.log("T-a vaults created:", sig);

// 2. init swap + seed router liquidity from the treasury's DWELL ATA
sig = await sendTx(conn, [
  new TransactionInstruction({
    programId: SWAP_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: true },
      { pubkey: swapStatePda(), isSigner: false, isWritable: true },
      { pubkey: DWELL_MINT, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: swapIx.initialize(RATE),
  }),
  createTransferInstruction(vaults.treasuryDwell, vaults.routerDwell, treasury.publicKey, ROUTER_LIQUIDITY_DWELL),
], treasury);
console.log("T-b swap initialized + router seeded:", sig);

// 3. init funder, wire keeper + swap program
sig = await sendTx(conn, [
  new TransactionInstruction({
    programId: FUNDER_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: true },
      { pubkey: funderStatePda(), isSigner: false, isWritable: true },
      { pubkey: treasury.publicKey, isSigner: false, isWritable: false },
      { pubkey: DWELL_MINT, isSigner: false, isWritable: false },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: funderIx.initialize(TREASURY_BPS),
  }),
  new TransactionInstruction({
    programId: FUNDER_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: false },
      { pubkey: funderStatePda(), isSigner: false, isWritable: true },
    ],
    data: funderIx.setKeeper(keeper.publicKey),
  }),
  new TransactionInstruction({
    programId: FUNDER_PROGRAM_ID,
    keys: [
      { pubkey: treasury.publicKey, isSigner: true, isWritable: false },
      { pubkey: funderStatePda(), isSigner: false, isWritable: true },
    ],
    data: funderIx.setSwapProgram(SWAP_PROGRAM_ID),
  }),
], treasury);
console.log("T-c funder initialized + keeper + swap program set:", sig);

// 4. gas the keeper (pays campaign-marker rent + tx fees)
sig = await sendTx(conn, [
  SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: keeper.publicKey, lamports: 50_000_000 }),
], treasury);
console.log("T-d keeper gassed 0.05 SOL:", sig);

console.log("setup complete");
