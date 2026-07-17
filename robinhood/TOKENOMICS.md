# Tokenomics — Robinhood Chain exploration

> Exploratory; see [`README.md`](README.md) for status and decision gates.
> State mechanics as facts. No price talk — the copy rules in
> [`dwell/docs/05-legal-structure.md`](../dwell/docs/05-legal-structure.md)
> apply to anything derived from this document.

## Supply and allocation

Fixed supply **1,000,000,000** (1B, 18 decimals), minted once at TGE to the
treasury Safe by [`contracts/src/DWELL.sol`](contracts/src/DWELL.sol) — no
mint function, no owner, no hooks. Every allocation below leaves the Safe as
an explicit, publicly auditable transaction per
[`LAUNCH-PLAN.md`](LAUNCH-PLAN.md).

| Bucket | % | Tokens | Mechanics |
|---|---|---|---|
| Community seasons | **30%** | 300M | 5 seasons × 6% (60M each), distributed pro-rata to points via the [`SeasonMerkleDistributor`](contracts/src/SeasonMerkleDistributor.sol); funded per-season, never in bulk |
| Team | **25%** | 250M | One [`CliffVestingWallet`](contracts/src/CliffVestingWallet.sol) per member: 12-month cliff, 36-month total, start = TGE |
| Treasury | **20%** | 200M | Held by the Safe. Sales only under a pre-announced schedule, counsel-gated — the discipline in `dwell/docs/01-tokenomics.md` carries over verbatim |
| Ecosystem / grants | **15%** | 150M | Grants to integrations, clients, and tooling; each grant published with recipient, amount, and vesting |
| Open-market liquidity | **10%** | 100M | Seeds the Uniswap DWELL/ETH pool on Robinhood Chain at TGE; LP position locked (see launch plan) |

Notes on the shape:

- 10% to the pool is deliberate. The pool seed sets the launch price
  (tokens × price must be matched by the ETH side), and 5–10% is the market
  norm; depth is added later from treasury as actually needed, not
  front-loaded.
- Circulating supply at TGE is the LP seed plus whatever season 1 claimants
  have claimed. Team, treasury, ecosystem, and future seasons are all in
  visibly locked or Safe-held positions, verifiable on the explorer.

## Seasons

- **5 seasons, 60M tokens each, evenly split.** Season 1 rewards the
  pre-launch points campaign ([`POINTS.md`](POINTS.md)); seasons 2–5 reward
  points earned in subsequent windows (~quarterly cadence, finalized per
  season).
- **Claim window: 3 months** from season open, enforced on-chain
  (`claimDeadline`).
- **Unclaimed tokens roll into the next season's pool.** This is enforced by
  the distributor contract (`closeSeason` → `carryover` → next
  `startSeason`), not by policy document: unclaimed community tokens stay in
  the community program. They are never quietly swept to the treasury. (An
  owner-only `sweepCarryover` exists solely for program wind-down after the
  final season closes, and cannot run while a season is open.)
- Each season's root, pool, and deadline are announced before the season
  opens; the Merkle tree input (address → points → tokens) is published so
  any user can recompute their allocation.

## Points → tokens conversion

**There is no fixed points-per-token rate.** Each season's pool is fixed
(60M) and a user's allocation is pro-rata:

```
user_tokens = season_pool × user_points / total_season_points
```

computed at the season snapshot. This is the standard design (Blast,
Hyperliquid, and essentially every serious points program) for a reason: a
fixed rate makes total token liability a function of user behavior — either
it overruns the pool and the rate must be broken retroactively, or the pool
goes half-unused. Pro-rata makes the liability exactly the pool, always.

Consequences to state plainly in user-facing copy (as facts, no more):

- Points have no fixed token value; a point's season value depends on total
  points earned by everyone that season.
- Points do not carry over between seasons and are not transferable.
- Points are not dwells. dwells remain dollar-denominated credits redeemable
  per the live tokenomics doc; nothing about them changes here.

## What the token is and is not

Carried over from the v2 framing, unchanged in substance:

- $DWELL on Robinhood Chain is a fixed-supply ERC-20. It is not equity,
  carries no revenue share, and is redeemable with the company for nothing.
- Ad revenue does not buy the token. No buybacks, burns, or distributions
  are committed to.
- The one change this exploration makes — and the reason it is
  counsel-gated — is that **earners now receive the token** via seasonal
  airdrops. See [`README.md`](README.md) decision gate 1.
