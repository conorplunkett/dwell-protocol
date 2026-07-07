// Cumulative-claims Merkle tree, byte-compatible with the convention the
// on-chain program verifies (and with OZ StandardMerkleTree, so the same
// builder can drive the EVM MerkleRewardsDistributor):
//   leaf  = keccak256(keccak256(wallet_bytes32 ‖ uint256_be(cumulative)))
//   node  = keccak256(sorted(a, b))
// Wallet here is a Solana pubkey's raw 32 bytes (on EVM it'd be the
// abi-encoded address — same 32-byte slot).

import { keccak_256 } from "@noble/hashes/sha3.js";

function leafHash(walletPubkey, cumulativeAmount) {
  const amt = Buffer.alloc(32);
  amt.writeBigUInt64BE(BigInt(cumulativeAmount), 24);
  const inner = keccak_256(Buffer.concat([walletPubkey.toBuffer(), amt]));
  return Buffer.from(keccak_256(inner));
}

function pairHash(a, b) {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak_256(Buffer.concat([lo, hi])));
}

/**
 * entries: [{ wallet: PublicKey, cumulative: bigint }]
 * returns { root: Buffer, proofFor(wallet): Buffer[] }
 */
export function buildTree(entries) {
  const leaves = entries.map((e) => ({ ...e, hash: leafHash(e.wallet, e.cumulative) }));
  // deterministic layer 0 (sorted by hash, like StandardMerkleTree)
  leaves.sort((a, b) => Buffer.compare(a.hash, b.hash));

  const layers = [leaves.map((l) => l.hash)];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? pairHash(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }

  return {
    root: layers[layers.length - 1][0],
    proofFor(wallet) {
      let idx = leaves.findIndex((l) => l.wallet.equals(wallet));
      if (idx < 0) throw new Error(`wallet not in tree: ${wallet.toBase58()}`);
      const proof = [];
      for (let d = 0; d < layers.length - 1; d++) {
        const layer = layers[d];
        const sib = idx ^ 1;
        if (sib < layer.length) proof.push(layer[sib]);
        idx = Math.floor(idx / 2);
      }
      return proof;
    },
    entryFor(wallet) {
      return entries.find((e) => e.wallet.equals(wallet));
    },
  };
}
