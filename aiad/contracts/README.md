# AIAD contracts

Three contracts, standard Foundry layout, built on **unmodified OpenZeppelin
Contracts v5.6.1** pinned as a git submodule at `lib/openzeppelin-contracts`
(commit `5fd1781b1454fd1ef8e722282f86f9293cacf256`, tag `v5.6.1`). No OZ code
is copied, trimmed, or re-typed anywhere in `src/` — every audited primitive
ships byte-for-byte as published; the only original code is the AIAD-specific
logic wired around the imports. Tests run against the real imported code
paths via `forge-std` (pinned at `v1.16.2`).

| Contract | Purpose |
|---|---|
| `src/AIAD.sol` | Fixed-supply ERC-20 (1B, 18 dec) + EIP-2612 permit + burn. Minted once to the treasury Safe; no mint function, no owner, no hooks. |
| `src/CampaignFunder.sol` | One market buy per paid campaign: USDC in → 0x-routed swap → 65% of AIAD to the Distributor, 35% to the treasury (`burnBps` slice optionally burned, default 0). Keeper-gated, slippage-guarded, pausable; `rescue()` blocklists USDC/AIAD. `CampaignFunded` events are the locked-rate source of truth. |
| `src/MerkleRewardsDistributor.sol` | Cumulative `(address, cumulativeAmount)` Merkle claims. Roots advance one epoch at a time via a dedicated `rootSetter`; claims pay the delta since the last claim; pausable by the owner Safe, which can never move funds. |

See [`../docs/02-architecture.md`](../docs/02-architecture.md) for how these
fit the full system, and [`../docs/01-tokenomics.md`](../docs/01-tokenomics.md)
for the 50/15/35 economics they implement. The unreferred-viewer case (protocol
50% instead of 35%) settles offchain: the surplus stays in the Distributor and
the backend adds a treasury leaf to the Merkle root for the shortfall.

## Build and test

Requires [Foundry](https://getfoundry.sh). After cloning:

```sh
git submodule update --init --recursive   # pinned OZ v5.6.1 + forge-std v1.16.2
cd aiad/contracts
forge build
forge test -vv
```

Compiler is pinned to `solc 0.8.26` in `foundry.toml` (optimizer on, 200 runs).
No Solidity toolchain exists in the sandbox this code was authored in, so
**compilation and tests have not been machine-verified here** — run
`forge build && forge test` before any deployment and treat a clean run as a
merge gate (see `../docs/06-launch-checklist.md`).

## Deploy

Dependency order: `AIAD` → `MerkleRewardsDistributor` → `CampaignFunder`.

```sh
export TREASURY_SAFE=0x...   # issuer multisig — receives supply, owns everything
export ROOT_SETTER=0x...     # backend key: publishes Merkle roots
export KEEPER=0x...          # backend key: calls swapAndFund
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # Base mainnet USDC
export SWAP_TARGET=0x...     # 0x AllowanceHolder / Exchange Proxy on Base
forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
```

Post-deploy, from the Safe: `funder.setSwapTarget(...)`, `funder.setKeeper(...,
true)`. Fund the Distributor per-epoch (not in bulk) so a compromised root
setter's blast radius is capped at the current balance.

## Security model in one paragraph

The token has no privileged surface at all. The Funder's arbitrary-calldata
swap is constrained by keeper allowlist + owner-set target + exact approvals
reset to zero + balance-delta `minAiadOut` enforcement + a cap on USDC spent,
and the contract only ever holds tranches queued for funding. The Distributor
uses double-hashed leaves (OZ guidance), cumulative amounts (stale proofs can
never double-pay), checks-effects-interactions, sequential epochs, and a
root-setter key that is distinct from — and rotatable by — the owner Safe.
Audit before mainnet; the launch checklist treats that as a hard gate.
