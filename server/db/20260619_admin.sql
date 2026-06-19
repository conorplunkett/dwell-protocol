-- Admin dashboard migration
-- 1) Manual balance adjustments need two new ledger entry types.
-- 2) A persistent key/value settings table backs the cross-isolate killswitch.
--
-- Both are idempotent so re-running is safe (matches the schema.sql conventions).

-- ── 1) ledger entry types: admin_credit / admin_debit ───────────────────────
-- Drop + re-add the CHECK so existing databases pick up the new values, the
-- same pattern used when referral_credit was introduced (see schema.sql).
alter table ledger drop constraint if exists ledger_entry_type_check;
alter table ledger add constraint ledger_entry_type_check check (entry_type in (
  'campaign_credit',       -- advertiser paid; campaign funded         (+ campaign)
  'campaign_refund',       -- rejected campaign refunded               (- campaign)
  'impression_credit',     -- developer's share of an impression       (+ device)
  'click_credit',          -- developer's share of a click (50x)       (+ device)
  'platform_fee',          -- our cut                                  (+ platform)
  'payout_debit',          -- transferred to developer's bank          (- user)
  'gift_redemption_debit', -- redeemed for a Claude gift card          (- device)
  'referral_credit',       -- $20 bonus for a qualified referral        (+ user)
  'admin_credit',          -- manual balance adjustment up   (admin)   (+ user/device)
  'admin_debit'            -- manual balance adjustment down (admin)   (- user/device)
));

-- ── 2) settings: persistent key/value (e.g. the ad-serving killswitch) ──────
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
