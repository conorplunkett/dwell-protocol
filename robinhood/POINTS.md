# Season points — the pre-launch earning program

> Exploratory; see [`README.md`](README.md). Points here are **airdrop season
> points**, a new ledger. They are not dwells, never touch the dwells
> balance, and nothing in this document changes dwells' dollar redemption.

## Design rules

1. **Points are relative, not denominated.** A season's fixed 60M-token pool
   divides pro-rata over season points ([`TOKENOMICS.md`](TOKENOMICS.md)).
   Point amounts below only matter relative to each other, so the schedule
   can be tuned mid-season for *future* actions without breaking anything.
2. **Recurring earn comes from qualified views.** The same event that
   credits dwells (2-second dwell, existing per-device/per-IP anti-fraud
   caps in the ingest path) credits season points. One-time bonuses shape
   behavior; they are not the engine.
3. **Every award is an append-only ledger row** with an idempotency key —
   same shape as the existing `ledger` table, separate table
   ([`db/points-schema.sql`](db/points-schema.sql)).

## Earning schedule (season 1)

### Viewers

| Action | Points | Type |
|---|---|---|
| Qualified ad view (any surface) | **1** | Recurring — the base earn |
| First qualified view ever | **10** | One-time |
| First qualified view on Gemini | **15** | One-time |
| First qualified view on ChatGPT (Chrome extension) | **15** | One-time |
| First qualified view on desktop app | **15** | One-time |
| First qualified view in the terminal/CLI | **15** | One-time |
| 100 lifetime qualified views | **1,000** | Milestone |
| 1,000 lifetime qualified views | **5,000** | Milestone |
| Referral: referred user reaches 25 qualified views | **100** | Per referral, capped at 50 counted referrals per season |

Two deliberate changes from the original sketch (pushback, with reasons):

- **Surface bonuses are one-time, not per-view.** If Gemini/ChatGPT/desktop/
  CLI paid 15 per view while the base is smaller, everyone would farm the
  highest-paying surface and the numbers would measure nothing. A flat
  1-point base per qualified view on every surface plus a one-time 15-point
  "unlock" per surface rewards trying each client without distorting where
  people actually watch.
- **Referrals are activation-gated, not paid on signup.** A flat 100 points
  per referred signup is free money for sybil farms (the #1 exploited
  mechanic in every points program). The bonus releases only when the
  referred user reaches 25 qualified views, and at most 50 referrals count
  per season. The existing `referrals` table and its
  pending→rewarded/capped flow already model this; season points hook the
  same transition.

### Advertisers — ⚠️ counsel-gated, recommended: do not ship as points

The original sketch ("buy your first ad: 100, buy 10 ads: 1,000") has two
problems:

1. **Legal.** Awarding tokens for paying money is economically a token sale
   with extra steps — it hands the Howey "investment of money" element to
   every advertiser on a plate, on top of the earner-side exposure this
   whole folder already carries. This is the single most radioactive
   mechanic in the plan.
2. **Mechanical.** Counting *campaigns* rather than *dollars* means ten $1
   test campaigns outscore one $10,000 campaign.

**Recommendation: reward advertisers in dollar-denominated ad credits**
(e.g., first campaign gets a $100 inventory credit; volume tiers get
percentage credits), which is a normal customer promotion with none of the
securities weight, and keep the airdrop earner-side only.

If, after counsel review, advertiser points ship anyway, the defensible
shape is spend-weighted:

| Action | Points |
|---|---|
| First accepted campaign | 100 |
| Per $1 of accepted campaign spend | 1 |
| $10,000 lifetime accepted spend | 1,000 |

("Accepted" = campaign passed review and funded — matching the existing
funded-at-acceptance semantics — so rejected/refunded campaigns earn
nothing.)

## Anti-sybil / anti-fraud

- Base earn inherits the ingest path's existing per-device and per-IP caps;
  points are credited from the same qualified-view events, so there is no
  separate surface to attack.
- One account per person is enforced at the claim boundary: claiming
  requires a linked wallet, and the snapshot pipeline collapses accounts
  sharing devices/payment fingerprints before the Merkle tree is built
  (flagged rows are excluded, with an appeal window before the root is
  published).
- Referral gating as above; referral chains deeper than one level earn
  nothing.
- Per-account season point totals and the full snapshot input are published
  at season close, so exclusions and totals are independently checkable.
- **Geofencing at claim** (US persons, per the recommendation already in
  `dwell/docs/09-securities-framework.md`) is a counsel decision that must
  be made *before* the points campaign is announced, not at snapshot time —
  users must know before they earn whether they can claim.

## Season snapshot → Merkle root

1. Season close: freeze the `season_points_events` ledger at the announced
   snapshot timestamp.
2. Run exclusions (fraud flags, unlinked wallets after the grace window),
   publish the preliminary per-account totals, open a 7-day appeal window.
3. Final totals → `user_tokens = 60M × user_points / total_points`
   (integer floor; dust remainder stays in the pool and rolls over).
4. Build the Merkle tree over `(seasonId, wallet, amount)` double-hashed
   leaves — same construction as
   [`contracts/test/SeasonMerkleDistributor.t.sol`](contracts/test/SeasonMerkleDistributor.t.sol)
   — publish the tree input, fund the distributor, `startSeason`.
5. 3-month claim window; then `closeSeason` rolls unclaimed into season N+1.

## Database

Schema in [`db/points-schema.sql`](db/points-schema.sql). Summary:

- `airdrop_seasons` — one row per season: window, snapshot time, pool size,
  published root, on-chain season id.
- `season_points_events` — append-only ledger (`user_id`, `season_id`,
  `kind`, `points`, `source_ref`, `idempotency_key`). Mirrors the existing
  `ledger` table's shape so the ingest path can write both in one
  transaction.
- `season_points_balances` — view aggregating events per user per season
  (cheap at this scale; materialize if it ever isn't).
- `season_snapshots` — frozen per-user totals + computed token amounts +
  Merkle leaf/proof data for the claim UI, written once at snapshot.

The one-time/milestone bonuses are enforced by uniqueness on
`(user_id, kind)` (lifetime bonuses) or `(user_id, season_id, kind)` plus
the idempotency key — double-crediting is a constraint violation, not a
code-review hope.
