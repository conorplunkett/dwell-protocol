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

## Devnet deploy (blocked on gas, see docs/08 status)

Unlike Base Sepolia's captcha-gated faucets, Solana devnet SOL is normally
self-serve (`solana airdrop`) — but this sandbox's shared egress IP has
already exhausted the daily devnet faucet quota on every public RPC tried
(`api.devnet.solana.com`, Helius, Ankr). Deploy is one command once an
address is funded:

```sh
solana program deploy target/deploy/mock_jupiter_swap.so --program-id target/deploy/mock_jupiter_swap-keypair.json --url devnet
solana program deploy target/deploy/dwell_funder.so --program-id target/deploy/dwell_funder-keypair.json --url devnet
```
