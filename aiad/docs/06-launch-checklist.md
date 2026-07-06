# Launch checklist

Two launches: **points** (soon, cheap, reversible) and **TGE** (later,
expensive, one-way). Each item is a gate — nothing below it starts until it's
done.

**Decision record (2026-07-06): rebrand-in-place.** FreeAI *becomes* the AIAD
version — one product, one marketplace, one backend, this repo. There is no
parallel brand: the existing Supabase project, ad inventory, advertiser
accounts, and user balances carry over. Items below that used to assume a
parallel fork are written for the in-place conversion; the extra work that
decision creates (balance conversion, advertiser terms, brand swap) is called
out in Phase 1.

## Phase 1 — points launch

1. [ ] Backend changes from [04-backend-adaptation.md](04-backend-adaptation.md)
       §A–§D implemented in **both** `server/src` and the edge function, with
       server tests covering the 50/15/35 split math and the reserve
       invariants (`TOKEN_MODE=points`).
2. [ ] Coinbase business account opened; reserve account segregated;
       withdrawal addresses locked; API keys IP-allowlisted.
3. [ ] Fiat sweeper (keeper job 1) running against Stripe test mode →
       Coinbase sandbox; `usdc_reserve_entries` reconcile to the cent.
4. [ ] Public reserve page live (`GET /v1/reserve` + portal strip): escrowed
       USDC vs. outstanding points, updated daily.
5. [ ] AIAD site goes live as **the** site: the production Vercel project's
       Root Directory switches from `web` to `aiad/web` (carrying over
       `web/vercel.json`'s redirects — `/download/mac` — into
       `aiad/web/vercel.json`); domain decision recorded (keep serving on
       `freeai.fyi` vs. move to an AIAD domain with redirects); "PREVIEW"
       pill removed; `aiad-api` meta tag pointed at the production edge
       function; OG cards regenerated for the black/green brand; copy passes
       the [05-legal-structure.md](05-legal-structure.md) rules (the
       banned-language grep now runs in CI — `site` job).
6. [ ] **Balance conversion policy recorded and announced**: existing FreeAI
       millicent balances convert to points 1:1 (the millicent balance *is*
       the points number, 1,000 = $1.00); gift-card redemption stays
       deprecated-but-running per [04-backend-adaptation.md](04-backend-adaptation.md)
       §D as the legacy exit, with a sunset date announced separately.
7. [ ] **Advertiser terms updated for the split change**: gross now routes
       90% to the token side (vs. the old 50% user share) — checkout copy,
       receipts, FAQ, and any active-campaign comms reflect it before the
       switch flips.
8. [ ] Points accrue end-to-end in production: view ad → `points_credit` →
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

- [ ] **Backend instance**: the existing Supabase project converts in place —
      dated migration for the doc-04 §A schema changes; §B split + §C config
      + §D endpoints land in **both** `server/src` and the edge function in
      the same commit; production env gets `VIEWER_SHARE_BPS=5000`,
      `REFERRER_SHARE_BPS=1500`, `RESERVE_TRANCHE_BPS=9000`,
      `TOKEN_MODE=points`. (Decision: rebrand-in-place — see the decision
      record at the top.)
- [ ] **Design system swap**: `aiad/web/theme.css` (black/green) becomes the
      project's single source of truth per AGENTS.md — the token-mirror
      table (popup byte-copy, inject.css `--ov-*`, macOS `Palette`,
      onboarding `tokens.css`), `make icons`/`make og`, and the AGENTS.md
      design rules all repoint from the cream/coral system in the same
      change.
- [ ] **Chrome extension**: rebrand the **existing** Web Store listing in
      place (name, icons, popup theme.css = byte-copy of the AIAD
      `web/theme.css`, inject.css `--ov-*` mirror); `API_BASE` unchanged
      (same backend). Existing installs auto-update into the new brand —
      time the store review (lead time: days) to land with the site switch.
- [ ] **Terminal client**: publish under the new name (`aiad` or similar),
      deprecate `@freeai.fyi/terminal` on npm with a pointer; rebrand
      strings + the marked shell-alias block (setup must cleanly replace the
      old FreeAI block on upgrade).
- [ ] **macOS app**: rebrand + rebuild, sign, notarize, ship the DMG as a
      new GitHub release so the existing `/download/mac` redirect serves the
      AIAD build; existing users get the update via the site (no
      auto-update channel). Same developer account until AIAD is its own
      legal entity.
- [ ] All clients display "points" with the 1,000 = $1.00 legend.

## Standing rules after launch

- Fund the Distributor per-epoch, never in bulk.
- Team allocation: 1-year cliff, 4-year vest, **no sales into protocol buys**
  without a pre-announced 10b5-1-style plan.
- Any copy change touching money mechanics re-runs the banned-language grep
  and, if material, counsel review.
- An incident that pauses claims gets a public postmortem on the reserve page.
