// Shared plumbing for the devnet dry-run client scripts.
//
// Deliberately websocket-free: transactions are sent over plain RPC and
// confirmed by polling getSignatureStatuses, because this sandbox's egress
// proxy re-terminates TLS and the CLI/web3.js pubsub (wss) clients reject
// its CA. Everything here works over HTTPS only.

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const FUNDER_PROGRAM_ID = new PublicKey("6M2Gnz9shBWWkPuSz6Ty6coDJkGPTJsAvRDVubsBbuqe");
export const SWAP_PROGRAM_ID = new PublicKey("9YeYN5KMqFQTnu7RcqDnxQTpagvjFkSsiemzTmqBKnXH");

export function connection() {
  return new Connection(RPC_URL, { commitment: "confirmed" });
}

export function loadKeypair(path) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

export function keysDir() {
  const dir = process.env.SOL_KEYS_DIR;
  if (!dir) throw new Error("SOL_KEYS_DIR env var required (directory holding role keypair JSONs)");
  return dir;
}

// --- PDAs (must mirror the seed constants in the two programs) ---

export function funderStatePda() {
  return PublicKey.findProgramAddressSync([Buffer.from("funder_state")], FUNDER_PROGRAM_ID)[0];
}
export function funderVaultAuthorityPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], FUNDER_PROGRAM_ID)[0];
}
export function campaignMarkerPda(campaignId32) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), campaignId32],
    FUNDER_PROGRAM_ID,
  )[0];
}
export function swapStatePda() {
  return PublicKey.findProgramAddressSync([Buffer.from("swap_state")], SWAP_PROGRAM_ID)[0];
}
export function swapVaultAuthorityPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], SWAP_PROGRAM_ID)[0];
}

// --- borsh instruction encoding (mirrors the two programs' enums) ---

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export const funderIx = {
  initialize: (treasuryBps) => Buffer.concat([Buffer.from([0]), u16le(treasuryBps)]),
  setKeeper: (pubkey) => Buffer.concat([Buffer.from([1]), pubkey.toBuffer()]),
  setShares: (treasuryBps) => Buffer.concat([Buffer.from([2]), u16le(treasuryBps)]),
  setSwapProgram: (pubkey) => Buffer.concat([Buffer.from([3]), pubkey.toBuffer()]),
  pause: () => Buffer.from([4]),
  unpause: () => Buffer.from([5]),
  swapAndFund: (campaignId32, usdcAmount, minDwellOut) =>
    Buffer.concat([Buffer.from([6]), campaignId32, u64le(usdcAmount), u64le(minDwellOut)]),
};

export const swapIx = {
  initialize: (rate) => Buffer.concat([Buffer.from([0]), u64le(rate)]),
  setRate: (rate) => Buffer.concat([Buffer.from([1]), u64le(rate)]),
  swap: (usdcIn) => Buffer.concat([Buffer.from([2]), u64le(usdcIn)]),
};

// --- websocket-free send + confirm ---

export async function sendTx(conn, instructions, payer, signers = []) {
  const tx = new Transaction();
  tx.add(...instructions);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    const height = await conn.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) throw new Error(`tx ${sig} expired unconfirmed`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${sig} not confirmed after 60s`);
}

// Run a tx we EXPECT to fail; returns the error string (throws if it succeeds).
export async function expectFail(conn, instructions, payer, signers = []) {
  try {
    const sig = await sendTx(conn, instructions, payer, signers);
    throw new Error(`expected failure but tx succeeded: ${sig}`);
  } catch (e) {
    if (String(e.message).startsWith("expected failure")) throw e;
    return String(e.message);
  }
}
