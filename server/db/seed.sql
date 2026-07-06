-- DWELL.fyi — seed one live entry. DEV/LOCAL ONLY — never run against the
-- production database: the seeded campaign is funded with fiat ledger money,
-- and every credit users earn from it is a real payout liability for you.
-- Inserts a single active campaign so /v1/ads and /v1/leaderboard return one row
-- on a fresh database. Safe to re-run (fixed ids + on conflict / not-exists guards).
-- Edit the brand / ad_line / url below, or delete this file once real campaigns
-- exist. Amounts: price_per_block_cents >= 100 ($1.00), 1 block = 1,000 impressions.

insert into advertisers (id, email)
values ('00000000-0000-0000-0000-0000000000a1', 'ads@dwell-protocol.vercel.app')
on conflict (id) do nothing;

insert into campaigns (
  id, advertiser_id, brand, ad_line, url, category, color,
  price_per_block_cents, blocks, impressions_total, impressions_remaining,
  show_on_leaderboard, status, paid_at, activated_at
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000a1',
  'DWELL',
  'DWELL — get Claude for free with ads.',
  'https://dwell-protocol.vercel.app',
  'other',
  '#d97757',
  500, 10, 10000, 10000,
  true, 'active', now(), now()
) on conflict (id) do nothing;

-- Fund the seeded campaign on the ledger (price_per_block_cents * blocks, in
-- millicents), mirroring what markCampaignPaid records for a real payment.
-- Serving requires paid_at AND the ledger should always show the backing money.
insert into ledger (entry_type, amount_millicents, campaign_id, meta)
select 'campaign_credit', 5000000, '00000000-0000-0000-0000-0000000000c1',
       '{"seed": true, "impressions": 10000}'::jsonb
where not exists (
  select 1 from ledger
   where campaign_id = '00000000-0000-0000-0000-0000000000c1'
     and entry_type = 'campaign_credit'
);
