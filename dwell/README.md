# Dwell Protocol

**Get paid for your attention.** DWELL shows one sponsored line while an AI
assistant is thinking, and pays the person watching. Earnings accrue as
**DWELL points** today and convert to the **$DWELL token** at launch.
Canonical domain: **[dwellprotocol.com](https://dwellprotocol.com)**.

The mechanics, stated as facts (see the copy rules in
[docs/05-legal-structure.md](docs/05-legal-structure.md) and the framework in
[docs/08-securities-framework.md](docs/08-securities-framework.md)):
advertisers pay fixed dollar CPMs by card; the token-side tranche of each
campaign (currently ~90% — configuration, not a commitment) is earmarked on
the protocol ledger during the points phase and, after launch, converted into
$DWELL at market to settle what that campaign's earners are owed. Each
campaign's pool splits **60% to the viewer, 10% to their referrer, and 30% to
the protocol treasury (reserve, held)** — the referrer leg joins the treasury
when a viewer has no referrer. Users are only ever paid what revenue already
bought: no minting, no emissions schedule, no oracle. The token confers
**zero equity rights** (Bedrock framework). Launch venue: **star.fun ×
Bedrock (Solana)** — see
[docs/07-starfun-launch.md](docs/07-starfun-launch.md); the Base/EVM contracts
in `contracts/` are the CI-verified reference implementation and fallback.

## Layout

| Path | What it is |
|---|---|
| [`web/`](web/) | Landing page + portal. Static HTML/CSS/vanilla JS, no build step. **`web/theme.css` is the central theme file** ([docs/brand.md](docs/brand.md)) |
| [`docs/`](docs/) | Tokenomics, architecture, providers, backend spec, legal, launch checklist, star.fun assessment, brand |
| [`contracts/`](contracts/) | Solidity (Foundry + pinned OpenZeppelin v5.6.1): the DWELL token, CampaignFunder, MerkleRewardsDistributor |
| [`server/`](server/) | Reference Node + Postgres backend (CI-tested) |
| [`supabase/functions/dwell-api/`](supabase/functions/) | Production edge function — a verbatim mirror of `server/` |
| [`chrome-extension/`](chrome-extension/) · [`terminal/`](terminal/) · [`desktop/`](desktop/) | The earning clients |

## Run it

```sh
# site
python3 -m http.server -d web 8080     # / — landing · /portal.html — portal (?dev=1 for mock data)

# backend (needs Postgres; see server/README)
cd server && npm install && npm test

# contracts
git submodule update --init --recursive
cd contracts && forge build && forge test
```

The production API deploys as a Supabase Edge Function (slug `dwell-api`),
runs `TOKEN_MODE=points` by default, and keeps all DWELL data in its own
Postgres schema (`DB_SCHEMA=dwell`) — top-level isolation inside a shared
database server.

## Status

Points-phase deployment. The site is live at
[dwellprotocol.com](https://dwellprotocol.com) (Vercel, root directory
`dwell/web`); the API is the `dwell-api` Supabase Edge Function, deployed by
`.github/workflows/deploy-dwell-functions.yml` at the repo root — note that
**all CI for this tree runs from the root `.github/workflows/dwell-ci.yml`**.
The contracts are machine-verified (forge 1.7.1 / solc 0.8.26, 25/25) but
unaudited; advertiser checkout is disabled until Stripe keys exist. Nothing
here is investment advice, and nothing here promises anything about any
token's price.
