//! dwell-funder — TESTNET-ONLY Solana port of `CampaignFunder.sol` for the
//! devnet dry run (docs/08-testnet-dry-run.md analogue for the star.fun/
//! Solana venue, docs/07-starfun-launch.md). One market buy per campaign:
//! the queued USDC tranche is routed through an owner-set swap program
//! (`mock-jupiter-swap` here, a real Jupiter route in production), and the
//! DWELL received splits `treasury_bps` (default 30%) to the protocol
//! treasury and the remainder to the rewards distributor. Keeper-gated,
//! slippage-guarded via balance-delta measurement, pausable, one buy per
//! campaign_id.
//!
//! This is a dry-run harness, not an audited production program — see the
//! "established Solana Merkle-distributor program" note in
//! docs/06-launch-checklist.md for what the distributor leg should
//! ultimately be backed by.

pub mod entrypoint;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

solana_program::declare_id!("6M2Gnz9shBWWkPuSz6Ty6coDJkGPTJsAvRDVubsBbuqe");
