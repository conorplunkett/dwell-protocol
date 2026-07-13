-- Production hotfix (applied 2026-07-12 via Supabase MCP as
-- "usdc_orders_payment_verifier_columns").
--
-- The admin transactions view (GET /v1/admin/transactions) was 500'ing because
-- dwell.usdc_orders on the deployed database was missing the payment-verifier
-- columns that server/db/schema.sql:598-602 adds — the table predated them and
-- the alters were never run against production. This brings the live schema in
-- line with schema.sql; idempotent, safe to re-run.

alter table dwell.usdc_orders add column if not exists payer_address text;               -- fee-payer wallet, recorded at verify time (refund destination)
alter table dwell.usdc_orders add column if not exists received_amount_raw numeric(78, 0); -- actual on-chain delta received (lamports / raw DWELL), from the verifier
alter table dwell.usdc_orders add column if not exists swap_signature text;              -- acceptance-time Jupiter swap transaction
alter table dwell.usdc_orders add column if not exists realized_micro_usdc bigint;       -- USDC actually received from that swap
alter table dwell.usdc_orders add column if not exists refund_signature text;            -- in-kind refund transaction on reject
