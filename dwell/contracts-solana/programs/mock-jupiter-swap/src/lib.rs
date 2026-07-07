//! mock-jupiter-swap — TESTNET-ONLY swap target for the Solana devnet dry run.
//!
//! Stands in for the real Jupiter-routed swap into the Meteora AIAD/DWELL
//! pool (docs/07-starfun-launch.md), which has no devnet liquidity or API
//! access. Pays out DWELL from its own pre-funded vault at a fixed,
//! authority-set rate — the Solana analogue of the Base-Sepolia
//! `FixedRateSwapRouter.sol` harness. Exists purely so `dwell-funder`'s
//! balance-delta accounting and slippage guard can be exercised end to end;
//! it is not, and must never become, part of the production path.

#[cfg(feature = "entrypoint")]
pub mod entrypoint;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

solana_program::declare_id!("9YeYN5KMqFQTnu7RcqDnxQTpagvjFkSsiemzTmqBKnXH");
