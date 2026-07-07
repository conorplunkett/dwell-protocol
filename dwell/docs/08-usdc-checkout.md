# USDC advertiser checkout — plan

Crypto-native advertisers buy ad space in USDC, wallet-to-chain, with **no
funds ever held by our system**. The protocol takes the **same 10% cut** as the
card path; the other **90% is market-bought into $DWELL in the advertiser's own
transaction**; viewers earn DWELL points from the campaign exactly as today.
Research date: July 2026 — re-verify provider pricing/APIs before integration.
Status: **plan only** — implementation follows once the DWELL mint address
exists on Solana ([07-starfun-launch.md](07-starfun-launch.md)).

> Copy rules apply unchanged ([05-legal-structure.md](05-legal-structure.md)):
> mechanics as facts, no price talk. The checkout page says what the
> transaction does; it never suggests the buy moves the price.

## The core idea — the advertiser's signature does the work

On the card path, a keeper must move fiat → USDC → DWELL after Stripe clears.
On the USDC path there is nothing to keep: the backend **constructs one atomic
Solana transaction and the advertiser signs it from their own wallet**. That
single transaction:

1. transfers **10%** of the price in USDC to the protocol treasury (Squads
   vault) — the business margin, same cut as the card path;
2. swaps **90%** USDC → DWELL via a Jupiter route (slippage-guarded
   `minOut`), with the swap output delivered **directly to the rewards
   distributor vault** — never to a company hot wallet;
3. carries a unique **reference key + memo** tying it to the order.

Either the whole transaction lands or none of it does. The backend never
signs, never custodies the advertiser's USDC, and never touches the bought
DWELL in flight — it only *verifies* the confirmed transaction and then
activates the campaign. The card path's buy-keeper job simply does not exist
here: the advertiser's signature replaces it.

Custody boundary, stated precisely: the only protocol-held assets are the
same ones the architecture already holds — the DWELL rewards pool in the
distributor and the treasury in Squads ([02-architecture.md](02-architecture.md)
▸ Key custody). No advertiser USDC and no user funds ever sit on our keys.

## The advertiser dollar (USDC path)

Per $100 of ad spend, versus the card column in
[01-tokenomics.md](01-tokenomics.md):

| Leg | Card path | USDC path |
|---|---|---|
| Card processing | ~$2.50 | — |
| Provider fees | ~$2.50 (USD→USDC, swap, gas) | swap fee + gas, paid inside the same tx (<$0.50 typical) |
| Business margin | $5.00 fiat | **$10.00 USDC to treasury** |
| Token side | $90.00 (keeper-bought) | **$90.00 (advertiser-signed Jupiter buy)** |

Knobs: `RESERVE_TRANCHE_BPS = 9000` (unchanged); the treasury leg is the
`10000 − RESERVE_TRANCHE_BPS` remainder, so the two paths share one config.
The 60/10/30 viewer/referrer/protocol split of the pool, the campaign-locked
rate (`dwellOut × 60% ÷ impressions`), and the points pipeline are all
unchanged — the USDC path only replaces *how the $90 becomes DWELL*.

Note this supersedes the "~$97.50 to the token side" sketch in
[03-service-providers.md](03-service-providers.md) § Optional: the decision is
a flat **90/10 on every path** — one split, one story, no per-rail pricing.

## Order lifecycle

The card path reviews creatives *after* payment because Stripe can refund.
Onchain there is no refund rail that doesn't mean treasury outflow, so the
USDC path **reviews before payment**:

```
draft ──▶ pending_review ──▶ approved_awaiting_payment ──▶ active ──▶ exhausted
                (admin)            │
                                   │  advertiser clicks Pay:
                                   │   1. POST order → price locked, quote fetched, order TTL 30 min
                                   │   2. POST transaction → backend builds unsigned tx
                                   │      (fresh Jupiter route + blockhash, valid ~60s; rebuild on retry)
                                   │   3. wallet signs & submits
                                   │   4. backend verifies the finalized tx → token_campaign_pools row
                                   │      → markCampaignPaid → active
                                   └─ order expires unsigned → nothing happened onchain, no cleanup
```

Verification (read-only, idempotent by tx signature, `finalized` commitment):

- the tx contains the order's reference key;
- treasury USDC ATA delta ≥ the fee leg;
- distributor DWELL ATA delta = `dwellOut` ≥ `minOut`
  (`minOut = quote × (1 − MAX_SLIPPAGE_BPS/10000)`);
- amounts match the order; payer identity is *not* required to match — anyone
  may fund an approved order (it's a payment, not an authorization).

Failure modes: swap reverts on slippage → whole tx fails, advertiser retries
with a fresh build; quote moves beyond `MAX_SLIPPAGE_BPS` between order and
build → re-quote and show the new number; tx never signed → order expiry.
Post-activation refunds are a treasury-multisig decision, policy-exceptional.

## Points

Nothing changes in the earning loop
([04-backend-adaptation.md](04-backend-adaptation.md) §B). The verified
`dwellOut` writes `token_campaign_pools` (the `tx_hash` column takes the
Solana signature; the `wei` columns hold base units — SPL 6/9 dp fits the
existing `numeric` types), the locked rate prices every qualified view, and
the ledger accrues `points_credit` / `referral_points_credit` /
`protocol_points_credit` at the same 60/10/30. The treasury's 30–40% leg
settles through the existing **treasury shortfall leaf** in the Merkle root,
so the swap output needs only **one** onchain destination — no second
transfer instruction, no keeper co-signature inside the advertiser's tx.

## Providers (Solana first, cross-chain next)

Extends the [03-service-providers.md](03-service-providers.md) star.fun
column; one pick per job, named fallback.

| Job | Pick | Fallback |
|---|---|---|
| Swap quote + tx composition | **Jupiter Swap API** (`/quote` + `/swap-instructions`) | Direct Meteora pool route (single pool, zero external dep) |
| Wallet connection | **Privy** (already picked; Solana external + embedded wallets) | Reown AppKit, or raw Wallet Standard adapter |
| Payment request format | **Solana Pay transaction-request spec** (open standard: QR / deeplink / wallet-native) | Plain connect-and-sign in the portal |
| RPC + tx detection | **Helius** (webhooks on the treasury/distributor ATAs, priority-fee API, staked tx landing) | QuickNode, Triton |
| Cross-chain entry (USDC on Base/Ethereum/Arbitrum) | **deBridge (DLN)** widget/API — fast, Solana-native, no wrapped assets | Mayan (Wormhole swift); LI.FI if we want one aggregator API |
| Native USDC treasury moves | **Circle CCTP v2** (canonical burn-and-mint) | deBridge |
| Hosted checkout (only if we'd rather not build) | **Helio / MoonPay Checkout** (Solana Pay under the hood) | Sphere |
| Wallet screening (compliance, optional at launch) | **TRM Labs** API on the paying wallet | Chainalysis |
| Treasury / distributor | **Squads** multisig · Jito-lineage Merkle distributor | unchanged from [07-starfun-launch.md](07-starfun-launch.md) |

Why Jupiter and not a hosted checkout as the primary: no hosted product can
express "pay 10% here and atomically market-buy DWELL with the rest to a
third account" — that composition is exactly what `/swap-instructions` +
one prepended SPL transfer gives us, and it's the whole point of the design.

Cross-chain MVP is deliberately thin: the deBridge widget delivers USDC to
the advertiser's own Solana wallet, then the normal checkout runs. A later
V2 can use DLN order hooks to make bridge-and-pay one action; not a launch
requirement.

## Backend spec (implements later, both backends in the same commit)

New tables (`server/db/schema.sql` + dated migration):

```sql
create table usdc_orders (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  price_micro_usdc bigint not null,          -- gross, 6-dp
  fee_micro_usdc bigint not null,            -- the 10% treasury leg
  tranche_micro_usdc bigint not null,        -- the 90% swap leg
  quote jsonb not null,                      -- Jupiter quote at order time
  min_dwell_out numeric(78,0) not null,
  reference_pubkey text unique not null,     -- Solana Pay reference key
  tx_signature text unique,
  status text not null default 'awaiting_signature'
    check (status in ('awaiting_signature','submitted','confirmed','expired','failed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

`token_campaign_pools` is reused as-is. Routes (added to `server/src/app.js`
and the edge function; verification is read-only so **no signing keys enter
the Edge Function**, per the existing rule):

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/ads/usdc/orders` | advertiser session | Create order for an approved campaign: price breakdown, Jupiter quote, TTL |
| `POST /v1/ads/usdc/orders/:id/transaction` | advertiser session | Build a fresh unsigned tx (Solana Pay transaction-request shape, base64) |
| `GET /v1/ads/usdc/orders/:id` | advertiser session | Order status for the checkout page poller |
| webhook / poller | Helius signature | Verify finalized tx → `token_campaign_pools` → `markCampaignPaid` |

Config knobs (extend §C of
[04-backend-adaptation.md](04-backend-adaptation.md)): `SOLANA_RPC_URL`,
`HELIUS_API_KEY`, `JUPITER_BASE_URL`, `DWELL_MINT`, `USDC_MINT`
(`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` on mainnet),
`TREASURY_USDC_ATA`, `DISTRIBUTOR_DWELL_ATA`, `MAX_SLIPPAGE_BPS` (reused),
`USDC_ORDER_TTL_MINUTES` (default 30). Gate: routes 404 unless `DWELL_MINT`
is set — mirroring the `TOKEN_MODE` gating style.

Web: the portal's advertiser tab gets **Pay with USDC** beside the card
button — static vanilla JS per the repo rule, Solana Pay QR + deeplink first
(no heavy wallet deps), wallet-adapter connect as the enhancement. All colors
via `theme.css` tokens.

## Optional Phase 0 — USDC before the token exists

The points phase already has the accounting for this
(`usdc_reserve_entries`, `reserve_allocation`): a plain USDC transfer to the
treasury vault (100% in one instruction, reference-keyed), 90% earmarked on
the ledger, campaign live, points accrue. No swap leg — there is nothing to
buy yet. Worth shipping only if a crypto-native advertiser shows up before
TGE; otherwise skip straight to Phase 1.

## Rollout

| Phase | Gate | Scope |
|---|---|---|
| 0 (optional) | now | USDC transfer → ledger earmark, review-before-pay lifecycle |
| 1 | `DWELL_MINT` set (TGE) | Atomic pay+swap checkout, Solana wallets, Helius verification, portal UI |
| 2 | Phase 1 stable | deBridge cross-chain entry; TRM screening; hosted-checkout alternate if demand warrants |

## Risks

- **Thin pool, big order**: a large `swapAndFund`-style buy against early
  Meteora depth can exceed `MAX_SLIPPAGE_BPS` and the tx will simply fail to
  build/land. Cap single-order size relative to pool depth; split large
  campaigns into tranches.
- **Quote staleness**: order TTL 30 min but each built tx is only valid
  ~60s (blockhash) — the build step always re-quotes; the advertiser sees
  the final number in their wallet before signing.
- **MEV/sandwich on the swap leg**: Jupiter slippage bound is the backstop;
  Jito-bundled submission via Helius is available if it ever matters at our
  sizes.
- **Verification bugs = free campaigns**: the verifier must check mint,
  destination ATA, and amount deltas from the *parsed finalized tx*, not from
  client claims; idempotency by signature; covered by server tests against
  recorded fixtures.
- **Compliance**: the paying wallet is a counterparty — screening (TRM) is
  cheap insurance before accepting large orders; the copy rules keep the
  checkout page mechanics-as-facts.
