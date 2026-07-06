# DWELL tokenomics

DWELL pays people for their attention. Advertisers buy ad impressions for fixed
dollar prices; 90% of every ad dollar is converted into DWELL on the open market
and split between the person who watched the ad, the person who referred them,
and the protocol. Users are only ever paid tokens that ad revenue already
bought — no minting, no emissions schedule, no oracle.

> **Copy rule (applies to every public surface):** describe the mechanics as
> facts. Never state or imply that the token's price will rise, that buys are
> "price support," or that holding is an investment. See
> [05-legal-structure.md](05-legal-structure.md).

## Token facts

| | |
|---|---|
| Name / symbol | DWELL |
| Chain | Base (Ethereum L2) |
| Standard | ERC-20 + EIP-2612 permit |
| Supply | 1,000,000,000 (fixed — minted once at deploy, no mint function exists) |
| Decimals | 18 |
| Burnable | Yes (`ERC20Burnable`); `BURN_BPS` defaults to 0 — no burn promises |

### Initial allocation (starting point — final numbers set with counsel at TGE)

> **star.fun path:** this table is superseded by the platform's fixed preset —
> **60% public sale / 20% team (3-mo cliff + 9-mo vest) / 20% liquidity** — if
> the token launches there. Rewards are unaffected (they're bought on the open
> market, never drawn from an allocation), and the protocol treasury
> self-builds from its 35–50% share of every campaign buy. See
> [07-starfun-launch.md](07-starfun-launch.md).

| Bucket | % | Notes |
|---|---|---|
| Community / earn-side incentives | 35% | Launch boosts, early-supporter conversion sweeteners, future programs |
| Issuer treasury (ops) | 30% | Liquidity top-ups, partnerships, long-term runway; publicly disclosed address |
| Team | 20% | 4-year vest, 1-year cliff, disclosed; never sold into protocol buys without a pre-announced 10b5-1-style plan |
| Liquidity seed | 15% | DWELL/USDC pool on Aerodrome or Uniswap v4; target $25–100K+ initial depth |

## The advertiser dollar

Advertisers pay a **fixed dollar CPM** by card, exactly like the existing ad platform today.
Per $100 of ad spend:

| Leg | Amount | Where it goes |
|---|---|---|
| Card processing (Stripe) | ~$2.50 | Stripe |
| Provider fees (USD→USDC conversion, swap, gas) | ~$2.50 | Coinbase / DEX / network |
| Business margin (fiat) | $5.00 | The operating company |
| **Token side** | **$90.00** | Points phase: escrowed in the USDC reserve. Live phase: market-buys DWELL immediately |

Knob: `RESERVE_TRANCHE_BPS = 9000`. An advertiser paying in USDC directly
(optional later) skips the card leg, pushing ~$97.50 to the token side.

## The pool split — 60 / 10 / 30

The $90 tranche (points: its dollar value; live: the tokens it bought) splits:

| Recipient | Share of pool | Knob |
|---|---|---|
| Viewer (the person who watched the ad) | **60%** | `VIEWER_SHARE_BPS = 6000` |
| Viewer's referrer | **10%** | `REFERRER_SHARE_BPS = 1000` |
| Protocol treasury | **30%** (or **40%** when the viewer has no referrer — the unclaimed referrer leg joins it). **Held, never sold.** | remainder — keeps integer math exact |

The referrer share is carved **out of the pool**, not paid on top (this differs
from the existing platform's affiliate program, which pays a platform-funded 10% bonus).
The protocol share **accrues to the protocol treasury** — it is the business's
second revenue stream alongside the 5% fiat margin. `BURN_BPS` (default 0) can
route a fraction of the treasury leg to burn; leaving it 0 is deliberate.

## Campaign-locked rate — the core mechanism (live phase)

There is no "earn rate" to set. When a campaign's payment clears, the $90 is
market-bought into DWELL immediately, and:

```
locked rate = tokens the buy received ÷ impressions the campaign bought
```

**Worked example.** A $100 campaign at a $10 CPM buys 10,000 impressions. The
$90 buy executes at $0.002/DWELL → 45,000 DWELL. Locked rate = 4.5 DWELL per
qualified view, split per view:

| | DWELL per view | of the 45,000 pool |
|---|---|---|
| Viewer | 2.70 | 27,000 |
| Referrer | 0.45 | 4,500 |
| Protocol | 1.35 | 13,500 |

Properties: the buy's execution price *is* the price discovery (no oracle);
users can never be owed more value than revenue bought; old campaigns keep
their locked rate while new campaigns re-price at current market; earnings
accrue instantly per qualified view (same 2-second dwell + anti-fraud caps as
the existing platform — see [04-backend-adaptation.md](04-backend-adaptation.md)).

## Phase 1 — points (launch now)

No token exists at launch. Users accrue **DWELL points** on the existing
append-only millicent ledger:

- **1,000 points = $1.00 of earned ad value** (1 point = 1 millicent — points
  *are* the ledger unit the existing backend already uses).
- Same 60/10/30 split of the 90% tranche, applied to dollar value.
- The $90 tranche per campaign is **escrowed in the USDC reserve** — points are
  visibly 1:1 dollar-backed. A public reserve page shows escrowed total vs.
  outstanding points.
- Points are non-transferable and cannot be withdrawn — which keeps the points
  phase outside money-transmission statutes and defers users' taxable events
  (see [05-legal-structure.md](05-legal-structure.md)).

## Phase 2 — TGE (token generation event)

Gate criteria live in [06-launch-checklist.md](06-launch-checklist.md). At TGE:

1. DWELL deploys; liquidity seeds; contracts from this repo go live (audited).
2. The USDC reserve executes market buys over a published schedule (e.g. TWAP
   over N days to limit impact).
3. Outstanding points convert **pro-rata at the aggregate execution price**:
   `user DWELL = user points ÷ total points × total DWELL bought by the reserve`
   (applied per split bucket, so viewer/referrer/protocol legs stay exact).
4. New campaigns switch to campaign-locked rates in DWELL units; claims go
   onchain via the MerkleRewardsDistributor.

## Supply dynamics — the honest math

Buy-and-distribute means the maximum sell pressure users can ever generate is
bounded by the share they were given. Per $100 of ad spend at a given price:

- Market buy: **+$90.00**
- Maximum user-side sell: 70% of the pool ≈ **−$63.00** (viewer 60% +
  referrer 10%), and only if *every* recipient sells immediately
- The protocol's 30% is **held by the treasury and never sold** — it exits
  circulation for practical purposes; unreferred traffic pushes it to 40%

| Immediate-sell rate | Net market flow per $100 |
|---|---|
| 0% (everyone holds) | +$90.00 |
| 25% | +$74.25 |
| 50% | +$58.50 |
| 75% | +$42.75 |
| 100% (everyone dumps) | **+$27.00** (+$36.00 on unreferred traffic) |

Net demand is structurally positive at every dump rate — the floor case is
+30% of gross ad spend — because the protocol's held tranche and the fee legs
never recycle onto the market. Every dollar of ad spend removes at least
$0.27 of DWELL from circulation into the treasury. What this does **not** guarantee: price stability
against thin liquidity, external sellers, or sentiment. Which is why liquidity
depth ($25–100K+ seed) matters more than any of the above at small scale.

## Business / owner P&L

Three revenue scenarios (annual ad spend), showing both revenue streams.
Protocol-token accrual is valued at acquisition (execution) price — no
appreciation assumed:

| Annual ad spend | Fiat margin (~5% net of the 10% gross) | Protocol tokens (30–40% of the pool, held) | Total at acquisition value |
|---|---|---|---|
| $100K | $5K | $27–36K | $32–41K |
| $1M | $50K | $270–360K | $320–410K |
| $5M | $250K | $1.35M–1.8M | $1.6M–2.05M |

(The range depends on the referred/unreferred mix — unreferred viewers push
the treasury share from 30% to 40% of the pool. The treasury **holds**; it is
balance-sheet accrual, not sell-side income.) On the star.fun path a third stream exists:
the **founder's 0.5% of all secondary trading volume**, paid by the platform
([07-starfun-launch.md](07-starfun-launch.md)). The team allocation (20%, vested) is the
equity-like upside on top; it is deliberately excluded from these tables and
from all public materials.

## Risks

- **Price volatility**: earnings are awarded at a locked per-campaign rate;
  their value floats afterward. The portal shows both token amounts and current
  USD estimates, and the cash-out path (DWELL→USDC via licensed partners) is the
  user's stability valve.
- **Thin liquidity**: the reserve's TWAP buy schedule and the liquidity seed are
  the mitigations; a $90 instant buy against a $25K pool moves price ~0.7%,
  against $5K it whipsaws.
- **Wash-impression farming**: a liquid reward raises fraud stakes. The
  existing defenses carry over: server-authoritative impression tokens, 2s
  dwell backstop, per-device and per-IP daily caps (see FORGERY-SURFACE.md in
  the main repo) — plus payout requires a logged-in, wallet-linked account.
- **Regulatory**: see [05-legal-structure.md](05-legal-structure.md); the
  points-first sequencing and the copy rules are the primary mitigations.
- **Windfall on old campaigns**: a campaign locked at a low price keeps paying
  "many" tokens after price moves. Mitigation if wanted: expire unspent
  campaign inventory after ~30 days and re-buy at current price.
