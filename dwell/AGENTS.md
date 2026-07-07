# AGENTS.md

> **Agents must always read the instructions below before working on this repo.**

Conventions for agents and contributors working in the DWELL protocol repo.

## Git workflow

**Always open a pull request and let it merge — never push a commit directly
to `main`.** Land your work on a branch, open a PR, and wait for it to be
merged (by review or by the user) before treating the change as shipped.

## What DWELL is

DWELL shows **one sponsored line** while an AI assistant (ChatGPT, Claude,
Gemini) is thinking, and **pays the person watching**. Earnings accrue as
**DWELL points** (1,000 points = $1.00 of earned ad value) and convert to the
**$DWELL token** at launch (venue: star.fun, Solana — see
`docs/07-starfun-launch.md`). Advertisers pay fixed dollar CPMs by card;
**90% of every ad dollar** goes to the earn side, splitting
**60% viewer / 10% referrer / 30% protocol treasury (held, never sold)**.
Canonical domain: **dwellprotocol.com**.

State mechanics as facts. No price talk, ever — the banned-language grep in CI
(`moon|price will|appreciat|going up|invest` over `dwell/web`) enforces the
copy rules in `docs/05-legal-structure.md`. **Never claim points are "backed"
or "escrowed" until the USDC reserve actually exists** — say points are
recorded on the ledger / earmarked, not guaranteed. CI for this tree runs from
the **root** `.github/workflows/dwell-ci.yml`; `dwell/` must stay free of any
reference to the frozen root product's brand (CI greps for it).

## Layout

| Path | What it is |
|---|---|
| `web/` | Landing page + portal. Static HTML/CSS/vanilla JS, no build step |
| `docs/` | Tokenomics, architecture, providers, backend spec, legal, launch checklist, star.fun, brand |
| `contracts/` | Foundry: the DWELL token, CampaignFunder, MerkleRewardsDistributor (Base/EVM reference; Solana is the launch path) |
| `server/` | Reference Node backend (tested in CI) |
| `supabase/functions/dwell-api/` | Production edge function — mirrors `server/` route-for-route, SQL verbatim |
| `chrome-extension/`, `terminal/`, `desktop/` | The earning clients |
| `tools/` | Icon/OG generators (read the theme file directly) |

## Backend rules

- **Every backend change lands in both** `server/src` and
  `supabase/functions/dwell-api/index.ts` **in the same commit**, with
  `server/db/schema.sql` the schema authority.
- This deployment runs **`TOKEN_MODE=points` by default** (the DWELL points
  phase). Money lives in an append-only millicent ledger; balances are always
  `SUM(ledger)`, never stored. The three-way split writes
  `points_credit` / `referral_points_credit` / `protocol_points_credit` plus a
  `platform_fee` row so every impression's rows sum to exactly its gross.
- **Shared-database isolation**: DWELL lives in its own Postgres schema
  (`DB_SCHEMA`, default `dwell`) so it can share a database server with other
  products while staying isolated at the top level. Every connection pins
  `search_path`; the edge function additionally pins it
  transaction-locally (see the pool wrapper in `index.ts`). Never write a
  schema-qualified table name in queries — the search_path is the isolation.
- Tests: `cd server && npm test` (real Postgres via `DATABASE_URL`);
  extension `cd chrome-extension && npm test`; terminal `cd terminal && npm test`;
  contracts `cd contracts && forge test`.

## Design system — "Kinetic Broadcast"

**`web/theme.css` is the CENTRAL THEME FILE — the single source of truth for
every color, font, radius, shadow, and layout constant.** The brand spec
behind it is `docs/brand.md`: high-energy content-first light mode — vibrant
red (#FF0000) on pure white, near-black ink, broadcast-blue links, Sora type,
1px-border depth instead of shadows, vaguely-YouTube on purpose.

1. **Hard rule — never hardcode a color or font.** Add or reuse a token in
   `theme.css`, then reference it (`var(--accent)`, `var(--ov-line)`,
   `var(--mono)`). The only exception is per-sponsor brand colors carried as
   ad inventory (content, not design tokens).

2. **The mirrors must move together.** These surfaces can't read `theme.css`
   at runtime and mirror it by hand — when a token changes, update all of
   them **in the same commit**:

   | Surface | How it consumes tokens |
   | --- | --- |
   | Landing page + portal | link `theme.css` directly → `var(--…)` |
   | Extension popup | `chrome-extension/popup/theme.css` — **byte-identical copy** (`cp web/theme.css chrome-extension/popup/theme.css`) |
   | Injected sponsor bar | `chrome-extension/src/inject.css` — re-declares the `--ov-*` + font tokens on `.bb-bar` |
   | macOS overlay | `OverlayPanel.swift` `Palette` enum — each member tagged with its `--ov-*` token name |
   | macOS onboarding | `desktop/…/Resources/onboarding/tokens.css` |
   | Favicon | `web/assets/favicon.svg` — the one sanctioned color duplication (SVG favicons can't read CSS variables) |

3. **Logo.** The brand mark is the white **"D$"** on the red gradient
   (`--accent-grad-a/b`). Regenerate every icon with `make icons`
   (`tools/gen-icons.py` reads the gradient straight from `theme.css`). Never
   hand-edit icon PNGs.

4. **Overlay stays dark.** The sponsor pill floats over third-party pages, so
   the `--ov-*` palette is a dark bar with red tag tints even though the site
   is light. That's intentional.

## Voice & copy

The product is **one sponsored line** shown while an assistant is thinking.
Never hedge it with a diminutive ("subtle", "tiny"). "While the AI thinks /
is thinking" is fine — that wait is the moment the product owns. Points copy
always carries the legend: **1,000 points = $1.00 of earned ad value**.
