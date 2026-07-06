# AIAD tokenomics

AIAD pays people for their attention. Advertisers buy ad impressions at fixed
dollar prices; 90% of every ad dollar is converted into AIAD and split between
the viewer, their referrer, and the protocol. Users are only ever paid tokens
that ad revenue already bought — no minting, no emissions schedule, no oracle.

> **Copy rule (every public surface):** state the mechanics as facts. Never say
> or imply the price will rise, that buys are "price support," or that holding
> is an investment. See [05-legal-structure.md](05-legal-structure.md).

## Token facts

| | |
|---|---|
| Name / symbol | AIAD |
| Chain | Solana (SPL), launched via a [star.fun](https://star.fun) curated raise |
| Supply | 1,000,000,000 — fixed, minted once |
| Raise | **$50K target at $1M FDV** (5% of supply, $0.001/AIAD), 5-day window, refunds if the minimum isn't met |
| Equity link | star.fun standard structure only — no additional equity allocation |

Liquidity is seeded from the raised USDC into a Meteora pool at graduation
(star.fun mechanic — liquidity does not come out of token supply). The EVM
contracts in [`../contracts`](../contracts) remain the reference
implementation; the live path is Solana per
[07-starfun-launch.md](07-starfun-launch.md).

## Allocation

| Bucket | % | Notes |
|---|---|---|
| Public sale | 5% | $50K at $1M FDV via the curated raise |
| Token rewards | 30% | Points conversion at the raise price + launch boosts; remainder held |
| Team | 20% | 3-month cliff + 9-month linear vest (star.fun preset) |
| Treasury | 45% | Ops and liquidity top-ups; published Squads multisig, released per the star.fun treasury-allowance schedule |

✎ Final bucket sizes are entered in the star.fun portal — confirm with the
star.fun team before hitting launch (launch is instant).

## The advertiser dollar

Advertisers pay a fixed dollar CPM by card, same as the platform today. Per
$100 of ad spend:

| Leg | Amount | Where it goes |
|---|---|---|
| Card processing (Stripe) | ~$2.50 | Stripe |
| Provider fees (conversion, swap, gas) | ~$2.50 | Providers / network |
| Business margin (fiat) | $5.00 | The operating company |
| **Token side** | **$90.00** | Points phase: escrowed in the USDC reserve. Live phase: market-buys AIAD immediately |

Knob: `RESERVE_TRANCHE_BPS = 9000`. Direct USDC payment (optional later) skips
the card leg and pushes ~$97.50 to the token side.

## The pool split — 60 / 10 / 30

The $90 tranche (points: its dollar value; live: the tokens it bought) splits:

| Recipient | Share of pool | Knob |
|---|---|---|
| Viewer | **60%** | `VIEWER_SHARE_BPS = 6000` |
| Referrer | **10%** | `REFERRER_SHARE_BPS = 1000` |
| Protocol treasury | **30%** (40% when the viewer has no referrer) | remainder — keeps integer math exact |

The referrer share is carved out of the pool, not paid on top. The protocol
leg is held, not sold; any treasury sale is pre-announced. `BURN_BPS`
(default 0) can route a fraction of the treasury leg to burn — leaving it 0 is
deliberate: no burn promises.

## Campaign-locked rate (live phase)

There is no "earn rate" to set. When a campaign's payment clears, the $90 is
market-bought into AIAD (Jupiter-routed into the Meteora pool), and:

```
locked rate = tokens the buy received ÷ impressions the campaign bought
```

**Example.** A $100 campaign at a $10 CPM buys 10,000 impressions. The $90 buy
executes at $0.002/AIAD → 45,000 AIAD. Locked rate = 4.5 AIAD per qualified
view:

| | AIAD per view | of the 45,000 pool |
|---|---|---|
| Viewer | 2.70 | 27,000 |
| Referrer | 0.45 | 4,500 |
| Protocol | 1.35 | 13,500 |

The buy's execution price is the price discovery. Users can never be owed more
than revenue bought; old campaigns keep their locked rate while new campaigns
re-price at market. Earnings accrue per qualified view under the same 2-second
dwell and anti-fraud caps as today
([04-backend-adaptation.md](04-backend-adaptation.md)).

## Points — live from day one

Earning starts immediately; ad inventory is live from the start. Points accrue
on the existing append-only millicent ledger:

- **1,000 points = $1.00 of earned ad value** (1 point = 1 millicent — the
  ledger unit the backend already uses).
- Same 60/10/30 split, applied to dollar value.
- The $90 tranche per campaign is escrowed in the USDC reserve. A public page
  shows escrowed total vs. outstanding points.
- Points are non-transferable and can't be withdrawn before conversion
  ([05-legal-structure.md](05-legal-structure.md)).

## Conversion at the raise

1. **Snapshot** — points balances snapshot the moment the raise opens
   (announced at that moment, not before).
2. **Rate** — points convert at the raise price:
   `user AIAD = points ÷ 1,000 ÷ $0.001` → **1,000 points = 1,000 AIAD**.
   Same price the public paid; early users got theirs by watching ads.
3. **Source** — the 30% rewards bucket. Conversion touches neither the market
   nor the raise proceeds.
4. **Claims** — Solana Merkle distributor, wallet-linked account required.
5. Points earned between the snapshot and graduation convert the same way;
   after graduation, new campaigns pay live locked rates.
6. The escrowed USDC reserve moves into the Meteora pool as added liquidity.

## Business P&L

Protocol accrual valued at execution price — no appreciation assumed. The
protocol takes 30% of each pool (27% of gross; up to 36% on unreferred
traffic) plus the 5% fiat margin:

| Annual ad spend | Fiat margin | Protocol tokens (27% of gross) | Total at acquisition value |
|---|---|---|---|
| $100K | $5K | $27K | $32K |
| $1M | $50K | $270K | $320K |
| $5M | $250K | $1.35M | $1.6M |

A third stream on star.fun: the founder's 0.5% of all secondary trading
volume. The team allocation (20%, vested) is excluded from these tables and
from all public materials.

## Risks

- **Price volatility** — rates lock per campaign; value floats afterward. The
  portal shows token amounts and current USD estimates; cash-out via licensed
  partners is the user's stability valve.
- **Thin liquidity** — the raised USDC plus the escrowed reserve seed the
  pool; large campaign buys can be TWAPed if needed.
- **Wash-impression farming** — existing defenses carry over (server-issued
  impression tokens, 2s dwell, per-device/IP caps, FORGERY-SURFACE.md), plus
  payout requires a logged-in, wallet-linked account.
- **Windfall on old campaigns** — a campaign locked at a low price keeps its
  rich rate after price moves. Option: expire unspent inventory after ~30 days
  and re-buy at market.
- **Regulatory** — see [05-legal-structure.md](05-legal-structure.md).
