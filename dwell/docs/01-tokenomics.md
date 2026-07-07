# DWELL tokenomics

DWELL pays people for their attention. Advertisers buy ad impressions for fixed
dollar prices; 90% of every ad dollar is converted into DWELL and split between
the person who watched the ad, the person who referred them, and the protocol.
No minting, no emissions schedule, no oracle.

> **Copy rule (every public surface):** describe the mechanics as facts. Never
> state or imply that the price will rise, that buys are "price support," or
> that holding is an investment. See [05-legal-structure.md](05-legal-structure.md).

## Token facts

| | |
|---|---|
| Name / symbol | DWELL |
| Chain | Solana (SPL token, minted by star.fun) |
| Supply | 1,000,000,000 — fixed, no mint authority after launch |
| Equity | The 1B tokens collectively represent **8.3% of the company** |
| Launch | star.fun curated raise at a **$1M company valuation**; total target ~$115K: ~$50K founder proceeds, ~$65K pool liquidity, ~$7.5K BVI setup ✎ exact split from star |
| Raise mechanics | 5-day deposit window; full refund if the target isn't met |
| Points conversion price | Fixed at the $1M valuation: **$0.0000833/DWELL** (1B tokens = 8.3% of $1M = $83.3K) — set in advance, independent of where the pool opens |

The EVM contracts in `../contracts` remain the reference implementation; on
Solana the same roles are filled by a Jupiter buy-keeper, a Merkle distributor,
and a Squads treasury ([07-starfun-launch.md](07-starfun-launch.md)).

### Allocation

| Bucket | % | Notes |
|---|---|---|
| Initial liquidity | 60% | Seeds the Meteora DWELL/USDC pool alongside the raised USDC |
| Ad-rewards airdrop | 10% | Points conversion at launch + launch boosts |
| Structured sell orders | 10% | Single-sided sells that execute as market cap reaches preset levels |
| Team | 20% | star.fun vest: 3-mo cliff + 9-mo linear |

There is no discrete treasury bucket — the protocol treasury self-builds from
its 30–40% share of every campaign buy (below).

## The advertiser dollar

Advertisers pay a **fixed dollar CPM** by card. Per $100 of ad spend:

| Leg | Amount | Where it goes |
|---|---|---|
| Card processing (Stripe) | ~$2.50 | Stripe |
| Provider fees (USD→USDC, swap, gas) | ~$2.50 | Coinbase / DEX / network |
| Business margin (fiat) | $5.00 | The operating company |
| **Token side** | **$90.00** | Points phase: earmarked to the token side on the protocol ledger. Live: market-buys DWELL immediately |

Knob: `RESERVE_TRANCHE_BPS = 9000`. An advertiser paying in USDC directly
skips the card leg, pushing ~$97.50 to the token side.

## The pool split — 60 / 10 / 30

The $90 tranche (points: its dollar value; live: the tokens it bought) splits:

| Recipient | Share | Knob |
|---|---|---|
| Viewer | **60%** | `VIEWER_SHARE_BPS = 6000` |
| Viewer's referrer | **10%** | `REFERRER_SHARE_BPS = 1000` |
| Protocol treasury | **30%** (40% when the viewer has no referrer). **Held, never sold.** | remainder |

The referrer share is carved out of the pool, not paid on top. The protocol
share is the business's second revenue stream alongside the 5% fiat margin.

## Campaign-locked rate — the core mechanism

There is no "earn rate" to set. When a campaign's payment clears (live phase),
the $90 is market-bought into DWELL via Jupiter, and:

```
locked rate = tokens the buy received ÷ impressions the campaign bought
```

**Worked example.** A $100 campaign at a $10 CPM buys 10,000 impressions. The
$90 buy executes at $0.002/DWELL → 45,000 DWELL. Locked rate = 4.5 DWELL per
qualified view:

| | DWELL per view | of the 45,000 pool |
|---|---|---|
| Viewer | 2.70 | 27,000 |
| Referrer | 0.45 | 4,500 |
| Protocol | 1.35 | 13,500 |

The buy's execution price *is* the price discovery. Users can never be owed
more value than revenue bought. Old campaigns keep their locked rate while new
campaigns re-price at market. Earnings accrue per qualified view — same
2-second dwell and anti-fraud caps as the existing platform
([04-backend-adaptation.md](04-backend-adaptation.md)).

## Points — live from day one

Users earn **DWELL points** from day one; ad inventory is live from launch.
Points sit on the existing append-only millicent ledger:

- How many points a view earns is set by the ad's dollar value at earn time
  (the ledger accrues your 60% share of the campaign's $90 tranche, 1 point
  per millicent). Same 60/10/30 split.
- **Points are denominated in DWELL, not dollars.** A point is not a dollar
  claim and there is no cash reserve behind it: 1,000 points convert to
  12,000 DWELL at launch, and what that DWELL is worth floats with the
  market — down to zero. Dollar figures shown anywhere are estimates at the
  current market price.
- The $90 tranche per campaign is earmarked to the token side on the protocol
  ledger; a public accounting page shows the earmarked total vs. outstanding
  points.
- Points are non-transferable until token launch
  ([05-legal-structure.md](05-legal-structure.md)).

## Conversion at the raise

When the raise opens, the points ledger is snapshotted (snapshot time
announced at the snapshot, not before):

1. Points convert at a **fixed rate set by the $1M valuation**
   ($0.0000833/DWELL): **1,000 points = 12,000 DWELL** — announced in advance
   and independent of where the pool opens.
2. Converted tokens come from the **10% ad-rewards airdrop**, so conversion is
   instant at token launch — no waiting on market buys.
3. Claims go through a Solana Merkle distributor, gated on wallet-linked
   accounts. The root and a per-user lookup are published on the portal.
4. The earmarked token-side funds move into the Meteora pool as added
   liquidity.
5. Once the pool is live, new campaigns switch to live buy-and-distribute at
   campaign-locked rates.

Capacity note: the 100M-token airdrop covers **8.33M points** (100M ÷ 12 per
point, ≈ $8.3K of ad value at earn rates); outstanding points at the snapshot
must stay under that, with the rest of the bucket left for launch boosts.
Plenty for a day-one seed — track the ledger total against it.

## Redemptions

Once the token is live, points redeem three ways, each valued at the market
price at the moment of redemption:

1. **Withdraw as $DWELL** to a linked Solana wallet (Merkle claim).
2. **Claude credits** — the corresponding DWELL is sold at redemption and the
   proceeds fund the credits.
3. **Cash via Stripe payouts** — same mechanic: the corresponding DWELL is
   sold at redemption and the proceeds are paid out (Stripe Connect; users
   receive 1099s at $600+/yr).

Two structural rules keep the company flat on price:

- Every cash-denominated redemption is **hedged by selling the corresponding
  DWELL at the same time** — the protocol never owes more than the sale
  raised, at any token price.
- **Withdrawn tokens are never bought back.** Once $DWELL is in a user's
  wallet, the exit is the open market. Cash-out is a feature of points, not
  of the token — that keeps the payout flow a rewards program, not an
  exchange.

## Business / owner P&L

Revenue at three annual ad-spend levels. Protocol-token accrual is valued at
acquisition price — no appreciation assumed:

| Annual ad spend | Fiat margin (5%) | Protocol tokens (30–40% of pool, held) | Total at acquisition value |
|---|---|---|---|
| $100K | $5K | $27–36K | $32–41K |
| $1M | $50K | $270–360K | $320–410K |
| $5M | $250K | $1.35M–1.8M | $1.6M–2.05M |

The range depends on the referred/unreferred mix. The treasury holds — this is
balance-sheet accrual, not sell-side income. A third stream is the **founder's
0.5% of all secondary trading volume**, paid by star.fun. The team allocation
(20%, vested) is excluded from these tables and from all public materials.

## Risks

- **Price volatility**: earnings lock per campaign; value floats afterward.
  The portal shows token amounts and current USD estimates; the redemption
  paths (Claude credits or Stripe payout, valued at market price at
  redemption) are the user's stability valve.
- **Thin liquidity**: mitigated by the 60%-of-supply liquidity seed plus the
  earmarked token-side funds added at conversion; a $90 instant buy against a
  $25K pool moves price ~0.7%, against $5K it whipsaws.
- **Wash-impression farming**: server-authoritative impression tokens, 2s
  dwell backstop, per-device and per-IP daily caps (FORGERY-SURFACE.md), plus
  payout requires a logged-in, wallet-linked account.
- **Regulatory**: see [05-legal-structure.md](05-legal-structure.md); the
  copy rules and facts-only raise page are the primary mitigations.
- **Windfall on old campaigns**: a campaign locked at a low price keeps paying
  "many" tokens after price moves. Mitigation if wanted: expire unspent
  campaign inventory after ~30 days and re-buy at current price.
