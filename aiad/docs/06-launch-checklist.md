# Launch checklist

Two launches: **points** (soon, cheap, reversible) and **TGE** (later,
expensive, one-way). Each item is a gate — nothing below it starts until it's
done.

> **star.fun variant:** if launching via star.fun, the raise **is** the TGE —
> see [07-starfun-launch.md](07-starfun-launch.md). The points phase shrinks
> to the window between first ad revenue and graduation; Phase-2 items 5–7
> (deploy, liquidity seed, reserve conversion) are replaced by the raise +
> graduation, and item 3's dry-run targets the Solana stack (Jupiter keeper +
> Solana Merkle distributor on devnet). Everything legal (counsel, geofences,
> W-9 pipeline) moves **before the raise**.

## Phase 1 — points launch

1. [ ] Backend changes from [04-backend-adaptation.md](04-backend-adaptation.md)
       §A–§D implemented in **both** `server/src` and the edge function, with
       server tests covering the 85/15 split math and the reserve
       invariants (`TOKEN_MODE=points`).
2. [ ] Coinbase business account opened; reserve account segregated;
       withdrawal addresses locked; API keys IP-allowlisted.
3. [ ] Fiat sweeper (keeper job 1) running against Stripe test mode →
       Coinbase sandbox; `usdc_reserve_entries` reconcile to the cent.
4. [ ] Public reserve page live (`GET /v1/reserve` + portal strip): escrowed
       USDC vs. outstanding points, updated daily.
5. [ ] AIAD site deployed as its own Vercel project (root = `aiad/web`);
       "PREVIEW" pill removed; copy passes the
       [05-legal-structure.md](05-legal-structure.md) rules
       (`rg -in 'moon|price will|appreciat|going up|invest' aiad/web` → 0 hits).
6. [ ] Points accrue end-to-end in production: view ad → `points_credit` →
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

1. [ ] `forge build && forge test` green in CI on the pinned toolchain
       (contracts were authored without a local Solidity toolchain — machine
       verification is a merge gate, see `../contracts/README.md`).
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

- [ ] **Backend instance**: fresh Supabase project for AIAD; run the parent
      `schema.sql` + migrations + doc-04 changes; deploy the edge function
      with AIAD config (`VIEWER_SHARE_BPS=8500`, `REFERRER_SHARE_BPS=1500`,
      `TOKEN_MODE=points`). Decision recorded first: parallel brand
      (separate DB, separate ad inventory) vs. rebrand-in-place (one
      marketplace) — this checklist assumes parallel.
- [ ] **Chrome extension**: fork, rebrand (name, icons, popup theme.css =
      byte-copy of `web/theme.css`, inject.css --ov-* mirror), point
      `API_BASE` at the AIAD backend, new Chrome Web Store listing (review
      lead time: days).
- [ ] **Terminal client**: publish under a new npm package name (`aiad` or
      similar), rebrand strings + shell-alias block, new `API_BASE`.
- [ ] **macOS app**: new bundle ID, rebuild, sign, notarize, ship the DMG on
      AIAD's own releases; wire `/download/mac` in `web/vercel.json` when it
      exists. (New Apple developer account only if AIAD becomes its own
      legal entity.)
- [ ] All clients display "points" with the 1,000 = $1.00 legend.

## Standing rules after launch

- Fund the Distributor per-epoch, never in bulk.
- Team allocation: 1-year cliff, 4-year vest, **no sales into protocol buys**
  without a pre-announced 10b5-1-style plan.
- Any copy change touching money mechanics re-runs the banned-language grep
  and, if material, counsel review.
- An incident that pauses claims gets a public postmortem on the reserve page.
