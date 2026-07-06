# Backend adaptation guide

How the parent-repo backend becomes the AIAD backend. This is a
**specification, not applied code** — nothing in the main repo is modified by
the `aiad/` folder until this lands. Per the decision in
[06-launch-checklist.md](06-launch-checklist.md), the changes below land in
the **shared** backend code, gated by config: with the defaults, the FreeAI
deployment is behavior-identical to today (two-way split, no token
machinery); the AIAD deployment enables points mode via env. One codebase,
two deployments against **separate databases** — runtime separation is
absolute even though the code is common. As always, every change must land in
**both** backends in the same commit (AGENTS.md rule): the reference Node
server (`server/src/`, tested in CI) and the production Supabase Edge
Function (`supabase/functions/api/index.ts`), with `server/db/schema.sql`
staying the schema authority.

The good news: the money core is already right. Balances are derived from an
append-only millicent ledger, never stored; earning is server-authoritative
(impression tokens, dwell backstop, daily caps). AIAD adds entry types, a few
tables, one split change, and two keeper jobs.

## A. Schema changes (`server/db/schema.sql` + a dated migration)

### `users` — wallet linking (live mode)

Alongside the existing `stripe_account_id`:

```sql
alter table users
  add column wallet_address   text unique,
  add column wallet_provider  text check (wallet_provider in ('privy', 'external')),
  add column wallet_linked_at timestamptz;
```

### Ledger entry types

Append to the `entry_type` CHECK constraint (currently at
`server/db/schema.sql:290-303`; use the same drop-and-re-add idempotent
pattern the existing migrations use):

| New entry type | Sign | Meaning |
|---|---|---|
| `points_credit` | + device | Viewer's 50% of the campaign's 90% tranche, in millicents (points). Successor to `impression_credit`. |
| `referral_points_credit` | + user | Referrer's 15%. Successor to `affiliate_credit`, but carved out of the pool, not platform-funded. |
| `protocol_points_credit` | + platform | Protocol's 35% (or 50% when the viewer is unreferred). Successor to `platform_fee`. |
| `reserve_allocation` | + platform | The campaign's 90% tranche earmarked into the USDC reserve at payment (points mode). Accounting mirror of `campaign_credit`. |
| `token_claim_debit` | − user | Live mode: points/AIAD entitlement moved into an onchain Merkle root. `meta: {epoch, aiad_wei, root}`. |

Invariants (extend the existing balance rules):

- Balances remain `SUM(ledger)`, never stored (unchanged).
- Points mode: `SUM(reserve_allocation)` = USDC reserve balance (daily
  attestation job; drift halts campaign approvals).
- Per campaign: `points_credit + referral_points_credit +
  protocol_points_credit` ≤ its `reserve_allocation` (equality when exhausted).

### New tables

```sql
-- Points mode: one row per escrow movement; feeds the public reserve page.
create table usdc_reserve_entries (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id),
  amount_micro_usdc bigint not null,          -- 6-dp USDC units
  direction text not null check (direction in ('escrow', 'release', 'tge_buy')),
  external_ref text,                          -- Coinbase transfer id / tx hash
  created_at timestamptz not null default now()
);

-- Live mode: mirror of CampaignFunded events — the locked-rate source of truth.
create table token_campaign_pools (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid unique references campaigns(id),
  usdc_in_micro bigint not null,
  aiad_out_wei numeric(78, 0) not null,
  to_distributor_wei numeric(78, 0) not null,
  to_treasury_wei numeric(78, 0) not null,
  burned_wei numeric(78, 0) not null default 0,
  locked_rate_wei numeric(78, 0) not null,     -- aiad_out * viewer share / impressions_total
  tx_hash text unique not null,
  funded_at timestamptz not null default now()
);

-- Live mode: per-user cumulative entitlements per published root.
create table token_rewards (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  user_id uuid references users(id),
  wallet_address text not null,
  cumulative_aiad_wei numeric(78, 0) not null,
  leaf_hash text not null,
  unique (epoch, wallet_address)
);

-- Live mode: mirror of Claimed events.
create table token_claims (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  amount_wei numeric(78, 0) not null,
  cumulative_wei numeric(78, 0) not null,
  tx_hash text unique not null,
  claimed_at timestamptz not null default now()
);
```

The **treasury shortfall leaf**: onchain, every campaign pool sends a fixed 65%
to the Distributor, but unreferred viewers mean the protocol is owed more than
its onchain 35%. The root publisher includes the treasury address as a leaf
whose cumulative amount is exactly that accumulated surplus, so Distributor
balance = sum of all leaves and the books close.

## B. The split — the one behavioral change to the earning loop

Today `redeemImpression()` does a two-way split at `server/src/repo.js:941-943`
(mirrored in the edge function):

```js
const gross = BigInt(price_per_block_cents);              // millicents per impression
const dev   = (gross * BigInt(Math.round(revenueShare * 1000))) / 1000n;
const fee   = gross - dev;
```

AIAD replaces it with a three-way BPS split **of the 90% tranche**:

```js
const gross = BigInt(price_per_block_cents);                    // millicents
const pool  = (gross * BigInt(config.reserveTrancheBps)) / 10000n;  // the 90%
const viewer   = (pool * BigInt(config.viewerShareBps)) / 10000n;   // 50% of pool
const referrer = hasReferrer ? (pool * BigInt(config.referrerShareBps)) / 10000n : 0n;
const protocol = pool - viewer - referrer;                      // 35% or 50%; remainder keeps millicent exactness
```

Ledger writes: `points_credit` (viewer, +device), `referral_points_credit`
(referrer, +user — only when attributed), `protocol_points_credit` (+platform).
The same change applies to the legacy batch path (`ingestBatch()`,
`repo.js:659-661`).

**Retired in AIAD**: the `creditAffiliate()` platform-funded 10% bonus
(`repo.js:188-214`, called at `repo.js:957` and from `ingestBatch`). The
referral 15% replaces it *inside* the split. The affiliate attribution
machinery (codes, `affiliate_attributions`, crew UI) is reused as-is — only the
reward computation moves.

## C. Config knobs (extend `loadConfig` in `server/src/boot.js`, same style)

| Env var | Default | Meaning |
|---|---|---|
| `TOKEN_MODE` | `points` | `points` or `live` — the phase switch. In `points`, wallets/claims are disabled; everything else runs. |
| `VIEWER_SHARE_BPS` | `5000` | Viewer's share of the pool |
| `REFERRER_SHARE_BPS` | `1500` | Referrer's share (skipped when unreferred) |
| `RESERVE_TRANCHE_BPS` | `9000` | Tranche of gross routed to the token side |
| `BURN_BPS` | `0` | Slice of the treasury leg burned by CampaignFunder |
| `MAX_SLIPPAGE_BPS` | `100` | Keeper aborts a swap when the 0x quote implies worse |
| `AIAD_TOKEN_ADDRESS` / `REWARDS_DISTRIBUTOR_ADDRESS` / `CAMPAIGN_FUNDER_ADDRESS` | — | Base contract addresses (live) |
| `BASE_RPC_URL` | — | Base JSON-RPC endpoint |
| `ZEROX_API_KEY` | — | 0x Swap API (quotes + routes) |
| `COINBASE_API_KEY` / `COINBASE_API_SECRET` | — | Advanced Trade: USD→USDC, reserve custody |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | — | Embedded wallets (email-based, exportable) |
| `ROOT_SETTER_PRIVATE_KEY` / `KEEPER_PRIVATE_KEY` | — | **Keeper-process env only — never the Edge Function.** |

Startup assert: `VIEWER_SHARE_BPS + REFERRER_SHARE_BPS ≤ 10000`.

## D. Endpoints (added to `server/src/app.js` + the edge fn, existing conventions)

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/web/wallet` | web session | Link/replace wallet. Privy: verified server-side via Privy API. External: verify an EIP-191 signature over a server nonce. Live mode only. |
| `GET /v1/web/points/summary` | web session | Points balance, USD equivalent, today/month/lifetime — portal balance card. |
| `GET /v1/web/token/claim-proof` | web session | Latest `(cumulativeAmount, proof[])` for the user's wallet from `token_rewards`. Live mode only. |
| `GET /v1/reserve` | public | Reserve attestation: escrowed USDC vs. outstanding points. |
| `GET /v1/token/pools` | public | Funded campaign pools + locked rates (from `token_campaign_pools`). |
| `POST /v1/admin/epochs/publish-root` | admin key | Trigger the root publisher out-of-band (normally cron). |

**Deprecated but left running** (hidden from copy, per the parent repo's
playbook): gift-card redemption (`POST /v1/web/redemptions`), Stripe Connect
onboarding (`/v1/connect/onboard`), and the `payouts.js` sweep.

## E. Keeper jobs (new `keeper/` process — Node, dependency-light, cron)

These need signing keys and third-party APIs, so they run as a separate cron'd
process colocated with `server/` conventions — **not** inside the Edge Function.

1. **Fiat sweeper** — on `checkout.session.completed`: compute the tranche;
   points mode → Stripe payout → Coinbase USD→USDC → reserve account, write
   `usdc_reserve_entries` + `reserve_allocation`; live mode → USDC to Base →
   `CampaignFunder.swapAndFund(campaignId, tranche, minOut, zeroExCalldata)`.
2. **Root publisher** (live, weekly): snapshot accrued AIAD per wallet (+ the
   treasury shortfall leaf) → build cumulative tree (leaf =
   `keccak256(bytes.concat(keccak256(abi.encode(address, cumulative))))`,
   OZ-sorted pairs) → write `token_rewards` → `setRoot(root, epoch+1, total)`.
3. **Indexer** (live): `CampaignFunded` → `token_campaign_pools`; `Claimed` →
   `token_claims`; waits for Base finality before writing.

## F. Rollout

| Phase | `TOKEN_MODE` | What users see | What runs |
|---|---|---|---|
| Points (launch) | `points` | Points balance, reserve page, referral 15% | Ledger + reserve escrow only — no chain, no wallets |
| TGE window | `points` | "Token launch in progress" banner | Contracts deploy, liquidity seeds, reserve executes TWAP buys, points snapshot → first root |
| Live | `live` | Wallet linking, claims, cash-out via partners | Everything above + keeper jobs 2–3 |

Anti-fraud note: the existing caps (`DAILY_IMPRESSION_CAP`,
`IP_DAILY_IMPRESSION_CAP`, dwell backstop, impression tokens) carry over
unchanged and matter more once rewards are liquid; additionally, claims require
a logged-in account with a linked wallet — anonymous devices accrue but cannot
claim, mirroring today's "leaked deviceKey can accrue but never cash out"
design.
