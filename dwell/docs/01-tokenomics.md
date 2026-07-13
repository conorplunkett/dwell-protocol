# DWELL tokenomics

DWELL runs two systems that are deliberately and permanently separate:

1. **dwells (points)** — earned by watching ads. Denominated in US dollars on
   the ledger, redeemable for **USDC** (to a linked wallet) or **Claude
   credits**. dwells never convert to $DWELL.
2. **$DWELL (token)** — an SPL token launched via a star.fun curated raise
   under the Bedrock legal framework. It carries **no equity, no revenue
   share, no redemption right, and no claim** on the company, the protocol,
   or the dwells ledger.

There is no bridge between the two. Ad revenue funds dwell payouts in USDC.
Ad revenue is **not** used to buy $DWELL.

> **Copy rule (every public surface):** describe the mechanics as facts. Never
> state or imply that the price will rise, that any flow is "price support,"
> or that holding is an investment. See
> [05-legal-structure.md](05-legal-structure.md) and
> [09-securities-framework.md](09-securities-framework.md).

## The advertiser dollar

Advertisers pay a fixed dollar CPM. Per $100 of card spend:

| Leg | Amount | Where it goes |
|---|---|---|
| Card processing (Stripe) | ~$2.50 | Stripe |
| Rewards pool | $87.75 | The campaign pool, split 60/10/30 below |
| Buffer for slippage | ~$2.50 | Jupiter/Meteora exchange slippage on SOL/$DWELL settlement |
| Advertiser fee | remainder | Protocol operations, in USD |

Advertisers paying in USDC (the non-custodial crypto checkout) skip the card
leg; the split is otherwise identical. Payments made in SOL or $DWELL are
held while the campaign is in review, then swapped to USDC at acceptance:
the campaign's funded dollar amount is the **realized USDC at acceptance
time**, so the effective CPM/impressions may differ from the checkout quote
(see [08-usdc-checkout.md](08-usdc-checkout.md)); a rejected campaign's held
SOL/$DWELL is refunded on-chain to the paying wallet. **No leg of any
payment, on any rail, buys $DWELL.**

### The pool split — 60 / 10 / 30

Each campaign's rewards pool splits by dollar value:

| Recipient | Share | Knob |
|---|---|---|
| Viewer | **60%** | `VIEWER_SHARE_BPS = 6000` (configurable 60–70%) |
| Viewer's referrer | **10%** | `REFERRER_SHARE_BPS = 1000` |
| Company | **30%** (40% when the viewer has no referrer) | remainder |

The referrer share is carved out of the pool, not paid on top. The company
share plus the 10% redemption fee are the business's revenue, in dollars.

## dwells (points)

- **1,000 dwells = $1.00 of earned ad value. Fixed.** A dwell is a
  dollar-denominated ledger credit, accrued per qualified view (same
  2-second dwell and anti-fraud caps as today,
  [04-backend-adaptation.md](04-backend-adaptation.md)).
- Redemption, two paths:
  - **USDC to a linked wallet** — face value less the **10% protocol fee**,
    $100 minimum. The offramp/transfer leg always belongs to licensed
    partners as counterparty of record
    ([05-legal-structure.md](05-legal-structure.md)).
  - **Claude credits** — redeemed at a **10% boost**: dwells buy Claude
    subscription time at 110% of their face value (the boost replaces the
    fee on this path; it is the closed-loop option and we make it the
    better deal on purpose).
- Outstanding dwells are unsecured obligations of the company. They are not
  backed by a segregated reserve, escrow, or any dedicated pool of assets.
- dwells are closed-loop reward credits until redeemed. They are not
  transferable between users, they are not $DWELL, and they never convert
  to $DWELL. There is no snapshot, no conversion price, and no airdrop
  claim attached to points.

## $DWELL (token)

| | |
|---|---|
| Name / symbol | DWELL |
| Chain | Solana (SPL token, minted by star.fun) |
| Supply | 1,000,000,000 — fixed, no mint authority after launch |
| Launch | star.fun curated raise; 5-day deposit window; full refund if the target is not met |
| Raise proceeds | Split per star.fun mechanics between pool liquidity, Bedrock/BVI incorporation costs, and the founder ✎ exact split from star |

### What the token is not

Stated once, plainly, and mirrored on every public surface:

- $DWELL is **not equity** and does not represent any share of, or claim on,
  the company. (See the Bedrock section below for what the structure
  actually does.)
- The company does **not** buy $DWELL with ad revenue and commits to no
  buybacks, burns, or distributions.
- $DWELL is **not redeemable** with the company for cash, USDC, dwells, ads
  previously purchased, or anything else.
- dwells never convert to $DWELL.

### What the token does

- **Pays for ad inventory.** Advertisers may pay for a campaign in $DWELL,
  priced at the USD campaign price via a spot quote at checkout. Tokens
  received this way go to the company treasury **and are held there** — the
  company does not route payments through the token or instantly sell
  received tokens (no manufactured volume). The campaign is otherwise
  identical to a USD-paid one: viewers earn dwells, denominated in dollars.
- **Trades.** 60% of supply plus raised USDC seed the Meteora DWELL/USDC
  pool at launch.

### Allocation

| Bucket | % | Notes |
|---|---|---|
| Initial liquidity | 60% | Seeds the Meteora DWELL/USDC pool alongside the raised USDC |
| Company treasury | 10% | Disclosed below |
| Structured sell orders | 10% | Single-sided sells that execute as market cap reaches preset levels |
| Team | 20% | star.fun vest: 3-mo cliff + 9-mo linear |

**Treasury disclosure and discipline.** The company treasury (this 10%
allocation plus any $DWELL received as ad payment) is a company asset. The
company **may sell treasury tokens**, and no "held, never sold" commitment
exists or should be implied anywhere. But discretion is bounded
([09-securities-framework.md](09-securities-framework.md)): treasury sales
happen only under a **pre-announced schedule or plan**, never while
promotional statements are running, and the first sale is gated on counsel
review — discretionary issuer selling into our own market is the LBRY fact
pattern, and disclosure alone does not cure it.

## The Bedrock structure

The raise runs under Bedrock (star.fun integration; Bedrock is a Meteora ×
GVRN venture — verified against bedrock.meteora.ag/learn). What that means,
precisely:

- On graduation and founder KYC, a **BVI company** is incorporated. An
  independent **Foundation takes 10–30% preference shares plus a golden
  share** on that company's cap table; the founder retains at least 70%
  ordinary shares and full operational control.
- The Foundation's rights activate only on **founder fraud, bad faith, or
  unauthorized value extraction** (e.g., selling the company while dumping
  the token). They do not activate on project failure or token price
  decline. Enforcement fund: up to US$2M.
- **Constitutional buyout mechanics:** a party holding 30%+ of token supply
  can trigger a mandatory buyout of remaining tokens at a 30% premium over
  the trailing 7-day TWAP; a party holding **100% of supply** may negotiate
  to acquire the Foundation's preference equity ("standing invitation to
  treat" — not a binding offer; accredited-investor + KYC/AML gated).

**The critical framing, which every public surface must get right:** the
Bedrock structure is a set of **constraints on the founder**, enforced by a
third-party shareholder. It confers **zero equity rights on token holders**.
Holding $DWELL gives you a token and the knowledge that the founder is
structurally penalized for rugging it. It does not give you a piece of the
company. Any copy that says or implies "the tokens represent X% of the
company" is wrong and must not ship.

## What changed from the previous version of this doc

For the record, since the repo history is public: earlier revisions of this
document described a 90% market-buy of $DWELL from every ad dollar,
campaign-locked token earn rates, points denominated in $DWELL, a fixed
points-to-token conversion at a stated company valuation, and tokens
"representing 8.3% of the company." All of that is removed. Points are
dollar-denominated and cash-settled in USDC or Claude credits; the token
receives no ad-revenue flows; the token represents no equity. Users who
earned points before this change are settled at face value (1,000 dwells =
$1.00) — no token claim exists or is grandfathered. Documents 05–08 are
revised to match.
