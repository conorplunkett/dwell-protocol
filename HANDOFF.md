# Handoff — DWELL protocol repo

Written by the Claude Code session that built this repo, for whichever
session picks it up next. Read `AGENTS.md` first (repo conventions); this
file is situational context that doesn't belong there permanently — delete
it once you've absorbed it and the deploy is confirmed working.

## What this is

DWELL protocol ($DWELL) — a rename + full standalone extraction of a token
product that used to live as `aiad/` inside `conorplunkett/freeai.fyi`
(a separate, unrelated ad-serving product for AI coding assistants). Same
mechanics, new brand: one sponsored line while an AI assistant thinks, 90%
of every ad dollar buys $DWELL, split 60% viewer / 10% referrer / 30%
protocol treasury (held, never sold). Launch venue is **star.fun (Solana)**
— see `docs/07-starfun-launch.md`. **The user said they're raising tomorrow**
(as of this repo's creation) — treat anything launch-blocking as urgent.

This repo was built by copying + renaming everything AIAD→DWELL out of
freeai.fyi in one working session: site re-themed from black/green to a new
"Kinetic Broadcast" brand (`docs/brand.md` — vibrant red on white, YouTube-ish,
Sora type), contracts renamed (`DWELL.sol`, `IDWELL.sol`), backend rebranded
with DWELL-flavored defaults, docs rewritten. Every local test suite passed
before push: server 54/54, chrome-extension 30/30, terminal 34/34, forge
25/25, plus the copy-rule and brand-separation greps.

## How the code got here — no direct git access, relayed through freeai.fyi

Important context if anything looks like a weird git history: the agent
that built this repo could **not** push to `conorplunkett/dwell-protocol`
directly — this session's tooling was scoped only to `freeai.fyi`, and a
repeated `add_repo` call for dwell-protocol failed with "requires approval"
with no prompt ever surfacing (a platform-level gate, not a fluke). The
workaround: the commit was pushed to a throwaway branch **`dwell-export`**
on `conorplunkett/freeai.fyi`, and the user manually relayed it from their
own machine:
```sh
git fetch origin dwell-export        # in a freeai.fyi checkout
git push https://github.com/conorplunkett/dwell-protocol.git origin/dwell-export:refs/heads/main
```
This happened **twice** (initial import, then a routing-bug fix — see
below). The `dwell-export` branch may still exist on freeai.fyi; it's fine
to ask the user to delete it once this repo is confirmed working, but don't
delete it yourself (no access to that repo from here).

**If you have working git/GitHub access in this session**, this whole
relay dance is unnecessary going forward — just push normally. This note
only matters for understanding how `main`'s history looks and why a
commit references "the dwell-export branch."

## Deployment model — shared Supabase project, own schema

This is **not** a fresh Supabase project. Per an explicit user correction
mid-build: DWELL shares the **same Supabase project as FreeAI**
(`wpjfhezklpczxzocgxsb`, org `ozypdmsezxtxhskggmaq`) to avoid a second
paid project. Isolation happens one level down:

- All DWELL tables live in Postgres schema **`dwell`** (FreeAI's are in
  `public`) — a full mirror of `server/db/schema.sql`, applied via
  `apply_migration` (migration name `dwell_protocol_schema`). Zero overlap;
  verified via `information_schema.tables` (26 tables in `dwell`, 23 in
  `public`).
- The edge function is deployed under slug **`dwell-api`** (never `api` —
  that's FreeAI's production function; do not touch it from this repo).
  Both `server/src/boot.js` (`DB_SCHEMA` env, default `dwell`, pins
  `search_path` via the pg pool's `options`) and
  `supabase/functions/dwell-api/index.ts` (pins `search_path` per-transaction
  since Supavisor transaction-mode pooling doesn't guarantee a startup
  parameter survives) implement the pinning. See `AGENTS.md` ▸ Backend rules.
- `TOKEN_MODE` defaults to `points` in this repo's backend (unlike
  freeai.fyi, where it defaults off) — this deployment *is* the points-phase
  product, no env var needed to turn it on.
- A **seeded test campaign** already exists in `dwell.campaigns` /
  `dwell.ledger` (advertiser `ads@dwell.example`, $12 CPM, 50k impressions,
  fully paid + reserve-earmarked) so the earning loop is testable
  end-to-end without a real Stripe account.

### freeai.fyi carries a temporary deploy bridge — for now

Because deploying an edge function requires uploading ~150KB of file
content through a tool call, and that hit an output-token ceiling in the
building session, deploys go through
**`conorplunkett/freeai.fyi`'s `.github/workflows/deploy-dwell-bridge.yml`**
— a manual-dispatch-only workflow that checks out *this* repo's `main`
(public, so no cross-repo auth needed) and runs
`supabase functions deploy dwell-api --project-ref wpjfhezklpczxzocgxsb --no-verify-jwt`,
reusing freeai.fyi's existing `SUPABASE_ACCESS_TOKEN` secret.

**If you have Supabase CLI / MCP access from this session**, prefer
deploying directly (`supabase functions deploy dwell-api ...` or the
Supabase MCP's deploy tool) and treat the bridge as unnecessary. If not,
ask the user to trigger it: GitHub → freeai.fyi → Actions →
"Deploy dwell-api (bridge)" → Run workflow. **This repo's own
`.github/workflows/deploy-functions.yml` already exists and does the same
thing properly** — it just needs a `SUPABASE_ACCESS_TOKEN` secret added to
*this* repo's settings. Once that's done, delete the bridge workflow from
freeai.fyi (tell the user; you may not have access to remove it yourself).

## Known bug already fixed, watch for regressions like it

The **first** deploy attempt 404'd on every route. Root cause: the edge
function's `stripPrefix()` router (bottom of `supabase/functions/dwell-api/index.ts`)
still matched the pre-rename slug — `path.replace(/^\/api(?=\/|$)/, "")` —
so with the function deployed as `dwell-api`, no request path ever matched
a route. Fixed in commit `917285f` to match `/^\/dwell-api(?=\/|$)/`. If
you ever rename the function slug again, **this regex must change with it**
— there's no test that would catch a mismatch except the smoke test below,
because the local `server/test/run.js` suite never goes through this file
(it exercises `server/src/app.js` directly).

## Immediate next step: verify the fix deployed and smoke-test

As of this handoff, commit `917285f` (the routing fix) has been relayed to
`dwell-export` on freeai.fyi but the user had not yet run the second relay
push, and the bridge workflow had not been re-dispatched against the fixed
commit. **First thing to do:**

1. Confirm `main` on this repo is at `917285f` or later (`git log`).
2. Trigger a fresh `dwell-api` deploy (bridge workflow or direct).
3. Run the smoke test:
   ```sh
   BASE="https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/dwell-api"
   curl -sS "$BASE/v1/config"                          # expect {"tokenMode":"points",...}
   curl -sS -X POST "$BASE/v1/devices/register"         # expect {"deviceId":...,"deviceKey":...}
   # then POST /v1/impressions/serve with that device, sleep 2.5s, POST /v1/impressions/redeem
   # with the returned token, then GET /v1/reserve and confirm allocatedMillicents=450000000 (the
   # seeded campaign's earmark) plus whatever the redeem just added.
   ```
   A full copy of this script was written during the build at
   `/tmp/.../scratchpad/smoke.sh` in the previous session's sandbox — it
   will not exist in yours; the curl sequence above is the same test
   inlined.
4. If green, the site's `dwell-api` `<meta>` tag in `web/index.html` /
   `web/portal.html` already points at the right URL — no code change
   needed. Move on to standing up Vercel (see below).

## Not yet done (the user knows; confirm before assuming otherwise)

- **Vercel**: no site is deployed yet. Plan: user imports this repo in
  Vercel, Root Directory = `web`, no build step, then attaches whatever
  domain they choose. Not blocked on anything except doing it.
- **Stripe**: no keys configured anywhere — advertiser checkout is
  disabled by design (`STRIPE_SECRET_KEY` absent ⇒ boot requires
  `DEVNET=1` to skip it; the deployed edge function doesn't have this
  escape hatch the same way, check `boot()` / the edge function's startup
  before assuming checkout works at all in production).
- **Chrome Web Store / npm / Apple Developer**: extension, terminal
  package, and macOS app are renamed in source but not published/signed
  anywhere.
- **star.fun raise gates**: the repo's own `docs/06-launch-checklist.md`
  and `docs/07-starfun-launch.md` list securities counsel sign-off,
  geofencing, and the W-9 pipeline as pre-raise gates. If the user is
  moving fast toward a raise, flag this rather than assuming it's handled.
- **`SUPABASE_ACCESS_TOKEN` secret**: not yet added to *this* repo (only
  to freeai.fyi, which is why the bridge exists). Once added here, this
  repo's own `deploy-functions.yml` deploys on every push to `main` that
  touches `supabase/functions/**` — the normal, permanent path.

## Quick orientation

- `web/theme.css` — the one file that controls every color/font/radius
  across the whole product. Read `AGENTS.md` ▸ Design System before
  touching brand anything; there are hand-mirrored copies (extension
  popup, inject.css, macOS Swift) that must move together.
- `server/` is the reference backend (Node, tested in CI);
  `supabase/functions/dwell-api/index.ts` is the deployed mirror — every
  backend change lands in both, same commit, per `AGENTS.md`.
- `contracts/` is Foundry, Base/EVM, pinned OpenZeppelin — the CI-verified
  reference implementation. The actual launch venue is star.fun/Solana, so
  these contracts won't deploy as-is for the real launch; they're the
  spec-in-code and fallback path (see `docs/07-starfun-launch.md`).
