//! merkle-distributor — Solana port of `MerkleRewardsDistributor.sol` for
//! the devnet dry run. Cumulative `(wallet, cumulativeAmount)` Merkle
//! claims: roots advance one epoch at a time via a dedicated `root_setter`;
//! each claim pays `cumulative − already_claimed`, so stale proofs can
//! never double-pay and a missed epoch self-heals at the next root.
//! Pausable by the owner, which can never move funds. Leaves are
//! double-keccak-hashed and proof pairs sorted — byte-compatible with the
//! OpenZeppelin `StandardMerkleTree` convention the EVM reference tests,
//! so the same tree-builder drives both venues.
//!
//! Production note (docs/06-launch-checklist.md): the checklist calls for
//! an *established* distributor program at TGE (e.g. Jito's). This port
//! exists so the dry run exercises the exact mechanics of the audited EVM
//! reference; treat it as the harness, not the shipping artifact.

#[cfg(feature = "entrypoint")]
pub mod entrypoint;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

solana_program::declare_id!("DBfMVuq2WPrBS6aoXyJFRYppWntSC7qCHP2ApNBLCbFJ");
