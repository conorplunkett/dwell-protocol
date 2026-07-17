-- Season points schema — Robinhood Chain launch exploration.
-- See ../POINTS.md. NOT applied anywhere; do not run against the live
-- project before the plan clears its decision gates (../README.md).
--
-- Conventions follow the existing dwell-api schema: uuid PKs, append-only
-- ledger with an idempotency key, jsonb meta, fk's to users/devices/
-- campaigns/referrals. Airdrop points are a separate ledger from `ledger`
-- (dwells): same transaction, different table, no shared balance.

create table airdrop_seasons (
    id              uuid primary key default gen_random_uuid(),
    season_number   int not null unique check (season_number between 1 and 5),
    -- earning window
    starts_at       timestamptz not null,
    snapshot_at     timestamptz not null,
    -- distribution
    pool_tokens     numeric(38, 0) not null,  -- base units (18 decimals), 60M * 1e18
    merkle_root     text,                     -- 0x… once published
    onchain_season_id int,                    -- SeasonMerkleDistributor season id
    claim_opens_at  timestamptz,
    claim_deadline  timestamptz,              -- claim_opens_at + 3 months, mirrors chain
    status          text not null default 'pending'
        check (status in ('pending', 'earning', 'snapshotting', 'appeal', 'claiming', 'closed')),
    created_at      timestamptz not null default now(),
    check (snapshot_at > starts_at)
);

-- Append-only. Every point award is one row; balances are sums. The ingest
-- path writes this in the same transaction as the dwells `ledger` row for
-- the underlying qualified view, with the same idempotency discipline.
create table season_points_events (
    id              uuid primary key default gen_random_uuid(),
    season_id       uuid not null references airdrop_seasons(id),
    user_id         uuid not null references users(id),
    kind            text not null check (kind in (
        'view_base',            -- 1 pt per qualified view
        'first_view',           -- 10 pts, lifetime one-time
        'surface_unlock',       -- 15 pts, one-time per surface (meta.surface)
        'milestone_views',      -- 1000/5000 pts (meta.threshold: 100 | 1000)
        'referral_activated',   -- 100 pts when referee hits 25 qualified views
        'advertiser_first_campaign', -- counsel-gated, see POINTS.md
        'advertiser_spend',          -- counsel-gated: 1 pt / $1 accepted
        'advertiser_milestone',      -- counsel-gated
        'adjustment'            -- signed manual correction, meta.reason required
    )),
    points          bigint not null,  -- signed; negative only for 'adjustment'
    -- provenance
    device_id       uuid references devices(id),
    campaign_id     uuid references campaigns(id),
    referral_id     uuid references referrals(id),
    meta            jsonb not null default '{}',
    idempotency_key text not null unique,
    created_at      timestamptz not null default now()
);

create index on season_points_events (season_id, user_id);
create index on season_points_events (user_id, kind);

-- One-time bonuses enforced by the database, not by application memory.
-- Lifetime one-timers: first_view once per user ever.
create unique index season_points_first_view_once
    on season_points_events (user_id) where kind = 'first_view';
-- One unlock per surface per user (surface in meta).
create unique index season_points_surface_once
    on season_points_events (user_id, (meta ->> 'surface')) where kind = 'surface_unlock';
-- One milestone per threshold per user.
create unique index season_points_milestone_once
    on season_points_events (user_id, (meta ->> 'threshold')) where kind = 'milestone_views';
-- One activation bonus per referral row.
create unique index season_points_referral_once
    on season_points_events (referral_id) where kind = 'referral_activated';

-- Referral cap (50 counted per season) is enforced in the awarding
-- transaction: count existing referral_activated rows for (user, season)
-- `for update` before insert — same pattern as the existing REFERRAL_CAP
-- check in dwell-api.

create view season_points_balances as
select season_id, user_id, sum(points)::bigint as points
from season_points_events
group by season_id, user_id;

-- Written once when a season is snapshotted; the claim UI reads proofs from
-- here. Rebuilding from season_points_events must reproduce these rows
-- exactly — publish both so anyone can verify.
create table season_snapshots (
    season_id       uuid not null references airdrop_seasons(id),
    user_id         uuid not null references users(id),
    points          bigint not null,
    excluded        boolean not null default false,
    exclusion_reason text,                 -- fraud flag class; null unless excluded
    wallet_address  text,                  -- claim wallet at snapshot; null = unlinked
    token_amount    numeric(38, 0),        -- base units; floor(pool * points / total)
    merkle_index    int,
    merkle_proof    jsonb,                 -- array of 0x… siblings
    created_at      timestamptz not null default now(),
    primary key (season_id, user_id)
);

create index on season_snapshots (season_id, wallet_address);
