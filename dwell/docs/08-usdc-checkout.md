# USDC advertiser checkout — plan

> **Tokenomics v2 — IMPLEMENTED (2026-07-10).** The swap leg below is retired
> and the v2 flow is now the code: no leg of any payment buys $DWELL. Rails:
> **USDC** — two plain transfers in one atomic advertiser-signed transaction,
> the protocol-fee leg to `TREASURY_USDC_ATA` and the rewards-pool leg to
> `REVENUE_USDC_ATA`; **SOL** — the same two legs as native lamport transfers
> (`TREASURY_SOL_ACCOUNT`/`REVENUE_SOL_ACCOUNT`), priced from USD by a spot
> quote re-run per build; **$DWELL (post-launch)** — one transfer of the full
> payment to `TREASURY_DWELL_ATA` at a spot quote, held there
> ([01-tokenomics.md](01-tokenomics.md) ▸ What the token does), with a +10%
> impressions boost (`DWELL_PAY_BOOST_BPS`). USDC/SOL are live with **no
> dependency on the token existing**; only the $DWELL rail gates on
> `DWELL_MINT` + `TREASURY_DWELL_ATA` (its lander tab shows disabled with an
> "after token launch" tag). Email is optional on crypto rails (synthetic
> `@wallet.invalid` advertiser rows, never mailed). Campaigns fund on the
> dollar ledger exactly like card payments; viewers earn dollar-denominated
> dwells on every rail. The v1 swap-based design below is kept for the
> historical record — the code for it was removed (git history has it).

Crypto-native advertisers buy ad space in **USDC or SOL**, wallet-to-chain,
with **no funds ever held by our system**. The protocol takes the **same 10%
cut** as the card path; the other **90% is market-bought into $DWELL in the
advertiser's own transaction**; viewers earn DWELL points from the campaign
exactly as today.
Research date: July 2026 — re-verify provider pricing/APIs before integration.
Status: **scaffolded and gated** (2026-07-07). The full backend (both
`server/src` and the edge function), schema, tests, and lander UI are in the
tree; every `/v1/ads/usdc` route 404s until `DWELL_MINT` is configured — the
mint doesn't exist until the star.fun launch
([07-starfun-launch.md](07-starfun-launch.md)) — and the lander's "Pay with
USDC" button stays hidden behind the `USDC_CHECKOUT` flag in `web/script.js`.

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

### The SOL rail

The same order can be paid in **native SOL** (`currency: "sol"`). Pricing
stays in USD — the split, the ledger, the locked rate, and the points are
identical — and only the wallet-facing legs change:

1. the order's USD price is converted to lamports via a USDC→wSOL Jupiter
   quote, **re-priced on every transaction build** (like the slippage floor),
   so the wallet always approves a current number;
2. the 10% fee leg is a **system-program lamport transfer** to the treasury's
   SOL account (`TREASURY_SOL_ACCOUNT`; leaving it unset disables the rail
   with a 400 while USDC keeps working);
3. the 90% tranche swaps **wSOL → DWELL** (Jupiter wraps the payer's native
   SOL inside the same atomic transaction) into the distributor vault;
4. the verifier checks the treasury's **native lamport delta** from the
   runtime's pre/post balances instead of a USDC token delta — the DWELL-side
   check is unchanged.

### The $DWELL rail

Advertisers who already hold $DWELL can pay the ad budget **directly in $DWELL**
(`currency: "dwell"`) — the simplest rail, because there is no swap: the token
is already $DWELL. The atomic transaction is **two plain SPL transfers** of the
payer's own $DWELL (SPL `Transfer`, ix 3 — no decimals needed): 10% to the
treasury's DWELL account, 90% straight to the distributor vault, plus the memo
and reference key. Pricing works like SOL: a USDC→DWELL quote converts the USD
budget into $DWELL units, re-priced on every build. The verifier checks the
**treasury DWELL delta** (fee) and the **distributor DWELL delta** (the 90%,
which is exact — a direct transfer has no slippage).

The perk — the **"10% boost"** on the tab — is **+10% impressions for the same
spend** (`DWELL_PAY_BOOST_BPS`, default 1000): a $DWELL-paid campaign buys 10%
more reach. It applies to `impressions_total` only; the 90% rewards pool stays
sized to the actual $DWELL paid, so viewers collectively earn the same pool
over more impressions (a lower per-view locked rate) — pure extra reach, not a
subsidy of the viewer pool. Needs `TREASURY_DWELL_ATA` configured; unset
disables the rail (400) while USDC/SOL keep working.

The lander presents all three rails as a segmented slider in order — **Pay
with USDC/SOL** (default), **Pay with $DWELL** (badged "10% boost"), **Credit
card** — hidden behind the same `USDC_CHECKOUT` flag.

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
USDC path should eventually **review before payment**:

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

> **Scaffold note:** the landed scaffold reuses the card lifecycle
> (`pending_payment → pay → pending_review → active`) so no campaign status,
> admin approve flow, or admin UI had to fork while the surface is dark.
> Flipping to review-before-pay (the `approved_awaiting_payment` status above)
> is an enablement-gate task alongside setting `DWELL_MINT` — until then a
> rejected USDC campaign's refund is a treasury-multisig decision, documented
> below either way.

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
| Wallet connection | **Raw Wallet Standard handshake** (already shipped in `web/script.js` — discovers Phantom, Solflare, Backpack **and MetaMask**, which now ships native Solana accounts) | Privy (embedded wallets), Reown AppKit |
| Payment request format | **Solana Pay transaction-request spec** (open standard: QR / deeplink / wallet-native) | Plain connect-and-sign in the portal |
| RPC + tx detection | **Helius** (webhooks on the treasury/distributor ATAs, priority-fee API, staked tx landing) | QuickNode, Triton |
| Cross-chain entry (USDC on Base/Ethereum/Arbitrum) | **deBridge (DLN)** deep link → widget — fast, Solana-native, no wrapped assets (see § MetaMask below) | **Relay** (powers MetaMask's own in-wallet bridge); Mayan (Wormhole Swift); LI.FI if we want one aggregator API |
| Native USDC treasury moves | **Circle CCTP v2** (canonical burn-and-mint) | deBridge |
| Hosted checkout (only if we'd rather not build) | **Helio / MoonPay Checkout** (Solana Pay under the hood) | Sphere |
| Wallet screening (compliance, optional at launch) | **TRM Labs** API on the paying wallet | Chainalysis |
| Treasury / distributor | **Squads** multisig · Jito-lineage Merkle distributor | unchanged from [07-starfun-launch.md](07-starfun-launch.md) |

Why Jupiter and not a hosted checkout as the primary: no hosted product can
express "pay 10% here and atomically market-buy DWELL with the rest to a
third account" — that composition is exactly what `/swap-instructions` +
one prepended SPL transfer gives us, and it's the whole point of the design.

Cross-chain MVP is deliberately thin: deBridge delivers USDC to the
advertiser's own Solana wallet, then the normal checkout runs — the full
design is the next section.

## MetaMask & cross-chain entry (verified 2026-07-10)

Two different problems hide inside "accept MetaMask, cross-chain" — and the
first one is already solved by code in the tree.

### 1. MetaMask *is* a Solana wallet now — the direct rail is free

MetaMask ships **native Solana accounts** (extension ≥ 13.5, mobile ≥ 7.57:
every MetaMask account carries an EVM address *and* a Solana address side by
side) and announces them through the **Wallet Standard** two-event handshake —
the exact discovery mechanism the lander already runs, no SDK and no
MetaMask-specific code. A MetaMask user holding USDC or SOL **on Solana**
connects and signs the existing atomic checkout exactly like a Phantom user.

Enablement checks, small and one-time (fold into the `DWELL_MINT` /
`USDC_CHECKOUT` gate work):

- `pickWallet()` in `web/script.js` prefers Phantom, else takes the first
  discovered wallet — when more than one wallet announces itself, show a
  picker instead, so MetaMask+Phantom users choose explicitly.
- One devnet signature to confirm MetaMask's Wallet Standard feature set
  handles our legacy-encoded transaction via `solana:signAndSendTransaction`
  (MetaMask implements the standard but its docs don't enumerate features —
  same verify-with-a-real-wallet drill as the 2026-07-08 encoder check).
- MetaMask mobile is **mainnet-only** for Solana; devnet testing stays on the
  extension.

### 2. Funds on EVM chains — bridge with a third party, checkout unchanged

When the advertiser's money sits on Ethereum/Base/Arbitrum, we do **not**
build an EVM payment rail (no second verifier, no second treasury, no wrapped
assets). A third-party intent bridge tops up the *same wallet's* Solana
account, then the normal checkout runs:

```
MetaMask — USDC on Base/Ethereum/Arbitrum
   │  deBridge (DLN): dst = native USDC on Solana,
   │  recipient = the SAME MetaMask account's own Solana address,
   │  amount = order total + small buffer          (fills in ~1–4 s)
   ▼
the advertiser's MetaMask Solana account holds USDC
   ▼
normal checkout: one atomic advertiser-signed transaction   (unchanged)
```

The advertiser never changes wallets and never leaves the flow; we never
custody anything (the bridge's counterparty risk sits between the advertiser
and deBridge, not on us); the backend, verifier, and order lifecycle don't
change by a single line.

Integration is staged to match the repo's no-heavy-deps rule:

1. **MVP — prefilled deep link.** A "Bridge from another chain" link on the
   USDC panel opens `app.debridge.finance` with source/destination/token/
   amount prefilled via URL params. Zero third-party script on our page —
   same pattern as the Solana Pay link. The order poller already waits for
   payment, so the advertiser bridges, returns, and pays.
2. **Enhancement — embedded widget.** deBridge's widget builder emits an
   embeddable, themeable iframe (connects MetaMask on the EVM side natively,
   supports an affiliate-fee knob). Drop-in on the lander behind the same
   `USDC_CHECKOUT` flag once the deep-link flow proves demand.
3. **No-code fallback that always exists:** MetaMask's built-in Bridge tab
   (powered by Relay/LI.FI) moves EVM funds to the user's own Solana account
   without us shipping anything — checkout copy can say so.

Options considered (July 2026 — re-verify before integration):

| Option | Verdict |
|---|---|
| **deBridge DLN** — pick | Intent-based, Solana-native since day one, ~1–4 s fills, delivers **native** assets (no wrapped), deep link + widget + API, affiliate-fee knob |
| **Relay** — fallback | Payments-grade cross-chain infra; ~2.7 s median EVM→Solana; API + SwapWidget; powers MetaMask's own bridging — swapping it in later is low-friction |
| LI.FI | One aggregator API over many bridges incl. CCTP; more surface than this job needs |
| Mayan (Wormhole Swift) | Solid Solana-native alternate, kept from the earlier table |
| Circle CCTP v2 directly | The right primitive for **our own** treasury moves (canonical burn-and-mint), but checkout would need us to run attestation plumbing and gas on both chains — that's the bridge vendors' job |
| Hosted checkout (Helio/MoonPay, Sphere, Coinbase Commerce) | Rejected as primary: none can express the two-leg atomic design, all add a settlement counterparty, and Coinbase Commerce can't settle on Solana |

### V2 — one-signature bridge-and-pay (not launch-gating)

DLN **order hooks** (`dlnHook`) can attach a Solana instruction to the fill,
so a single MetaMask signature on Base could deliver USDC straight to the
treasury with the order's reference key riding in the hook — true one-click
cross-chain checkout for the plain-transfer (Phase 0 / points) rail. It needs
verifier work first: the fill transaction is signed by the DLN taker, not the
advertiser, so verification must key entirely off the hook-carried reference
and the runtime balance deltas (the deltas are already how the verifier
works). The two-step flow above is the MVP; this is the polish.

## Backend spec (landed — both backends in the same commit, per AGENTS.md)

Implemented in `server/src/solana.js` (RPC/Jupiter clients, legacy-transaction
encoder, read-only verifier — mirrored inline in the edge function),
`server/src/{app,repo,boot}.js`, `supabase/functions/dwell-api/index.ts`, and
covered by the `usdc checkout:` checks in `server/test/run.js`. Discovery is
verify-on-poll via the order's reference key (Solana Pay `findReference`); a
Helius webhook can shortcut the poll later without changing the contract.

New table (`server/db/schema.sql`, idempotent):

```sql
create table if not exists usdc_orders (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  price_micro_usdc bigint not null,          -- gross, 6-dp (USD pricing on every rail)
  fee_micro_usdc bigint not null,            -- the 10% treasury leg, USD value
  tranche_micro_usdc bigint not null,        -- the 90% swap leg (price - fee), USD value
  pay_currency text not null default 'usdc'  -- 'usdc' | 'sol'
    check (pay_currency in ('usdc', 'sol')),
  pay_total_units bigint not null,           -- what the wallet pays, base units (micro-USDC / lamports)
  pay_fee_units bigint not null,             -- the treasury leg the verifier enforces, base units
  quote jsonb not null,                      -- Jupiter swap quote at order/build time
  min_dwell_out numeric(78,0) not null,      -- slippage floor the verifier enforces
  reference_pubkey text unique not null,     -- Solana Pay reference key
  tx_signature text unique,
  status text not null default 'awaiting_signature'
    check (status in ('awaiting_signature','confirmed','expired','failed')),
  fail_reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

`token_campaign_pools` is reused as-is (`tx_hash` takes the Solana signature).
Routes — same public shape as the card `POST /v1/checkout`; verification is
read-only so **no signing keys enter the Edge Function**, per the existing
rule:

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/ads/usdc/orders` | public (like card checkout) | Create campaign + order (`currency: usdc\|sol`): exact 90/10 breakdown, Jupiter quote, TTL, `solana:` pay link |
| `POST /v1/ads/usdc/orders/:id/transaction` | Solana Pay (wallet posts `{account}`) | Build a fresh atomic unsigned tx (re-quotes; base64) |
| `GET /v1/ads/usdc/orders/:id/transaction` | public | Solana Pay metadata (`label`, `icon`) |
| `GET /v1/ads/usdc/orders/:id` | public (unguessable order id) | Status poller — runs `findReference` + verify → `token_campaign_pools` → campaign paid |

Config knobs (extend §C of
[04-backend-adaptation.md](04-backend-adaptation.md)): `SOLANA_RPC_URL`,
`HELIUS_API_KEY`, `JUPITER_BASE_URL`, `DWELL_MINT`, `USDC_MINT`
(`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` on mainnet),
`TREASURY_USDC_ATA`, `TREASURY_SOL_ACCOUNT` (optional — enables the SOL
rail), `DISTRIBUTOR_DWELL_ATA`, `MAX_SLIPPAGE_BPS` (reused),
`USDC_ORDER_TTL_MINUTES` (default 30). Gate: routes 404 unless `DWELL_MINT`
is set — mirroring the `TOKEN_MODE` gating style.

Web: the lander's ad form (`web/index.html` + `script.js`) has **Pay with
USDC** under the Stripe button — static vanilla JS per the repo rule, Solana
Pay link + copy first (no heavy wallet deps; QR and wallet-adapter connect are
enhancements for enablement). All colors via `theme.css` tokens. **Hidden for
now**: the button only renders when the `USDC_CHECKOUT` flag in `script.js` is
flipped, and the backend 404s regardless until `DWELL_MINT` is set.

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
| 1 | `DWELL_MINT` set (TGE) | Atomic pay+swap checkout, Solana wallets **incl. MetaMask via Wallet Standard** (+ wallet picker, devnet sign check), Helius verification, portal UI |
| 2 | Phase 1 stable | deBridge cross-chain entry (deep link → widget, § MetaMask above); TRM screening; hosted-checkout alternate if demand warrants |

## Verification (2026-07-08)

The transaction encoder is hand-rolled (no `@solana/web3.js` on the server —
it stays dependency-light), so it was validated end-to-end:

- **Encoder cross-checked against `@solana/web3.js`.** Feeding the built
  base64 into the real library's deserializer proved the message is
  byte-identical to its own `compileMessage` for both fee-leg shapes (native
  `SystemProgram` transfer and SPL `TransferChecked`), and that amounts decode
  exactly. This caught a real bug: the `MEMO_PROGRAM` constant was mistyped and
  decoded to 30 bytes, silently truncating every message so no wallet could
  parse it — the faked-fetch unit tests never deserialized the bytes, so they
  passed anyway. Fixed, plus a build-time guard that rejects any non-32-byte
  key so the whole class fails loud.
- **Real devnet landing + verification.** A fee-leg transaction built by the
  encoder was signed by a real wallet, **accepted and finalized by devnet
  validators**, then read back through the actual verifier: treasury lamport
  delta exact, reference key present, unknown signature rejected
  (`not_found`), and a real **underpayment rejected as `fee_short`** while the
  exact amount clears the fee check. Amounts are read from the runtime's own
  pre/post balances, never from client claims.
- **Not yet testable:** the Jupiter swap → DWELL leg and its distributor DWELL
  delta — nothing can route to a token that doesn't exist. That single leg
  runs for the first time when `DWELL_MINT` is set at launch; everything around
  it is verified.

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
  checkout page mechanics-as-facts. Cross-chain entry raises the stakes:
  bridged-in funds obscure provenance one hop further, so wallet screening
  moves from optional to strongly recommended the day the deBridge link
  ships.
