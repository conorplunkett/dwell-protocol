-- AIAD token mode (aiad/docs/04 §A) — shared schema, two deployments.
--
-- Adds the token-mode surface to the shared backend: five ledger entry types
-- (the three-way points split, the reserve earmark, and the live-mode claim
-- debit), wallet-linking columns on users, and the four token tables. A legacy
-- FreeAI deployment never writes any of this — the split only runs when
-- TOKEN_MODE is set — but the shared schema knows it, so one schema serves
-- both databases. Idempotent; the same final state lives in schema.sql.

-- Ledger entry types: widen the CHECK. Pure relaxation — every existing row
-- already passes — so NOT VALID + VALIDATE keeps the lock light on the hot
-- ledger table, same pattern as 20260625_remove_click_50x.sql.
alter table ledger drop constraint if exists ledger_entry_type_check;
alter table ledger add constraint ledger_entry_type_check check (entry_type in (
  'campaign_credit',
  'campaign_refund',
  'impression_credit',
  'click_credit',
  'click_event',
  'platform_fee',
  'payout_debit',
  'gift_redemption_debit',
  'referral_credit',
  'affiliate_credit',
  'admin_credit',
  'admin_debit',
  'points_credit',           -- token mode: viewer's 60% of the reserve tranche   (+ device)
  'referral_points_credit',  -- token mode: referrer's 10%, carved from the pool  (+ user)
  'protocol_points_credit',  -- token mode: protocol's 30% (40% unreferred)       (+ platform)
  'reserve_allocation',      -- token mode: campaign's 90% tranche earmarked at payment (+ platform)
  'token_claim_debit'        -- live mode: entitlement moved into an onchain Merkle root (- user)
)) not valid;
alter table ledger validate constraint ledger_entry_type_check;

-- Wallet linking (live mode). Alongside the existing stripe_account_id.
alter table users add column if not exists wallet_address text unique;
alter table users add column if not exists wallet_provider text
  check (wallet_provider in ('privy', 'external'));
alter table users add column if not exists wallet_linked_at timestamptz;

-- Points mode: one row per escrow movement; feeds the public reserve page.
-- Written by the fiat-sweeper keeper (Coinbase transfers), never by the API.
create table if not exists usdc_reserve_entries (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id),
  amount_micro_usdc bigint not null,          -- 6-dp USDC units
  direction text not null check (direction in ('escrow', 'release', 'tge_buy')),
  external_ref text,                          -- Coinbase transfer id / tx hash
  created_at timestamptz not null default now()
);
create index if not exists usdc_reserve_entries_campaign_idx on usdc_reserve_entries (campaign_id);

-- Live mode: mirror of CampaignFunded events — the locked-rate source of truth.
create table if not exists token_campaign_pools (
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
create table if not exists token_rewards (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  user_id uuid references users(id),
  wallet_address text not null,
  cumulative_aiad_wei numeric(78, 0) not null,
  leaf_hash text not null,
  unique (epoch, wallet_address)
);

-- Live mode: mirror of Claimed events.
create table if not exists token_claims (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  amount_wei numeric(78, 0) not null,
  cumulative_wei numeric(78, 0) not null,
  tx_hash text unique not null,
  claimed_at timestamptz not null default now()
);
