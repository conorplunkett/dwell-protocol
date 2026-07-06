# Launch checklist

Two launches: **points** (soon, cheap, reversible) and **TGE** (later,
expensive, one-way). Each item is a gate — nothing below it starts until it's
done.

**Decision record (2026-07-06): parallel brand — full separation.** AIAD and
FreeAI are **separate businesses**. Separate ad inventory, separate databases,
separate domains, separate money accounts, separate operator tooling — zero
connections between the sites, in either direction. The `aiad/` folder lifts
out into its own repository (it is self-contained by design); the parent
product is not modified. The Separation section below is the enforcement list.
(This supersedes a same-day rebrand-in-place note that briefly stood here.)

## Separation — two businesses, zero connections

Everything AIAD runs is its own instance. Code is forked once at lift-out and
then diverges freely; nothing is shared, linked, or reused **at runtime**.

- [ ] **Own repository**: lift `aiad/` out unchanged; fork in the backend
      (`server/` + `supabase/functions/api`), the three clients, and the
      admin dashboard as AIAD-owned copies; own CI (the `aiad-contracts` job
      and site checks move with it), own secrets store.
- [ ] **Own legal + money stack**: AIAD entity per
      [05-legal-structure.md](05-legal-structure.md); own bank account; own
      **Stripe account** (advertisers pay AIAD, never FreeAI's Stripe); own
      Coinbase business account; own **Resend account + sending domain** and
      support inbox.
- [ ] **Own database**: fresh Supabase project in its own org; the parent
      `schema.sql` + migrations + doc-04 changes applied to an **empty** DB.
      No data migration of any kind — no users, devices, balances,
      campaigns, referral codes, or ad inventory imported from FreeAI. Own
      `DATABASE_URL`, service keys, session/webhook secrets, `ADMIN_KEY`.
- [ ] **Own site**: AIAD domain + its own Vercel project (root =
      `aiad/web`, or `web/` after lift-out). No links, redirects, shared
      assets, or shared analytics between the two sites in either direction
      — enforced by the cross-brand grep in CI while both still live in
      this repo.
- [ ] **Own admin dashboard**: fork `web/admin.{html,js,css}` into AIAD,
      restyled on the black/green theme, served from the AIAD site, pointed
      at the AIAD backend with its own `ADMIN_KEY`; grows the AIAD-only
      surfaces (reserve attestation view,
      `POST /v1/admin/epochs/publish-root`). No shared operator tooling,
      no shared admin keys.
- [ ] **Own distribution identities**: new Chrome Web Store listing under
      AIAD's own developer account; new npm package/scope; own Apple
      Developer account + bundle ID; DMG shipped from AIAD's own releases.
- [ ] **No cross-honoring**: the AIAD backend accepts no FreeAI device keys,
      sessions, impression tokens, or referral codes, and vice versa —
      fresh secrets everywhere makes this structural, not policy.

## Phase 1 — points launch

1. [ ] The **runtime rows of the Separation list are done**: money stack,
       database, site, admin dashboard, secrets. (The repo lift-out may
       trail the launch — the folder is self-contained either way — but
       nothing AIAD serves in production may touch a FreeAI account, key,
       or database.)
2. [ ] Backend changes from [04-backend-adaptation.md](04-backend-adaptation.md)
       §A–§D implemented in **both** the forked `server/src` and edge
       function, with server tests covering the 50/15/35 split math and the
       reserve invariants (`TOKEN_MODE=points`).
3. [ ] Coinbase business account opened (AIAD's own); reserve account
       segregated; withdrawal addresses locked; API keys IP-allowlisted.
4. [ ] Fiat sweeper (keeper job 1) running against Stripe test mode →
       Coinbase sandbox; `usdc_reserve_entries` reconcile to the cent.
5. [ ] Public reserve page live (`GET /v1/reserve` + portal strip): escrowed
       USDC vs. outstanding points, updated daily.
6. [ ] AIAD site live on its **own domain + own Vercel project** (root =
       `aiad/web`, or `web/` after lift-out); "PREVIEW" pill removed;
       `aiad-api` meta tag pointed at the AIAD edge function; OG cards +
       favicon final; copy passes the
       [05-legal-structure.md](05-legal-structure.md) rules (the
       banned-language grep runs in CI — `site` job).
7. [ ] Points accrue end-to-end in production: view ad → `points_credit` →
       portal balance → reserve attestation matches.

## TGE gate criteria (all true before Phase 2 starts)

- [ ] Sustained ad revenue ≥ ~$1K/day for 60+ days (enough for the flywheel
      to mean something and to justify fixed costs).
- [ ] ≥ $25K (target $100K) committed to the AIAD/USDC liquidity seed,
      separate from the points reserve.
- [ ] Securities + tax counsel engaged; sign-off on entity structure (issuer
      subsidiary formed), token allocations, vesting docs, and every public
      copy surface.
- [ ] Contract audit booked (see below) — budget $30–80K.

## Phase 2 — TGE runbook (ordered)

1. [x] `forge build && forge test` green on the pinned toolchain — verified
       2026-07-06 (forge 1.7.1 / solc 0.8.26, 25/25 passing) and enforced on
       every push by the `aiad-contracts` CI job.
2. [ ] **Audit** of `AIAD.sol`, `CampaignFunder.sol`,
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
6. [ ] **Liquidity seed**: AIAD/USDC pool on Aerodrome; depth published.
7. [ ] **Reserve conversion**: the points reserve executes its published TWAP
       buy schedule; every fill recorded in `usdc_reserve_entries`
       (`tge_buy`); outstanding points convert pro-rata at the aggregate
       execution price; conversion math published before it runs.
8. [ ] First cumulative root published (includes converted points + the
       treasury shortfall leaf); spot-check N wallets' proofs against the
       contract before announcing.
9. [ ] **Geofences live and tested**: NY + Canada blocked for wallet linking
       and claims; sanctioned-country screening via the wallet/offramp
       partners.
10. [ ] **W-9 / 1099 pipeline live** ($2K threshold alerting) before the
        first claim window opens.
11. [ ] `TOKEN_MODE=live`; wallet linking + claims + cash-out tab enabled;
        campaign funding switches from escrow to `swapAndFund`.
12. [ ] Monitoring: CampaignFunded/Claimed indexer lag, root cadence, reserve
        drift alarm, pool depth, failed-swap alerts — all paging.

## Client surfaces (post-demo, pre- or during points launch)

The web portal is the cash-out surface; **earning happens in the clients**.
All three exist in the parent repo and are forks-and-rebrands, not rewrites —
their earning logic (impression serve/redeem, dwell, caps) is backend-driven,
and the only in-client change beyond branding is displaying points (the
millicent balance *is* the points number).

- [ ] **Backend instance**: the fresh Supabase project from the Separation
      list; parent `schema.sql` + migrations + doc-04 changes applied in the
      AIAD fork (both `server/src` and the edge function in the same
      commit); env: `VIEWER_SHARE_BPS=5000`, `REFERRER_SHARE_BPS=1500`,
      `RESERVE_TRANCHE_BPS=9000`, `TOKEN_MODE=points`.
- [ ] **Admin dashboard**: the fork from the Separation list ships **with**
      the backend instance — campaign approval, receipts, and the
      killswitch must work from day one; there is no fallback to FreeAI's
      admin.
- [ ] **Chrome extension**: fork + rebrand (name, icons, popup theme.css =
      byte-copy of the AIAD `web/theme.css`, inject.css `--ov-*` mirror);
      `API_BASE` → the AIAD backend; **new** Web Store listing under AIAD's
      developer account (review lead time: days).
- [ ] **Terminal client**: new npm package (`aiad` or similar) under AIAD's
      own scope; rebrand strings + the marked shell-alias block — use a
      distinct block marker and function name so the AIAD and FreeAI
      clients can coexist on one machine without touching each other's
      alias blocks. FreeAI's package is not modified.
- [ ] **macOS app**: new bundle ID, rebuild, sign, notarize under AIAD's
      Apple Developer account; ship the DMG on AIAD's own GitHub releases;
      wire `/download/mac` in the AIAD site's `vercel.json` when it exists.
- [ ] All clients display "points" with the 1,000 = $1.00 legend.

## Standing rules after launch

- Fund the Distributor per-epoch, never in bulk.
- Team allocation: 1-year cliff, 4-year vest, **no sales into protocol buys**
  without a pre-announced 10b5-1-style plan.
- Any copy change touching money mechanics re-runs the banned-language grep
  and, if material, counsel review.
- An incident that pauses claims gets a public postmortem on the reserve page.
