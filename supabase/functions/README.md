# Supabase Edge Functions — backend rewrite proof-of-concept

This directory is a **spike**, not the production backend. The live API is still
the Node `node:http` server in `server/`, deployed on Fly.io (`server/fly.toml`).

## Why this exists

We are evaluating moving the backend off Fly.io and onto **Supabase Edge
Functions** so the API lives on the same platform as the database (it already
runs on Supabase Postgres), is deployable via the Supabase MCP/CLI, and stays on
a free tier. Before committing to porting the money-handling routes, this POC
ports one read-only route end-to-end to prove out the hard parts:

- an Edge Function (Deno) reaching the production Postgres through the Supavisor
  pooler (`SUPABASE_DB_URL`, `prepare: false`), and
- reproducing our hand-written SQL and response shapes verbatim.

## What's here

- `web-referrals/` — a faithful port of `GET /v1/web/referrals` from
  `server/src/app.js` + `server/src/repo.js`. Same app-session-token auth, same
  SQL (`userForSession`, `getOrCreateReferralCode`, `referralStats`), same JSON
  response. Deployed with `verify_jwt=false` because it authenticates with our
  own `web_sessions` tokens, not Supabase JWTs.

## Calling it

```
GET https://<project-ref>.supabase.co/functions/v1/web-referrals
Authorization: Bearer <web-session-token>
```

(or `?session=<token>`). Returns 401 without a valid session — same as the Fly
route.

## If we proceed (notes for the full migration)

- **`server/src/repo.js`** ports almost verbatim — keep the SQL, swap the `pg`
  Pool for a pooled connection (`SUPABASE_DB_URL`, port 6543, `prepare:false`).
  The `pg_advisory_xact_lock` redemption guard (transaction-scoped) is compatible
  with transaction-mode pooling.
- **`server/src/app.js`** router → one Edge Function with internal routing, or
  one function per route group.
- **`server/src/ratelimit.js`** is in-memory with a `setInterval` sweep — Edge
  Functions are stateless/ephemeral, so this must move to Postgres (the per-IP /
  per-device caps already live in the DB).
- **Stripe webhook** → its own function with `verify_jwt=false` and raw-body
  signature verification.
- **`server/src/payouts.js`** (cron) → `pg_cron` or a scheduled Edge Function.
