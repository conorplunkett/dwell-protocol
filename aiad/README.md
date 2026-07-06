# AIAD

**Get paid for your attention.** AIAD shows one sponsored line while an AI
assistant is thinking, and pays the person watching. Earnings accrue as
**AIAD points** today and convert to the **AIAD token** at launch.

The mechanics, stated as facts (see the copy rules in
[docs/05-legal-structure.md](docs/05-legal-structure.md)): advertisers pay
fixed dollar CPMs by card; **90% of every ad dollar** goes to the token side —
escrowed in a USDC reserve during the points phase, market-bought into AIAD
after launch — and each campaign's pool splits **60% to the viewer, 10% to their referrer, and
30% to the protocol treasury — which holds, never sells** (the referrer leg
joins the treasury when a viewer has no referrer). Users are only ever paid what
revenue already bought: no minting, no emissions schedule, no oracle.

This folder holds AIAD's **brand layer** — site theme + copy, contracts, and
docs. Plan of record: AIAD and FreeAI are **separate businesses at runtime**
(separate databases, ad inventory, money accounts, domains, admin keys; zero
connections between the two sites) built on the **same underlying pieces** —
one codebase, brand-parameterized, deployed twice, with identical UI elements
and identical ad serving; only theme tokens and copy differ. See the
Separation section of
[docs/06-launch-checklist.md](docs/06-launch-checklist.md).

## Layout

| Path | What it is |
|---|---|
| [`docs/`](docs/) | The design: tokenomics, architecture, providers, backend spec, legal, launch checklist |
| [`contracts/`](contracts/) | Solidity (Foundry + pinned OpenZeppelin v5.6.1): the AIAD token, CampaignFunder, MerkleRewardsDistributor |
| [`web/`](web/) | The site: landing page + user portal. Static HTML/CSS/vanilla JS, no build step, black/green design system in `web/theme.css` |

## Docs index

1. [Tokenomics](docs/01-tokenomics.md) — the 60/10/30 split, campaign-locked
   rates, points→token conversion, supply math, business P&L
2. [Architecture](docs/02-architecture.md) — points mode vs. live mode, key
   custody, failure modes
3. [Service providers](docs/03-service-providers.md) — Base, Coinbase, 0x,
   Aerodrome, Privy, Zero Hash/MoonPay, with fallbacks
4. [Backend adaptation](docs/04-backend-adaptation.md) — internal engineering
   spec mapping AIAD onto the existing ad-serving backend
5. [Legal & structure](docs/05-legal-structure.md) — entity plan, the four
   hard rules, copy rules, tax ops
6. [Launch checklist](docs/06-launch-checklist.md) — points launch, TGE gates,
   the ordered runbook
7. [star.fun launch](docs/07-starfun-launch.md) — assessment + adaptation for
   launching on the star.fun launchpad (Solana) instead of the self-directed
   Base path, including the points→token conversion bridge

## View the site

```sh
python3 -m http.server -d web 8080
# http://localhost:8080          — landing
# http://localhost:8080/portal   — portal (append ?dev=1 for mock data)
```

Deploys as its own Vercel project with Root Directory = `web` (or `aiad/web`
while this folder lives inside its parent repo).

## Contracts

Three contracts in `contracts/src/`, standard Foundry layout, built on
**unmodified OpenZeppelin Contracts v5.6.1** pinned as a git submodule at
`contracts/lib/openzeppelin-contracts` (commit
`5fd1781b1454fd1ef8e722282f86f9293cacf256`, tag `v5.6.1`). No OZ code is
copied, trimmed, or re-typed — every audited primitive ships byte-for-byte as
published; the only original code is the AIAD-specific logic wired around the
imports. Tests run against the real imported code paths via `forge-std`
(pinned at `v1.16.2`).

| Contract | Purpose |
|---|---|
| `AIAD.sol` | Fixed-supply ERC-20 (1B, 18 dec) + EIP-2612 permit + burn. Minted once to the treasury Safe; no mint function, no owner, no hooks. |
| `CampaignFunder.sol` | One market buy per paid campaign: USDC in → 0x-routed swap → 70% of AIAD to the Distributor, 30% to the treasury (held; `burnBps` slice optionally burned, default 0). Keeper-gated, slippage-guarded, pausable; `rescue()` blocklists USDC/AIAD. `CampaignFunded` events are the locked-rate source of truth. |
| `MerkleRewardsDistributor.sol` | Cumulative `(address, cumulativeAmount)` Merkle claims. Roots advance one epoch at a time via a dedicated `rootSetter`; claims pay the delta since the last claim; pausable by the owner Safe, which can never move funds. |

See [docs/02-architecture.md](docs/02-architecture.md) for how these fit the
full system and [docs/01-tokenomics.md](docs/01-tokenomics.md) for the
60/10/30 economics they implement. The unreferred-viewer case (protocol 40%
instead of 30%) settles offchain: the surplus stays in the Distributor and
the backend adds a treasury leaf to the Merkle root for the shortfall.

**Build and test** — requires [Foundry](https://getfoundry.sh):

```sh
git submodule update --init --recursive   # pinned OZ v5.6.1 + forge-std v1.16.2
cd contracts && forge build && forge test -vv
```

Compiler is pinned to `solc 0.8.26` in `foundry.toml` (optimizer on, 200
runs). Machine-verified 2026-07-06 on forge `1.7.1` / solc `0.8.26` —
`forge build` clean, `forge test` 25/25 passing. The `aiad-contracts` CI job
(`.github/workflows/ci.yml`) runs both on every push/PR on the same pinned
toolchain, keeping the merge gate enforced (see
[docs/06-launch-checklist.md](docs/06-launch-checklist.md)).

**Deploy** — dependency order: `AIAD` → `MerkleRewardsDistributor` →
`CampaignFunder`:

```sh
export TREASURY_SAFE=0x...   # issuer multisig — receives supply, owns everything
export ROOT_SETTER=0x...     # backend key: publishes Merkle roots
export KEEPER=0x...          # backend key: calls swapAndFund
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # Base mainnet USDC
export SWAP_TARGET=0x...     # 0x AllowanceHolder / Exchange Proxy on Base
cd contracts && forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
```

Post-deploy, from the Safe: `funder.setSwapTarget(...)`, `funder.setKeeper(...,
true)`. Fund the Distributor per-epoch (not in bulk) so a compromised root
setter's blast radius is capped at the current balance.

**Security model in one paragraph**: the token has no privileged surface at
all. The Funder's arbitrary-calldata swap is constrained by keeper allowlist +
owner-set target + exact approvals reset to zero + balance-delta
`minAiadOut` enforcement + a cap on USDC spent, and the contract only ever
holds tranches queued for funding. The Distributor uses double-hashed leaves
(OZ guidance), cumulative amounts (stale proofs can never double-pay),
checks-effects-interactions, sequential epochs, and a root-setter key that is
distinct from — and rotatable by — the owner Safe. Audit before mainnet; the
launch checklist treats that as a hard gate.

> **Venue note:** these contracts implement the self-directed **Base/EVM**
> launch path. If the token launches on star.fun (Solana), the token is an SPL
> mint created by the platform and this folder becomes the reference
> implementation of the mechanics — the Solana equivalents are an offchain
> Jupiter-API buy keeper and an established Solana Merkle-distributor program.
> See [docs/07-starfun-launch.md](docs/07-starfun-launch.md).

## Status

Pre-launch design + prototype. The site is a preview (mock data behind
`?dev=1`); the contracts are unaudited despite being machine-verified; the
points phase can launch without any of the crypto stack (see the
[launch checklist](docs/06-launch-checklist.md)). Nothing here is investment
advice, and nothing here promises anything about any token's price.
