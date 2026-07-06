-- Drop the default affiliate people-cap from 1,000 to 10 (post-launch migration).
--   The self-serve "crew" path enrolls every earner as a base-10% affiliate with
--   the column default cap. We're tightening that default so a new self-serve
--   affiliate can attribute at most 10 friends (matching the extension's crew
--   slots); influencer upgrades still set their own higher/uncapped value.
--
-- Idempotent so re-running is safe; the same default lives in schema.sql.

-- 1) New self-serve affiliates get 10 going forward.
alter table affiliates alter column cap_people set default 10;

-- 2) Bring existing self-serve affiliates (still on the old 1,000 default) down to
--    10. Admin-granted upgrades are uncapped (100k+), so a cap of exactly 1,000 is
--    only ever the old self-serve default — safe to retarget.
update affiliates set cap_people = 10 where cap_people = 1000;
