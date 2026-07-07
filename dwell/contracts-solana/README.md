# DWELL Solana devnet harness

Native Solana programs (no Anchor CLI — built directly with `cargo
build-sbf`, using `anchor-lang`-free `solana-program`) for the Base Sepolia
dry-run's Solana analogue: [`../docs/06-launch-checklist.md`](../docs/06-launch-checklist.md)'s
Phase 1 item 4 dry-run target, "Jupiter keeper + Solana Merkle distributor on
devnet."

## Layout

| Path | What it is |
|---|---|
| `programs/dwell-funder/` | Port of `../contracts/src/CampaignFunder.sol`. One market buy per campaign: pulls the queued USDC tranche, CPIs into an owner-set swap program, splits the DWELL received `treasury_bps` (default 30%) to the treasury and the rest to the rewards distributor. Keeper-gated, slippage-guarded via balance-delta measurement (not return data), pausable, one buy per `campaign_id` (its PDA marker's mere existence is the guard). |
| `programs/mock-jupiter-swap/` | TESTNET-ONLY stand-in for the real Jupiter-routed swap into the Meteora DWELL/USDC pool ([`../docs/07-starfun-launch.md`](../docs/07-starfun-launch.md)), which has no devnet liquidity or API access — the Solana analogue of the Base harness's `FixedRateSwapRouter.sol`. Pays DWELL from its own pre-funded vault at a fixed, authority-set rate. |

Still to build: a Merkle-distributor program (the doc calls for reusing an
established one rather than writing a custom one — e.g. Saber's
`merkle-distributor` — not yet vendored here), the keeper scripts (sweeper,
indexer, root publisher), and the actual devnet deploy + exercise run.

## Toolchain notes (read before touching Cargo.toml)

This was the hard part. `cargo-build-sbf`'s default platform-tools (v1.53)
download from `github.com/anza-xyz/platform-tools/releases` is blocked by
this sandbox's egress policy (same class of block as Foundry's installer).
The workaround: `backpackapp/build:v0.30.1`'s Docker image ships platform-tools
v1.41 pre-cached at `/root/.cache/solana/v1.41/platform-tools`; extract that
directory to the host's `~/.cache/solana/v1.41/` and pass
`--tools-version v1.41 --skip-tools-install` to every `cargo build-sbf`
invocation.

That toolchain's bundled `rustc`/`cargo` is 1.75.0 (Feb 2024) — well before
`edition2024` stabilized (~rustc 1.85). Crates.io's "latest compatible"
resolution for `solana-program`/`spl-token`'s transitive deps now routinely
picks versions that require it (`blake3`, `toml_datetime` via
`proc-macro-crate`→`toml_edit`, `hashbrown` via `indexmap`, `zeroize_derive`,
`jobserver`), which the old bundled cargo can't parse. **`solana-program` and
`spl-token` are pinned to exact old versions** (`=1.18.26` / `=4.0.3` — the
generation contemporary with platform-tools v1.41) to keep the graph shallow,
and `./pin-msrv-compat.sh` pins the remaining stragglers to their last
pre-edition2024 release. Run it after any `rm Cargo.lock` /
`cargo generate-lockfile`:

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
rm -f Cargo.lock && cargo generate-lockfile
./pin-msrv-compat.sh
```

Cargo.lock is also downgraded to format `version = 3` (the old bundled cargo
rejects the modern default `version = 4`) — the script does this too.

**Build each program separately**, not via `--workspace`: `dwell-funder`
depends on `mock-jupiter-swap` as a path dependency (to reuse its
`SwapInstruction` enum and PDA seed constants for the CPI, avoiding
hand-encoded instruction data) with `default-features = false` to skip its
`entrypoint` module — building both crates in one `cargo build-sbf`
invocation unifies their Cargo features and re-enables the entrypoint on
both, which fails to link (`#[global_allocator]` defined twice).

```sh
cargo build-sbf --manifest-path programs/mock-jupiter-swap/Cargo.toml --tools-version v1.41 --skip-tools-install
cargo build-sbf --manifest-path programs/dwell-funder/Cargo.toml --tools-version v1.41 --skip-tools-install
```

Compiled `.so` files land in `target/deploy/`; their keypairs there must
match each program's `declare_id!` (regenerate both together if you ever
need a fresh program address — `declare_id!` isn't runtime-enforced here
since PDA derivation always uses the runtime `program_id` parameter, but
keeping them in sync avoids confusion).

## Devnet run — executed 2026-07-07, funding path verified

Deployed and exercised on devnet (deploy needs `--use-rpc`: the CLI's
default TPU path opens a websocket whose TLS this sandbox's proxy CA
breaks; if a deploy dies mid-flight, reclaim the stranded rent with
`solana program close --buffers`):

| What | Address / tx |
|---|---|
| mock-jupiter-swap | `9YeYN5KMqFQTnu7RcqDnxQTpagvjFkSsiemzTmqBKnXH` |
| dwell-funder | `6M2Gnz9shBWWkPuSz6Ty6coDJkGPTJsAvRDVubsBbuqe` |
| DWELL mint (1B fixed, 9 dp, mint authority disabled) | `GBNEphoxbjw6i21oWkkneNegAY6kpHdbz5CLB7MT4sUb` |
| test USDC mint (6 dp) | `6Ygmcoroohphani7fybnpF4Q317mG7Ec17DFM8c7G2PL` |
| campaign 1 buy (`SwapAndFund`, 90 USDC tranche) | `2U5n3n3bLf8qekqk5cNzZ1LNJQtPLrh8jVM7HVoRJ8J8F4gdXB8PLV3Tx1vL8YmZaxRRfyTZEYAwckfLNwhSdWbD` |

Verified on-chain, all exact to the base unit: a $100-campaign's 90-USDC
tranche bought 1,080,000 DWELL at the configured rate, split 756,000 to the
distributor vault (70%) and 324,000 to the treasury (30%); `funder_state`
totals reconcile across both funded campaigns (91 USDC → 1,092,000 DWELL,
70/30). Failure drills all rejected in-program: campaign replay
(`AlreadyFunded`), funded non-keeper signer (`NotKeeper`, error 0x3),
slippage floor (`InsufficientOutput`), paused funding (`Paused`) with
un-pause restoring service.

The `client/` scripts run it end to end (websocket-free send/confirm):

```sh
cd client && npm install
export SOL_KEYS_DIR=...   # dir with treasury/keeper/rootSetter/viewer.json
export DWELL_MINT=... USDC_MINT=...
node setup.js             # vaults, init both programs, wire keeper + swap target
node fund-campaign.js     # the buy + the four failure drills
```

## Earnings run — executed 2026-07-07, the full user-earning + referral loop

merkle-distributor deployed at `DBfMVuq2WPrBS6aoXyJFRYppWntSC7qCHP2ApNBLCbFJ`
(one in-place upgrade during the run: the hand-rolled CPI transfer's PDA
authority meta needed `is_signer: true` — caught live by the first claim,
fixed, upgraded, re-run).

Epoch 1 (campaigns 1+2, cumulative tree, root
`4ws9ZHpT…pC5kH`): the four leaves close **exactly** against the 70% legs
the funder sent on-chain (764,400 DWELL, vault residual 0 after claims):

| Leaf | Amount (DWELL) | Claim tx |
|---|---|---|
| viewer (60% of c1) | 648,000 | `4LQGDbUhpzMhqqEG41em…` |
| referrer (10% of c1) | 108,000 | `qHL5HvGuRV5USGgs7Dkh…` |
| viewer2, unreferred (60% of c2) | 7,200 | `4a4zfgVn6sKaWtYFzFda…` — **gas-sponsored: the user wallet holds zero SOL** |
| treasury shortfall leaf (c2's unclaimed 10%) | 1,200 | `5nCmSxLzcFfEP4GL8vp4…` |

Epoch 2: campaign 3 funded on-chain (`Nyftf1FW…ZPVz`), vault funded with
the epoch delta only (standing rule), root 2 published, viewer claimed
**only the delta** (+64,800). Drills all rejected in-program: stale
epoch-1 proof after root 2, inflated amount, epoch skip 2→4, setRoot from
a non-root-setter key, claims while paused (with unpause restoring).
Final vault residual: 0 — every allocated base unit accounted for.
