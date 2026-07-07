# Dwell Protocol

**Get paid for your attention.** DWELL shows one sponsored line while an AI
assistant is thinking and pays the person watching — in **dwells**
(1,000 dwells = $1.00 of earned ad value), redeemable for **$DWELL at token
launch**, **Claude gift cards**, or **cash via Stripe** (10% protocol fee on
gift cards and cash).

**The product lives in [`dwell/`](dwell/)** — site, docs, contracts, backend,
and the earning clients (Chrome extension, terminal, macOS desktop). Start
with [`dwell/README.md`](dwell/README.md) and [`dwell/AGENTS.md`](dwell/AGENTS.md).

- Site: [dwellprotocol.com](https://www.dwellprotocol.com) · portal at
  [/portal](https://www.dwellprotocol.com/portal) · install guides at
  [/products](https://www.dwellprotocol.com/products)
- Terminal client: `npm install -g @dwell-protocol/terminal`
- CI: `.github/workflows/dwell-ci.yml` · edge-function deploys:
  `.github/workflows/deploy-dwell-functions.yml`

## Formerly freeai.fyi

This repo used to ship FreeAI.fyi, the dollar-denominated predecessor. That
product is frozen verbatim in [`archive/freeai.fyi/`](archive/freeai.fyi/) —
kept so the old site can stay up for existing users, never developed further.
Its `api` Supabase Edge Function remains deployed but no longer auto-deploys
from this repo.
