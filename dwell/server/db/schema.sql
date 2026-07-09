-- DWELL protocol — core schema (Postgres 14+)
-- Money rule: developers keep 90% of every dollar. The ledger is append-only;
-- balances are always derived from it, never stored.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_verified boolean not null default false,  -- proven via magic-link before payout
  stripe_account_id text unique,           -- Stripe Connect Express account
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- A device = one machine running the extension. Devices earn anonymously from
-- day one; linking to a user (for payout) can happen later.
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  key_hash text not null,                  -- sha256 of the device secret
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Single-use magic-link tokens for email verification.
create table if not exists email_tokens (
  token text primary key,
  email text not null,
  device_id uuid references devices(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists advertisers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);

-- One advertiser per email: a returning advertiser's campaigns all hang off the
-- same row (createPendingCampaign upserts on this). On existing databases the
-- 20260625 migration merges any pre-existing duplicates before adding this.
create unique index if not exists advertisers_email_key on advertisers (email);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  advertiser_id uuid not null references advertisers(id),
  brand text,
  ad_line text not null check (char_length(ad_line) between 3 and 60),
  url text not null check (url like 'https://%'),
  category text not null default 'other',
  -- Advertiser-chosen accent color for the ad line, "#rrggbb"; null falls back
  -- to a per-brand color in the client.
  color text check (color is null or color ~* '^#[0-9a-f]{6}$'),
  price_per_block_cents integer not null check (price_per_block_cents >= 50),  -- the CPM (price per 1,000 impressions); min $0.50
  blocks integer not null check (blocks > 0),                                  -- legacy display count; impressions_total is authoritative
  impressions_total integer not null,      -- exact impressions purchased (floor(budget*1000/cpm)); not necessarily a multiple of 1000
  impressions_remaining integer not null,
  budget_cents integer,                    -- exact amount charged (the advertiser's budget); null on pre-budget campaigns
  show_on_leaderboard boolean not null default true,
  -- lifecycle: pending_payment -> (paid) pending_review -> (approved) active
  --            -> exhausted; or rejected/cancelled.
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'pending_review', 'active', 'exhausted', 'rejected', 'cancelled')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,           -- captured for refunds on rejection
  review_note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  activated_at timestamptz
);

-- Backfill the color column on databases created before it existed.
alter table campaigns add column if not exists color text;
-- Exact charge (budget) for the budget+CPM checkout; older campaigns are null
-- and the funding code falls back to price_per_block_cents * blocks.
alter table campaigns add column if not exists budget_cents integer;
-- Set when the one-time "campaign finished" advertiser receipt has been emailed;
-- the send is guarded on this being null so a receipt goes out at most once.
alter table campaigns add column if not exists completion_email_sent_at timestamptz;

create index if not exists campaigns_auction_idx
  on campaigns (status, price_per_block_cents desc)
  where status = 'active';

-- Idempotency for event ingestion: each extension batch carries a unique key.
create table if not exists event_batches (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id),
  batch_key text not null unique,
  impressions integer not null default 0,
  clicks integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists event_batches_device_day_idx
  on event_batches (device_id, created_at);

-- Hashed source IP (an HMAC, never the raw address) recorded per batch. It backs
-- a per-IP daily impression cap that bounds farming across many anonymous
-- devices behind one host, and serves as a forensic key during the held-payout
-- review window. Added post-launch, so add-if-missing for existing databases.
alter table event_batches add column if not exists ip_hash text;
create index if not exists event_batches_ip_day_idx
  on event_batches (ip_hash, created_at);

-- Append-only money ledger. Amounts are in MILLICENTS (1/1000 cent) so a single
-- impression's 90% share is exact: $5 block -> 0.5c gross -> 450 millicents net.
create table if not exists ledger (
  id bigserial primary key,
  entry_type text not null check (entry_type in (
    'campaign_credit',     -- advertiser paid; campaign funded         (+ campaign)
    'campaign_refund',     -- rejected campaign refunded               (- campaign)
    'impression_credit',   -- developer's 90% share of an impression   (+ device)
    'click_credit',        -- legacy: developer's share of a 50x click (retired; see click_event below)
    'platform_fee',        -- our 10%                                  (+ platform)
    'payout_debit',        -- transferred to developer's bank          (- user)
    'gift_redemption_debit' -- redeemed for a Claude gift card         (- device)
  )),
  amount_millicents bigint not null,
  device_id uuid references devices(id),
  user_id uuid references users(id),
  campaign_id uuid references campaigns(id),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists ledger_device_idx on ledger (device_id);
create index if not exists ledger_user_idx on ledger (user_id);
-- Backs the per-campaign metric rollups (clicks / impressions-shown / spend),
-- which all filter the ledger by campaign + entry_type.
create index if not exists ledger_campaign_idx on ledger (campaign_id, entry_type);

-- Persistent admin key/value config (the ad-serving killswitch, advertiser pricing
-- knobs, and the completion-receipt auto-send switch). Mirrors the table created in
-- server/db/20260619_admin.sql so fresh and test databases have it too.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount_cents integer not null check (amount_cents > 0),
  stripe_transfer_id text unique,
  status text not null default 'paid' check (status in ('paid', 'failed')),
  created_at timestamptz not null default now()
);

-- Claude gift card redemptions. A redemption deducts the balance via a
-- gift_redemption_debit ledger entry; fulfillment (the actual gift card email to
-- the user) is manual and lands within 48 hours. Redemptions happen only on the
-- website after the user logs in, so they're scoped to a user (a device_id is
-- kept for older device-scoped redemptions).
create table if not exists gift_redemptions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references devices(id),
  user_id uuid references users(id),
  plan text not null check (plan in ('pro', 'max5x', 'max20x')),
  months integer not null check (months in (1, 3, 6, 12)),
  amount_cents integer not null check (amount_cents > 0),
  recipient_email text not null,
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);
-- device_id predates user-scoped (website) redemptions; allow either.
alter table gift_redemptions add column if not exists user_id uuid references users(id);
alter table gift_redemptions alter column device_id drop not null;

-- Website login sessions. The user proves email ownership via a magic link, and
-- the redemption page carries this bearer token to read the balance and redeem.
-- OAuth provider IDs (added post-launch for Google/Apple/X sign-in)
alter table users add column if not exists google_id text unique;
alter table users add column if not exists apple_id text unique;
alter table users add column if not exists twitter_id text unique;
-- First-login onboarding: the user posts a prebuilt DWELL note to their X
-- timeline (replacing the old refer-a-friend email gate). Self-attested — set
-- when the user confirms they posted. Accounts without it may not be paid out.
alter table users add column if not exists onboarding_posted_at timestamptz;

create table if not exists web_sessions (
  token text primary key,
  user_id uuid not null references users(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists web_sessions_user_idx on web_sessions (user_id);

-- Stripe retries webhooks; this makes processing exactly-once.
create table if not exists processed_webhook_events (
  event_id text primary key,
  type text,
  created_at timestamptz not null default now()
);

-- Server-side click verification. The extension asks for a single-use token
-- (authenticated by deviceKey), and the ad link points at /v1/go/:token.
-- Hitting it once records the click and redirects — so clicks can't be forged
-- by editing the ad URL or replaying it.
create table if not exists click_tokens (
  token text primary key,
  campaign_id uuid not null references campaigns(id),
  device_id uuid not null references devices(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Server-authoritative impressions. An impression is billable only when the
-- server actually SERVED that ad to that device (mint on /v1/impressions/serve),
-- and only ONCE (single-use at /v1/impressions/redeem after the qualifying
-- dwell). This closes the forged/inflated-count path that trusting the client's
-- self-reported /v1/events batch leaves open — the batch path stays live during
-- the client transition. Mirrors click_tokens; ip_hash + device_id back the
-- per-IP / per-device daily serve caps.
create table if not exists impression_tokens (
  token text primary key,
  campaign_id uuid not null references campaigns(id),
  device_id uuid not null references devices(id),
  ip_hash text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists impression_tokens_device_day_idx
  on impression_tokens (device_id, created_at);
create index if not exists impression_tokens_ip_day_idx
  on impression_tokens (ip_hash, created_at);

-- ── Referrals ──────────────────────────────────────────────────────────────
-- Every user gets a shareable referral_code (generated lazily). A new user may
-- be attributed to one referrer (referred_by), set only at first sign-in. When a
-- referred user completes their first gift-card redemption, the referrer earns a
-- one-time $20 credit, capped at 10 rewarded referrals per user.
alter table users add column if not exists referral_code text unique;
alter table users add column if not exists referred_by uuid references users(id);

-- The referral code is entered on the signup form, so it must travel with the
-- magic-link token from /v1/web/login through to user creation.
alter table email_tokens add column if not exists referral_code text;

-- Hashed source IP (HMAC, never the raw address) recorded per magic-link/login
-- token. Backs a per-IP daily cap on email sends so one host can't blast magic
-- links to many distinct addresses (a spam-cannon / sender-reputation abuse the
-- per-email cooldown alone doesn't stop). Added post-launch, so add-if-missing.
alter table email_tokens add column if not exists ip_hash text;
create index if not exists email_tokens_ip_day_idx
  on email_tokens (ip_hash, created_at);

-- One row per referred user. The status transition pending -> rewarded is the
-- idempotency guard that pays the referrer exactly once.
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references users(id),
  referred_user_id uuid not null references users(id) unique,
  status text not null default 'pending'
    check (status in ('pending', 'rewarded', 'capped', 'cancelled')),
  reward_millicents bigint not null default 0,
  rewarded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists referrals_referrer_idx on referrals (referrer_user_id);

-- Email invites a user sends from the dashboard. The status tells the story of
-- one invitation: 'sent' (the email went out — the "sent" indicator), 'joined'
-- (the friend signed up with the code — the "code used" indicator), 'rewarded'
-- (they redeemed and the referrer was paid). One invite per (referrer, email);
-- re-inviting the same address just refreshes sent_at. The referrals table above
-- stays the source of truth for money; this table only tracks outreach + the two
-- indicators, joined to a referral by the friend's email.
create table if not exists referral_invites (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references users(id),
  email text not null,
  code text not null,
  status text not null default 'sent'
    check (status in ('sent', 'joined', 'rewarded')),
  sent_at timestamptz not null default now(),
  joined_at timestamptz,
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (referrer_user_id, email)
);
create index if not exists referral_invites_referrer_idx on referral_invites (referrer_user_id);
create index if not exists referral_invites_email_idx on referral_invites (lower(email));

-- Full ledger entry-type set (extends the base CHECK above). Drop + re-add so
-- re-running is idempotent and existing databases pick up new values. This is the
-- authoritative list — mirrors production and server/db/20260706_dwell_token_mode.sql.
-- 'click_credit' is the retired 50x click credit (kept for history); verified
-- clicks now record a zero-value 'click_event' (analytics only, never billed).
-- The points_* / reserve / token types are written only when TOKEN_MODE is set
-- (the DWELL deployment; dwell/docs/04 §A) — a legacy DWELL database never
-- produces them, but the shared schema knows them.
alter table ledger drop constraint if exists ledger_entry_type_check;
alter table ledger add constraint ledger_entry_type_check check (entry_type in (
  'campaign_credit',       -- advertiser paid; campaign funded          (+ campaign)
  'campaign_refund',       -- rejected campaign refunded                (- campaign)
  'impression_credit',     -- developer's 90% share of an impression    (+ device)
  'click_credit',          -- legacy: developer's share of a 50x click (retired; kept for history)
  'click_event',           -- a verified click, recorded for analytics only (amount 0; never billed)
  'platform_fee',          -- our 10%                                   (+ platform)
  'payout_debit',          -- transferred to developer's bank           (- user)
  'gift_redemption_debit', -- redeemed for a Claude gift card           (- device)
  'referral_credit',       -- $20 bonus for a qualified referral         (+ user)
  'affiliate_credit',      -- 10% of an affiliated user's earnings       (+ user)
  'admin_credit',          -- manual balance adjustment up   (admin)    (+ user/device)
  'admin_debit',           -- manual balance adjustment down (admin)    (- user/device)
  'points_credit',           -- token mode: viewer's 60% of the reserve tranche   (+ device)
  'referral_points_credit',  -- token mode: referrer's 10%, carved from the pool  (+ user)
  'protocol_points_credit',  -- token mode: protocol's 30% (40% unreferred)       (+ platform)
  'reserve_allocation',      -- token mode: campaign's 90% tranche earmarked at payment (+ platform)
  'token_claim_debit'        -- live mode: entitlement moved into an onchain Merkle root (- user)
));

-- On-demand web payouts are debit-first: the balance is charged and a payouts
-- row created as 'pending' before the Stripe transfer fires, then flipped to
-- 'paid' or 'failed' (with a ledger reversal). Widen the original two-state
-- check so existing databases accept the intermediate state.
alter table payouts drop constraint if exists payouts_status_check;
alter table payouts add constraint payouts_status_check check (status in ('pending', 'paid', 'failed'));

-- ── Affiliates ───────────────────────────────────────────────────────────────
-- A separate, application-gated program (distinct from referrals). A user
-- applies to become an affiliate by submitting their social handles + follower
-- counts; an admin reviews and approves, which mints a shareable affiliate code.
-- When a user signs up with — or retroactively applies — an affiliate code, the
-- affiliate earns 10% of that user's ad earnings as platform-funded bonus credits
-- (affiliate_credit), accrued continuously up to a per-affiliate cap. Affiliate
-- and referral attribution are mutually exclusive on a given user.
create table if not exists affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) unique,   -- the applicant
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  code text unique,                                     -- minted on approval, null until then
  instagram_handle text,
  instagram_followers integer check (instagram_followers is null or instagram_followers >= 0),
  linkedin_handle text,
  linkedin_followers integer check (linkedin_followers is null or linkedin_followers >= 0),
  twitter_handle text,
  twitter_followers integer check (twitter_followers is null or twitter_followers >= 0),
  reward_bps integer not null default 1000,             -- the affiliate's cut, basis points (1000 = 10%)
  cap_millicents bigint not null default 100000000,     -- legacy dollar cap (no longer enforced; kept for archive)
  cap_people integer not null default 10,               -- the cap is now people-based: max attributed friends per affiliate
  credited_millicents bigint not null default 0,        -- running lifetime tally of credits earned (uncapped)
  review_note text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  -- any handle provided carries a follower count. (There is no "≥1 handle"
  -- constraint: the Chrome extension auto-enrolls every device-linked user as an
  -- approved affiliate with no socials — the self-serve "crew" path — while the
  -- admin application route still validates socials in code, parseAffiliateSocials.)
  constraint affiliates_followers_present check (
    (instagram_handle is null or instagram_followers is not null) and
    (linkedin_handle  is null or linkedin_followers  is not null) and
    (twitter_handle   is null or twitter_followers   is not null)
  )
);
create index if not exists affiliates_status_idx on affiliates (status);
-- Drop the legacy "at least one social handle" constraint on databases created
-- before self-serve enrollment, so handle-less auto-enrolled affiliates are valid.
alter table affiliates drop constraint if exists affiliates_handle_present;
-- The cap is now people-based (max attributed friends); add it for existing DBs.
alter table affiliates add column if not exists cap_people integer not null default 1000;

-- The affiliate this user is attributed to. Lives on users like referred_by, and
-- is mutually exclusive with it — a signup resolves to one or the other. Set at
-- signup or applied retroactively (referral codes can't be applied retroactively).
alter table users add column if not exists affiliate_id uuid references affiliates(id);

-- One row per attributed user (parallel to referrals); powers the affiliate's
-- "users referred" count. Unique on the user so attribution is one-time.
create table if not exists affiliate_attributions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references affiliates(id),
  affiliated_user_id uuid not null references users(id) unique,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_attributions_affiliate_idx on affiliate_attributions (affiliate_id);

-- ── Waitlists ────────────────────────────────────────────────────────────────
-- Users can join a waitlist to be notified when ads launch on a surface that
-- isn't live yet: the desktop app, the command line, the Chrome extension, and
-- the VS Code extension. The surfaces live in an enum-style reference table
-- (rather than a CHECK constraint) so adding a surface is a one-row INSERT, with
-- a human label and a display order, and no schema migration.
create table if not exists waitlist_surfaces (
  surface text primary key,
  label text not null,
  sort_order integer not null default 0
);
insert into waitlist_surfaces (surface, label, sort_order) values
  ('desktop',          'Ads on desktop',               1),
  ('command_line',     'Ads on the command line',      2),
  ('chrome_extension', 'Ads on the Chrome extension',  3),
  ('vscode_extension', 'Ads on the VS Code extension', 4)
on conflict (surface) do nothing;

-- One row per (user, surface) interest. The surface is a foreign key into the
-- enum table above, and the (user_id, surface) pair is unique so a re-signup is
-- a no-op; a single user may sit on several waitlists.
create table if not exists waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  surface text not null references waitlist_surfaces(surface),
  created_at timestamptz not null default now(),
  unique (user_id, surface)
);
create index if not exists waitlist_signups_user_idx on waitlist_signups (user_id);
create index if not exists waitlist_signups_surface_idx on waitlist_signups (surface);

-- ── First-login onboarding survey ───────────────────────────────────────────
-- Captured the first time a user signs in, before the refer-a-friend step:
-- which AI models they use and on which surfaces (both multi-select), plus an
-- optional free-text "other" surface. Stored as jsonb arrays so the same param
-- binding works across the Node (pg) and edge (postgres.js) drivers. One row per
-- user; the row's existence is the "survey done" signal /v1/web/me reports as
-- needsSurvey, gating the dashboard behind onboarding.
create table if not exists onboarding_surveys (
  user_id uuid primary key references users(id) on delete cascade,
  models jsonb not null default '[]'::jsonb,         -- e.g. ["claude","chatgpt"]
  surfaces jsonb not null default '[]'::jsonb,        -- e.g. ["browser_chrome","terminal"]
  surface_other text,                                 -- free text when "other" picked
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Pre-account email capture (launch waitlist) ─────────────────────────────
-- Bare email captures from the public landing pages — NO account, so this is
-- deliberately separate from waitlist_signups (which is keyed on a signed-in
-- user_id and tracks per-surface ad interest). One row per (email, kind):
-- 'earn' = "tell me when I can install and start earning"; kind is reserved so
-- other capture points (e.g. 'advertiser') can share the table later. Email is
-- normalized (lowercased/trimmed) by the API before insert, so the unique
-- (email, kind) makes a re-submit a no-op. source is a free-text hint of where
-- they signed up (page slug, e.g. 'index' or 'lander:gemini'); ip_hash is the
-- same HMAC(ip) the fraud caps use — never the raw IP.
create table if not exists email_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null default 'earn',
  source text,
  ip_hash text,
  created_at timestamptz not null default now(),
  unique (email, kind)
);
create index if not exists email_leads_kind_created_idx on email_leads (kind, created_at desc);

-- ── DWELL token mode (dwell/docs/04 §A) ────────────────────────────────────────
-- Shared schema for both deployments; only a TOKEN_MODE deployment writes to
-- these. Mirrors server/db/20260706_dwell_token_mode.sql.

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
  dwell_out_wei numeric(78, 0) not null,
  to_distributor_wei numeric(78, 0) not null,
  to_treasury_wei numeric(78, 0) not null,
  burned_wei numeric(78, 0) not null default 0,
  locked_rate_wei numeric(78, 0) not null,     -- dwell_out * viewer share / impressions_total
  tx_hash text unique not null,
  funded_at timestamptz not null default now()
);

-- Live mode: per-user cumulative entitlements per published root.
create table if not exists token_rewards (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  user_id uuid references users(id),
  wallet_address text not null,
  cumulative_dwell_wei numeric(78, 0) not null,
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

-- ── USDC advertiser checkout (dwell/docs/08) ────────────────────────────────
-- Non-custodial pay-and-swap: the backend builds ONE atomic Solana transaction
-- (10% USDC fee to the treasury + 90% Jupiter-swapped into DWELL straight to
-- the distributor vault) and the advertiser signs it from their own wallet.
-- One row per payment attempt window; the campaign stays pending_payment until
-- the finalized transaction is verified read-only against this row's amounts.
-- Routes 404 unless DWELL_MINT is configured (the token doesn't exist yet).
create table if not exists usdc_orders (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  price_micro_usdc bigint not null,           -- gross charge, 6-dp USDC units (USD pricing on every rail)
  fee_micro_usdc bigint not null,             -- the 10% treasury leg (10000 - RESERVE_TRANCHE_BPS), USD value
  tranche_micro_usdc bigint not null,         -- the 90% swap leg (price - fee, keeps micro exactness), USD value
  -- Pay rail: 'usdc' pays the fee as a USDC token transfer; 'sol' pays it as a
  -- native lamport transfer and the swap leg runs wSOL -> DWELL. pay_*_units
  -- are in the pay currency's base units (micro-USDC / lamports); for SOL they
  -- re-price on every transaction build, like min_dwell_out.
  pay_currency text not null default 'usdc' check (pay_currency in ('usdc', 'sol', 'dwell')),
  pay_total_units bigint not null,            -- what the wallet pays in total, pay-currency base units
  pay_fee_units bigint not null,              -- the treasury leg the verifier enforces, pay-currency base units
  quote jsonb not null,                       -- Jupiter swap quote at order/build time
  min_dwell_out numeric(78, 0) not null,      -- slippage floor the verifier enforces (raw token units)
  reference_pubkey text unique not null,      -- Solana Pay reference key, detection + join handle
  tx_signature text unique,                   -- set when the finalized transaction verifies
  status text not null default 'awaiting_signature'
    check (status in ('awaiting_signature', 'confirmed', 'expired', 'failed')),
  fail_reason text,                           -- verifier's reason when status = 'failed'
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists usdc_orders_campaign_idx on usdc_orders (campaign_id);

