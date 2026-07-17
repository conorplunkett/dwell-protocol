# Robinhood Chain launch contracts

> Part of the exploratory plan in [`../README.md`](../README.md) — not the
> live design, and gated on the decisions listed there.

Standard Foundry layout. OpenZeppelin v5.6.1 and forge-std v1.16.2 are
**reused from the pinned submodules** at `../../dwell/contracts/lib` (see
`foundry.toml` / `remappings.txt`) — no second vendored copy. As in the
reference tree, no OZ code is copied or modified; the only original code is
what's wired around the imports.

| Contract | Purpose |
|---|---|
| `src/DWELL.sol` | Byte-for-byte copy of the CI-verified reference token: fixed-supply ERC-20 (1B, 18 dec) + permit + burn, minted once to the treasury Safe. No mint, no owner, no hooks. |
| `src/SeasonMerkleDistributor.sol` | Seasonal airdrop claims. One season open at a time; double-hashed `(seasonId, account, amount)` Merkle leaves; 3-month claim deadline enforced on-chain; after the deadline anyone can `closeSeason` and the unclaimed remainder rolls into the next season's pool. Owner (Safe) can pause and rotate the root setter but cannot touch an open season's pool. |
| `src/CliffVestingWallet.sol` | Concrete OZ `VestingWalletCliff` (constructor only). Team policy: 12-month cliff, 36-month duration, start = TGE. |
| `script/Deploy.s.sol` | Token → distributor → vesting wallet, with the post-deploy Safe transfers logged as a checklist. |

## Build and test

```sh
git submodule update --init --recursive   # pinned OZ v5.6.1 + forge-std v1.16.2
cd robinhood/contracts
forge build
forge test -vv
```

**Verification status:** compiled clean with solc 0.8.26 (optimizer, cancun —
the same pins as `foundry.toml`) via solc-js on 2026-07-17. `forge test` has
**not** been run yet — the authoring environment could not fetch the Foundry
toolchain — so `test/SeasonMerkleDistributor.t.sol` is written but
unverified. Run the suite (and wire a `robinhood-contracts` CI job mirroring
`dwell-contracts`) before treating any of this as validated, and audit before
mainnet — the launch plan treats that as a hard gate.

## Security model in one paragraph

The token has no privileged surface. The distributor's root setter can only
open the *next* season, only after the previous one closed, and only up to
the funding actually present — per-season funding caps a compromised root
setter's blast radius at one season's pool. The owner Safe can pause claims
and rotate the setter but can never move an open season's funds; the only
owner escape hatch (`sweepCarryover`) works exclusively between seasons, for
program wind-down. Claims use double-hashed leaves keyed by season id (a
proof from one season can never replay against another), checks-effects-
interactions, and third-party claim execution that can only ever pay the
entitled account. A bad root needs no admin override: pause, let the window
lapse, close, correct in the next root.
