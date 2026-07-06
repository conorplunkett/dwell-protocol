# AIAD

**Get paid for your attention.** AIAD shows one sponsored line while an AI
assistant is thinking, and pays the person watching. Earnings accrue as
**AIAD points** today and convert to the **AIAD token** at launch.

The mechanics, stated as facts (see the copy rules in
[docs/05-legal-structure.md](docs/05-legal-structure.md)): advertisers pay
fixed dollar CPMs by card; **90% of every ad dollar** goes to the token side —
escrowed in a USDC reserve during the points phase, market-bought into AIAD
after launch — and each campaign's pool splits **50% to the viewer, 15% to
their referrer, 35% to the protocol treasury**. Users are only ever paid what
revenue already bought: no minting, no emissions schedule, no oracle.

This folder is fully self-contained (no code dependencies on anything outside
it) and is structured to be lifted into its own repository unchanged.

## Layout

| Path | What it is |
|---|---|
| [`docs/`](docs/) | The design: tokenomics, architecture, providers, backend spec, legal, launch checklist |
| [`contracts/`](contracts/) | Solidity (Foundry + pinned OpenZeppelin v5.6.1): the AIAD token, CampaignFunder, MerkleRewardsDistributor |
| [`web/`](web/) | The site: landing page + user portal. Static HTML/CSS/vanilla JS, no build step, black/green design system in `web/theme.css` |

## Docs index

1. [Tokenomics](docs/01-tokenomics.md) — the 50/15/35 split, campaign-locked
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
   Base path

## View the site

```sh
python3 -m http.server -d web 8080
# http://localhost:8080          — landing
# http://localhost:8080/portal   — portal (append ?dev=1 for mock data)
```

Deploys as its own Vercel project with Root Directory = `web` (or `aiad/web`
while this folder lives inside its parent repo).

## Build the contracts

```sh
git submodule update --init --recursive
cd contracts && forge build && forge test
```

See [contracts/README.md](contracts/README.md) — including the honest note
that this code was authored in a sandbox with no Solidity toolchain, so a
green `forge test` is a merge gate, not an already-banked result.

## Status

Pre-launch design + prototype. The site is a preview (mock data behind
`?dev=1`); the contracts are unaudited; the points phase can launch without
any of the crypto stack (see the
[launch checklist](docs/06-launch-checklist.md)). Nothing here is investment
advice, and nothing here promises anything about any token's price.
