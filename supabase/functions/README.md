# Supabase Edge Functions — the FreeAI backend

The production API runs here, as Supabase Edge Functions (Deno), on the same
platform as the database. This replaced the Node `node:http` server that was
deployed on Fly.io. The Node implementation is kept in `server/` as the tested
reference + rollback (the Edge port mirrors its routes and SQL verbatim).

## Functions

- **`api/`** — the whole API, ported from `server/src/*` into one function.
  Served under the slug `api`, so the public base is
  `https://<ref>.supabase.co/functions/v1/api` and routes arrive as `/api/v1/…`
  (the slug prefix is stripped, then the original paths are matched). Uses
  `npm:pg` against `SUPABASE_DB_URL` (the Supavisor pooler) so the data layer is
  a near-verbatim copy of `server/src/repo.js` — same transactions, same
  `pg_advisory_xact_lock` redemption guard, same millicent BigInt math.
- **`web-referrals/`** — the original single-route proof-of-concept. Superseded
  by `api/`; kept for reference and safe to delete.

Both deploy with `verify_jwt=false`: the API does its own auth (web-session
tokens, device keys, admin key, OAuth, Stripe webhook signatures), not Supabase
JWTs.

## Required secrets (set in the Supabase dashboard → Edge Functions → Secrets)

`SUPABASE_DB_URL` and `SUPABASE_URL` are injected automatically. Set the rest:

| Secret | Needed for |
| --- | --- |
| `STRIPE_SECRET_KEY` | advertiser checkout, refunds, payouts |
| `STRIPE_WEBHOOK_SECRET` | verifying `/v1/webhooks/stripe` (your-account events, e.g. `checkout.session.completed`) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | optional; verifies the separate Connect / connected-accounts event destination (e.g. `account.updated`) |
| `ADMIN_KEY` | `/admin`, moderation, killswitch, payouts, OAuth-state HMAC |
| `RESEND_API_KEY` + `MAIL_PROVIDER=resend` + `MAIL_FROM` | sending login / verify / fulfillment email |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple sign-in |
| `SITE_URL` | redirect targets (defaults to `https://freeai.fyi`) |
| `API_BASE_URL` | optional; defaults to `${SUPABASE_URL}/functions/v1/api` |

## External console changes that go with this migration

The API host moved off `api.freeai.fyi`, so update these to the new base
(`https://<ref>.supabase.co/functions/v1/api`):

- **Google / Apple OAuth** redirect URIs →
  `…/v1/auth/google/callback` and `…/v1/auth/apple/callback`.
- **Stripe** webhook endpoint → `…/v1/webhooks/stripe`. Connect-based payouts
  need a second event destination scoped to **connected accounts** (for
  `account.updated`) pointing at the same URL; put its signing secret in
  `STRIPE_CONNECT_WEBHOOK_SECRET` (the your-account destination's secret stays
  in `STRIPE_WEBHOOK_SECRET`).

## Two differences from the Node server

- **No in-memory rate limiter.** Edge Functions are stateless, so the global
  per-IP token bucket from `server/src/ratelimit.js` is gone. The DB-backed
  per-device daily impression cap and per-device daily click cap (in
  `ingestBatch` / `redeemClickToken`) are unchanged and remain the real abuse
  controls.
- **Killswitch is per-isolate.** `serving` is derived from the `KILLSWITCH` env
  on each cold start; the `POST /v1/admin/killswitch` toggle only affects the
  isolate that handles it. Drive it from env (redeploy) if you need it global.

## Deploy

**Normal path — automatic on merge to `main`.** The
`.github/workflows/deploy-functions.yml` workflow runs `supabase functions
deploy api --no-verify-jwt` whenever a push to `main` touches
`supabase/functions/**`. This is the canonical deploy: it ships the exact bytes
from git, so it never drifts from the repo.

### Required GitHub repo secret (not a Supabase secret)

The CI deploy authenticates with a **`SUPABASE_ACCESS_TOKEN`** repo secret —
this is separate from the runtime Edge Function secrets above. Set it once at
**GitHub → repo Settings → Secrets and variables → Actions → New repository
secret**:

| Repo secret | Where to get it | Needed for |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase dashboard → Account → Access Tokens | the `deploy-functions` workflow to authenticate |
| `SUPABASE_PROJECT_REF` | optional; defaults to the FreeAI project ref in the workflow | targeting a different project |

> **If this secret is missing, the workflow fails on every run** (its guard step
> exits with `SUPABASE_ACCESS_TOKEN secret is not set`) and the live function
> silently goes stale while the repo moves on. If you ever see the deployed
> function lagging behind `main`, check this first:
> `gh run list --workflow=deploy-functions.yml`.

### Manual deploy (fallback)

Via the Supabase CLI:

```
supabase functions deploy api --no-verify-jwt --project-ref <ref>
```

Or the Supabase MCP `deploy_edge_function` tool (one `index.ts` + `deno.json`).
When redeploying the existing `api` slug this way, pass `import_map_path:
deno.json` — the slug remembers its old import-map path otherwise and the deploy
is rejected.

## Database / RLS note

Schema lives in `server/db/schema.sql` (applied to local Postgres via `npm run
migrate`). On Supabase, **Row Level Security is enabled on every `public`
table** (deny-all to the `anon` / `authenticated` PostgREST roles). The API is
unaffected: it connects over the privileged `SUPABASE_DB_URL` pooler role, which
bypasses RLS. New tables should be created with `alter table … enable row level
security;` to match — no policies are needed, since browsers reach the data only
through this function, never PostgREST.
