# Launch checklist

Two launches: **points** (soon, cheap, reversible) and **TGE** (later,
expensive, one-way). Each item is a gate — nothing below it starts until it's
done.

> **Venue decision (2026-07-06): star.fun.** The raise **is** the TGE — see
> [07-starfun-launch.md](07-starfun-launch.md). The points phase shrinks to
> the window between first ad revenue and graduation; Phase-2 items 5–7
> (deploy, liquidity seed, reserve conversion) are replaced by the raise +
> graduation, and item 3's dry-run targets the Solana stack (Jupiter keeper +
> Solana Merkle distributor on devnet). Everything legal (counsel, geofences,
> W-9 pipeline) moves **before the raise**. The Base/EVM path (docs 02–03,
> `../contracts/`) remains the documented and CI-verified fallback.

**Decision record (2026-07-06): parallel brands on shared pieces.** DWELL and
DWELL are **separate businesses at runtime** — separate ad inventory,
databases, domains, money accounts, and operator tooling; zero connections
between the sites in either direction. But the code is **not forked**: both
brands run the same underlying pieces. The UI elements and the ad-serving
machinery (backend, extension, terminal, macOS) are identical and
brand-parameterized — only the theme tokens and (slightly) the copy differ.
One codebase, two deployments. (This supersedes two same-day notes —
rebrand-in-place, then fork-and-diverge — that briefly stood here.)

**Decision record (2026-07-07): full rebrand — the legacy brand is frozen.**
The prior product will never be used again; its tree stays at the repo root
as a frozen reference (site, clients, and edge function keep running until
retired) and **all development happens in `dwell/`**. Accepted interim
deviations from the Separation list below, to launch now: (1) **shared
Supabase project** — the `dwell-api` function and the `dwell` Postgres schema
live in the legacy project (`DB_SCHEMA=dwell` isolation); migrate to an own
project/org later, before scale. (2) **Email still sends from the legacy
Resend account/domain** (env-level `MAIL_FROM`), until DWELL's own sending
domain is verified. (3) The **existing Chrome Web Store listing is rebranded
in place** (v0.7.0) instead of a new listing. Canonical domain:
**dwellprotocol.com** (owned, live on the `dwell-protocol` Vercel project).

## Separation — two businesses, zero runtime connections

Everything DWELL runs is its own **instance**: no shared data, keys, accounts,
or domains. The **code** is shared by design (decision record above) — one
implementation, deployed twice; a fix or UI change lands once and ships to
both brands.

- [ ] **One codebase, two deployments** (this repo): the backend and the
      three clients gain a small brand/config layer instead of forks —
      `dwell/` holds only the brand layer (site theme + copy, contracts,
      docs). Each deployment gets its own secrets store; CI runs both
      brands' checks (it already runs the DWELL contracts, copy-rule, and
      cross-brand greps).
- [ ] **Own legal + money stack**: DWELL entity per
      [05-legal-structure.md](05-legal-structure.md); own bank account; own
      **Stripe account** (advertisers pay DWELL, never DWELL's Stripe); own
      Coinbase business account; own **Resend account + sending domain** and
      support inbox.
- [ ] **Own database**: fresh Supabase project in its own org; the shared
      `schema.sql` + migrations applied to an **empty** DB. No data
      migration of any kind — no users, devices, balances, campaigns,
      referral codes, or ad inventory imported from DWELL. Own
      `DATABASE_URL`, service keys, session/webhook secrets, `ADMIN_KEY`.
- [x] **Own site**: DWELL domain + its own Vercel project (root =
      `dwell/web`). No links, redirects, shared assets, or shared analytics
      between the two sites in either direction — enforced by the
      cross-brand grep in CI. *(Done 2026-07-07: dwellprotocol.com live on
      the `dwell-protocol` Vercel project.)*
- [ ] **Own admin dashboard deployment**: the **same** admin UI
      (`web/admin.{html,js,css}` elements), served from the DWELL site on
      the black/green theme and pointed at the DWELL backend with its own
      `ADMIN_KEY`; the DWELL-only surfaces (reserve attestation view,
      `POST /v1/admin/epochs/publish-root`) are additive panels behind the
      same brand/config layer. No shared operator sessions, no shared
      admin keys.
- [ ] **Own distribution identities**: new Chrome Web Store listing under
      DWELL's own developer account; new npm package/scope; own Apple
      Developer account + bundle ID; DMG shipped from DWELL's own releases.
- [ ] **No cross-honoring**: the DWELL backend accepts no DWELL device keys,
      sessions, impression tokens, or referral codes, and vice versa —
      fresh secrets everywhere makes this structural, not policy.

## Phase 1 — points launch

1. [ ] The **runtime rows of the Separation list are done**: money stack,
       database, site, admin deployment, secrets. Nothing DWELL serves in
       production may touch a DWELL account, key, or database.
2. [x] Backend changes from [04-backend-adaptation.md](04-backend-adaptation.md)
       §A–§D implemented in the **shared** `server/src` + edge function
       behind config — defaults preserve DWELL's behavior exactly; the
       DWELL deployment enables them (`TOKEN_MODE=points`, the BPS knobs) —
       with server tests covering both the legacy split and the 60/10/30
       split math + reserve invariants. *(Landed 2026-07-06: schema +
       `20260706_dwell_token_mode.sql`, three-way split with ledger closure,
       reserve earmark at payment, `/v1/reserve` + points summary; the
       live-mode §D surfaces are staged 409/501 stubs until the TGE
       tooling ships. 54-check suite green, both splits covered.)*
3. [ ] Coinbase business account opened (DWELL's own) for live-phase USD→USDC
       conversion; withdrawal addresses locked; API keys IP-allowlisted.
4. [ ] Fiat sweeper (keeper job 1) running against Stripe test mode;
       `usdc_reserve_entries` (ledger earmark rows) reconcile to the cent.
5. [ ] Public accounting page live (`GET /v1/reserve` + portal strip):
       token-side earmark total vs. outstanding points, updated daily.
6. [ ] **DWELL site rebuilt from the DWELL UI elements**: portal and admin
       reuse `web/`'s markup/components verbatim with the DWELL `theme.css`
       tokens and copy swapped (the design system is already fully
       token-driven, so a re-skin is theme + copy, not new UI); the landing
       page may differ in copy but draws from the same element library.
       Document the pairing in AGENTS.md alongside the existing theme-mirror
       discipline so changes port both ways.
7. [ ] DWELL site live on its **own domain + own Vercel project** (root =
       `dwell/web`); "PREVIEW" pill removed; `dwell-api` meta tag pointed at
       the DWELL edge function; OG cards + favicon final; copy passes the
       [05-legal-structure.md](05-legal-structure.md) rules (the
       banned-language grep runs in CI — `site` job).
8. [ ] Points accrue end-to-end in production: view ad → `points_credit` →
       portal balance → reserve attestation matches.

## TGE gate criteria (all true before Phase 2 starts)

- [ ] Sustained ad revenue ≥ ~$1K/day for 60+ days (enough for the flywheel
      to mean something and to justify fixed costs).
- [ ] ≥ $25K (target $100K) committed to the DWELL/USDC liquidity seed,
      separate from the points reserve.
- [ ] Securities + tax counsel engaged; sign-off on entity structure (issuer
      subsidiary formed), token allocations, vesting docs, and every public
      copy surface — **including the [09-securities-framework.md](09-securities-framework.md)
      counsel gate: Bedrock constitutional-document diligence and the raise
      geofence/KYC decision (recommended: exclude US persons from the raise).**
- [ ] Contract audit booked (see below) — budget $30–80K.

## Phase 2 — TGE runbook (ordered)

1. [x] `forge build && forge test` green on the pinned toolchain — verified
       2026-07-06 (forge 1.7.1 / solc 0.8.26, 25/25 passing, including the
       60/10/30 revision) and enforced on every push by the
       `dwell-contracts` CI job.
2. [ ] **Audit** of `DWELL.sol`, `CampaignFunder.sol`,
       `MerkleRewardsDistributor.sol`; findings fixed; re-audit of diffs.
3. [ ] **Base Sepolia dry-run of the full loop**: deploy → seed test pool →
       sweeper funds a test campaign via `swapAndFund` → accrue → publish
       root → claim → cash-out widget sandbox. Run the failure drills from
       [02-architecture.md](02-architecture.md) (bad root → pause → corrected
       root; slippage revert; reorg re-index).
4. [ ] **Key ceremony**: treasury Safe (2-of-3 hardware), rootSetter + keeper
       keys in KMS, spending caps, on-call runbook. Record addresses in
       `04-backend-adaptation.md` env table.
5. [ ] **Mainnet deploy** via `contracts/script/Deploy.s.sol`; contracts
       verified on BaseScan; `setSwapTarget` + `setKeeper` from the Safe;
       Distributor funded for epoch 1 only.
6. [ ] **Liquidity seed**: DWELL/USDC pool on Aerodrome; depth published.
7. [ ] **(v2 — no points conversion.)** dwells are dollar-denominated and do
       not convert at the raise. Instead: USDC payout rail live (licensed
       partner as counterparty of record), Claude-credit boost configured,
       reserve attestation (earmarked dollars vs outstanding dwells) public,
       and the grandfathering notice shipped (face-value settlement; no
       token claim).
8. [ ] **(v2 — retired.)** No Merkle claim for earners exists; there is no
       converted-points root. (The distributor remains reference code only.)
9. [ ] **Geofences live and tested**: NY + Canada blocked for wallet linking
       and claims; sanctioned-country screening via the wallet/offramp
       partners.
10. [ ] **W-9 / 1099 pipeline live** ($2K threshold alerting) before the
        first claim window opens.
11. [ ] `TOKEN_MODE=live`; wallet linking + claims + cash-out tab enabled;
        campaign funding switches from ledger earmark to `swapAndFund`.
12. [ ] Monitoring: CampaignFunded/Claimed indexer lag, root cadence, earmark
        drift alarm, pool depth, failed-swap alerts — all paging.

## Client surfaces (post-demo, pre- or during points launch)

The web portal is the cash-out surface; **earning happens in the clients**.
All three ship for both brands **from the same source** — the ad-serving
logic (impression serve/redeem, dwell, caps) is identical and backend-driven;
a brand/config layer supplies the name, icons, theme tokens, copy strings,
and `API_BASE`. The only behavioral difference is displaying points (the
millicent balance *is* the points number).

- [ ] **Backend instance**: the fresh Supabase project from the Separation
      list; shared `schema.sql` + migrations applied; the shared code
      deployed with DWELL env: `VIEWER_SHARE_BPS=6000`,
      `REFERRER_SHARE_BPS=1000`, `RESERVE_TRANCHE_BPS=9000`,
      `TOKEN_MODE=points`. The DWELL deployment runs the same code with
      defaults and is behavior-identical to today.
- [ ] **Admin deployment**: ships **with** the backend instance — campaign
      approval, receipts, and the killswitch must work from day one; there
      is no fallback to DWELL's admin.
- [ ] **Chrome extension**: one source, two packaged artifacts — add a
      brand switch to the packaging step (`make package-ext BRAND=dwell`)
      that swaps manifest name, icons, popup `theme.css` (byte-copy of the
      DWELL `web/theme.css`), the inject.css `--ov-*` mirror, and
      `API_BASE`; **new** Web Store listing under DWELL's own developer
      account (review lead time: days).
- [ ] **Terminal client**: same source published under a second npm name
      (`dwell` or similar, DWELL's own scope) with a brand config — bin
      name, copy strings, a distinct marked shell-alias block, and
      `API_BASE` — so both brands' clients can coexist on one machine
      without touching each other's alias blocks.
- [ ] **macOS app**: same Swift source, second build target — bundle ID,
      icon, brand strings, palette values, `API_BASE` — signed and
      notarized under DWELL's own Apple Developer account; DMG on DWELL's
      own GitHub releases; wire `/download/mac` in the DWELL site's
      `vercel.json` when it exists.
- [ ] All DWELL clients display dwells with the factual dollar legend
      (1,000 dwells = $1.00 of earned ad value) and the two redemption paths
      (USDC / Claude credits). No client, store listing, or README may state
      or imply that dwells convert to $DWELL.

## Standing rules after launch

- Fund the Distributor per-epoch, never in bulk.
- Team allocation: 1-year cliff, 4-year vest, **no sales into protocol buys**
  without a pre-announced 10b5-1-style plan.
- Any copy change touching money mechanics re-runs the banned-language grep
  and, if material, counsel review.
- An incident that pauses claims gets a public postmortem on the reserve page.
