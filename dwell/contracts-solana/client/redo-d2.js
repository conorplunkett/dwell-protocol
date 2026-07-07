import crypto from "node:crypto";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  connection, loadKeypair, keysDir, FUNDER_PROGRAM_ID, SWAP_PROGRAM_ID,
  funderStatePda, funderVaultAuthorityPda, campaignMarkerPda, swapStatePda, swapVaultAuthorityPda,
  funderIx, sendTx, expectFail,
} from "./common.js";

const DWELL_MINT = new PublicKey(process.env.DWELL_MINT);
const USDC_MINT = new PublicKey(process.env.USDC_MINT);
const conn = connection();
const treasury = loadKeypair(`${keysDir()}/treasury.json`);
const viewer = loadKeypair(`${keysDir()}/viewer.json`);
const distributor = loadKeypair(`${keysDir()}/rootSetter.json`);
const ata = (m, o) => getAssociatedTokenAddressSync(m, o, true);

// gas the attacker so the program check itself is what rejects
await sendTx(conn, [SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: viewer.publicKey, lamports: 10_000_000 })], treasury);

const c = crypto.randomBytes(32);
const err = await expectFail(conn, [new TransactionInstruction({
  programId: FUNDER_PROGRAM_ID,
  keys: [
    { pubkey: viewer.publicKey, isSigner: true, isWritable: true },
    { pubkey: funderStatePda(), isSigner: false, isWritable: true },
    { pubkey: campaignMarkerPda(c), isSigner: false, isWritable: true },
    { pubkey: funderVaultAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: ata(USDC_MINT, funderVaultAuthorityPda()), isSigner: false, isWritable: true },
    { pubkey: ata(DWELL_MINT, funderVaultAuthorityPda()), isSigner: false, isWritable: true },
    { pubkey: SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: swapStatePda(), isSigner: false, isWritable: false },
    { pubkey: swapVaultAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: ata(DWELL_MINT, swapVaultAuthorityPda()), isSigner: false, isWritable: true },
    { pubkey: ata(USDC_MINT, swapVaultAuthorityPda()), isSigner: false, isWritable: true },
    { pubkey: ata(DWELL_MINT, distributor.publicKey), isSigner: false, isWritable: true },
    { pubkey: ata(DWELL_MINT, treasury.publicKey), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: funderIx.swapAndFund(c, 1_000_000n, 1n),
})], viewer);
console.log("D2 redo — funded attacker rejected by program:", err.slice(0, 200));

// read funder_state accounting totals (borsh: skip bool+5 pubkeys+u16+bool -> 3 u64s at the end)
const info = await conn.getAccountInfo(funderStatePda());
const d = info.data;
const off = 1 + 32 * 6 + 2 + 1;
console.log("total_usdc_spent:          ", d.readBigUInt64LE(off).toString());
console.log("total_dwell_to_distributor:", d.readBigUInt64LE(off + 8).toString());
console.log("total_dwell_to_treasury:   ", d.readBigUInt64LE(off + 16).toString());
