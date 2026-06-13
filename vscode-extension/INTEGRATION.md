# Incorporating the VS Code / Cursor extension into FreeAI

This document explains **what was done**, **how this extension talks to a
backend**, **where its contract differs from the FreeAI server today**, and a
**staged plan** to make it actually earn against `api.freeai.fyi` — without
touching any existing FreeAI functionality.

---

## 1. What this is

`vscode-extension/` is the editor-agent sibling of the FreeAI Chrome extension.
It injects one clickable sponsored line into the **Claude Code** and **Codex**
"thinking…" spinners (VS Code panel + terminal CLI) and returns 50% of ad
revenue to the developer. Same business model as the rest of FreeAI, different
surface.

It was vendored from a mature upstream codebase (the public, source-available
`kickbacks.ai` extension mirror) and **fully rebranded to FreeAI**:

- Package: `kickbacks-ai` → `freeai-fyi`, publisher `Kickbacksai` → `freeai`,
  `displayName` → `FreeAI.fyi`, version reset to `0.1.0`.
- Commands / config / context-key namespace: `kickbacks.*` → `freeai.*`
  (legacy `vibe-ads.*` aliases → `freeai-legacy.*`, kept to avoid duplicate
  command-id registration).
- Config dir `~/.vibe-ads/` → `~/.freeai/`; env vars `KICKBACKS_*` / `VIBE_ADS_*`
  → `FREEAI_*`.
- Injection markers `VIBE-ADS-START/END` → `FREEAI-START/END` (the strip/detect
  regexes still also recognize the legacy `VIB(E-)?ADS` form, so a machine
  migrating from the old extension is cleaned up correctly).
- Brand palette green `#188a45` → FreeAI orange `#d97757` (mirrors the site's
  `theme.css`); marketplace icon swapped to the FreeAI mark.
- Default backend → `https://api.freeai.fyi`; default update host →
  `https://freeai.fyi`.

**State today:** `npm run typecheck`, `npm run build`, and `npm test` (891
passing / 7 skipped) all green. It is build-ready and Cursor-compatible. It is
**not yet wired to earn** against the FreeAI prod backend — see §3–§4.

**Containment:** everything lives under `vscode-extension/`. `git status` shows
this directory as the only addition. The Chrome extension, server, marketing
site, and macOS app are byte-for-byte untouched.

---

## 2. How the client talks to a backend

The extension is a thin client around a backend ("S2" in upstream naming). The
clients live in `src/`:

| Client | File | Calls |
| --- | --- | --- |
| Auth (device-flow) | `auth/client.ts` | `POST /v1/auth/extension/start`, `GET /v1/auth/extension/poll`, `POST /v1/auth/refresh`, `POST /v1/auth/signout` |
| Ad inventory | `portfolio/client.ts` | `GET /v1/portfolio` (+ `GET /v1/portfolio/demo` signed-out preview) |
| Telemetry | `metrics/client.ts` | `POST /v1/metrics` (+ `/v1/metrics/demo`) — impression / view-threshold / click |
| Earnings | `earnings/client.ts` | `GET /v1/earnings` |
| Killswitch | `killswitch/client.ts` | `GET /v1/killswitch` |
| Consent | `consent/client.ts` | `GET`/`POST /v1/me/consent` |
| Self-update | `update/client.ts` | `GET /v1/ext/manifest` (signed VSIX manifest) |

---

## 3. The FreeAI server today (`server/src/app.js`)

The production FreeAI server exposes a **device-key** contract (used by the
Chrome extension), not the token/portfolio contract above:

| Purpose | FreeAI endpoint | Returns |
| --- | --- | --- |
| Register anon device | `POST /v1/devices/register` | `{ deviceId, deviceKey }` |
| Config / killswitch | `GET /v1/config` | `{ serving, revenueShare }` |
| Ad inventory | `GET /v1/ads` | `{ ads: [{ id, brand, line, url, cat }], revenueShare }` |
| Impression/click batches | `POST /v1/events` | `{ deviceId, deviceKey, batchKey, events:[{impressions,clicks}] }` |
| Click token | `POST /v1/clicks/intent` | `{ trackingUrl }` |
| Earnings | `GET /v1/me/earnings` | display credit |
| Auth | Google/Apple **OAuth redirect** (`/v1/auth/google`, `/v1/auth/apple`, `/v1/web/*`) | session |

---

## 4. The gap, and the staged plan

The two contracts are **conceptually identical** (anonymous identity → fetch ads
→ report impressions/clicks → settle 50% → display earnings) but **wire-level
different**. Three ways to close it; pick per appetite:

### Option A — Client adapter layer (no server changes) ✅ recommended first step
Add `src/freeaiApi/` that implements the `portfolio` / `metrics` / `earnings` /
`killswitch` interfaces on top of the FreeAI endpoints that **already exist**:

| Client interface | Maps onto existing FreeAI endpoint |
| --- | --- |
| `killswitch` → `serving` | `GET /v1/config` (`serving` field) |
| `portfolio` → ad list + `view_threshold_seconds` | `GET /v1/ads` (decorate like `background.js`; threshold from config) |
| `metrics` impression/click | `POST /v1/events` (batch) + `POST /v1/clicks/intent` (click token) |
| `earnings` | `GET /v1/me/earnings` |
| anon identity | `POST /v1/devices/register` (deviceId/deviceKey instead of device-flow token) |

This makes the **VS Code panel + Codex** surfaces earn with **zero server
changes**, reusing the same ledger/auction the Chrome extension already uses.
Auth can stay "anonymous device" for v1 (the Chrome extension earns anonymously
too); sign-in for a named payout account is a later add.

**Deferred under Option A:** device-flow sign-in (`/v1/auth/extension/*`),
server-driven consent (`/v1/me/consent`), and signed-manifest self-update
(`/v1/ext/manifest` + `scripts/deploy.mjs`). These are not required to earn;
ship them when needed. (The one upstream test that depended on the private
`deploy.mjs` self-update signer — `manifestSigning.test.ts` — was removed; the
consumer code in `update/client.ts` remains.)

### Option B — Add the richer endpoints to the FreeAI server
Implement `/v1/portfolio`, `/v1/metrics`, `/v1/auth/extension/*`,
`/v1/ext/manifest` on the FreeAI server so the clients run unmodified. More
faithful to the auction's per-position semantics, but it's net-new server
surface and schema — larger, and it would touch the existing server. Best once
the editor product is validated and the auction needs editor-specific inventory.

### Option C — Hybrid
Option A now (earn fast, no server risk), migrate hot paths to Option B
endpoints later as the auction grows.

---

## 5. Open items before publishing

1. **Licensing (blocker).** The upstream source is **source-available, not open
   source**. Confirm FreeAI has the right to rebrand/redistribute it, or replace
   the relevant pieces, before any marketplace publish. See `LICENSE`.
2. **Brand assets.** `media/icon.png` is the FreeAI Chrome-extension mark.
   Regenerate the full icon/lockup set via `npm run icon` (needs Playwright +
   Montserrat) once a final FreeAI editor mark is chosen.
3. **Cosmetic brand leak.** A few internal-only identifiers retain non-FreeAI
   spellings where renaming them buys nothing and adds risk: the
   `X-Vibe-Corr` correlation header, the private `vibeDir()` method name, and the
   `.vibads-backup` / `~/.vibe-ads` legacy-migration paths (intentionally kept so
   a machine coming from the old extension is detected and cleaned up). None are
   user-visible in the UI. Rename in a follow-up if desired.
4. **Wire it up.** Implement Option A (`src/freeaiApi/`) and flip the clients to
   it. Then `npm test` + a manual run in VS Code/Cursor against a local server.
5. **Marketplace metadata.** Publisher account, `repository`/`bugs` URLs (already
   set to `conorplunkett/freeai.fyi`), screenshots, categories.
