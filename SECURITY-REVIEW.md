# Pre-launch security & robustness review

A full-surface review ahead of making the clients public (Chrome extension,
Claude Code terminal client, macOS overlay, static web portal/admin, and the
Supabase Edge Function backend). This document records what was hardened on this
branch and the residual items that need a product decision or a tested follow-up.

The money core held up well: the credit ledger is append-only, redemptions take a
transaction-scoped advisory lock and re-check the balance inside the transaction,
Stripe webhooks are signature-verified and processed exactly-once, gift cards can
only be sent to the account's own verified email, and request bodies are size-capped
with guarded JSON parsing. The findings below are the edges around that core.

## Fixed on this branch

### Terminal client (`terminal/`)
- **Status-line trust-gate bypass / RCE (highest severity).** `effectiveStatusLine`
  read a `statusLine.command` from the *project's* `cwd/.claude/settings.json` and
  `settings.local.json` and FreeAI re-executed it via `shell:true` roughly once a
  second. Claude Code gates project-provided status-line/hook execution behind its
  folder-trust prompt; FreeAI ran it regardless, so cloning a hostile repo and
  starting `claude` in it executed attacker code even if the user declined trust.
  Now only the user's own `~/.claude/settings.json` (and an explicit `--settings`
  passed on that invocation) are chainable; project-scoped files are never executed.
  (`src/settings.js`, test in `test/settings.test.js`.)
- **Device key file was world-readable (`0644`).** `~/.freeai/device.json` holds the
  `deviceKey` bearer secret. It's now written `0600` via an atomic temp file whose
  mode is set before the rename. (`src/util.js`, `src/backend.js`.)
- **Non-atomic rc rewrite could corrupt `.bashrc`/`.zshrc`.** Interrupt/ENOSPC mid-write
  left the whole rc truncated, breaking every future shell. Install/restore now write
  atomically (temp + rename). (`src/shell.js`.)
- **Uninstalling `freeai` bricked the `claude` command.** The alias `claude="freeai claude run"`
  became `command not found` if `freeai` was removed. It's now a shell function that
  falls through to the real `claude` when `freeai` isn't on PATH. (`src/shell.js`.)
- **Signals forwarded only once.** Claude's double-Ctrl-C: the second SIGINT wasn't
  forwarded (parent died, could orphan the child). Now uses persistent handlers and
  also forwards SIGQUIT. (`src/run.js`.)

### Chrome extension (`chrome-extension/`)
- **`BB_SET` wrote arbitrary storage keys.** A message could set any key
  (`pendingImpressions`, `grossCpm`, `deviceKey`, …) — a direct fraud/identity
  amplifier from the content-script console. Now allowlisted to the popup's real
  toggles (`enabled`, `testMode`, `blockedCategories`). (`src/background.js`.)
- **No message-sender validation.** The service worker processed any message. Added a
  defense-in-depth `sender.id === chrome.runtime.id` gate. (`src/background.js`.)
- **Device key in a URL query string.** `getCrew` sent `deviceKey` in the `/v1/me/affiliate`
  query string (leaks into edge/proxy access logs). It now travels in
  `x-device-id`/`x-device-key` headers. (`src/background.js` + backend header support.)
- **`window.open` without a scheme check.** Ad `url` is advertiser inventory; the click
  handler now opens it only when it's `https:`. (`src/content.js`.)

### Web portal & admin (`web/`)
- **No clickjacking / hardening headers.** Added `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  and `Referrer-Policy` for the whole site (CSP kept to `frame-ancestors` so inline
  scripts on the static pages aren't broken). (`web/vercel.json`.)
- **Advertiser URL rendered as a raw `href` in admin.** Defense-in-depth `safeHref()`
  now restricts campaign/lander links to `http(s):` before rendering, so a `javascript:`
  URL can't run in the admin origin (which holds the admin key in localStorage). The
  backend already rejects non-https at checkout; this stops the admin panel from
  trusting that. (`web/admin.js`.)
- **Unescaped ledger `entry_type` in an innerHTML sink.** The portal activity list now
  escapes the label and reduces the value to safe class characters, closing a latent
  stored-XSS sink one backend change away from exploit. (`web/redeem.js`.)

### Backend (`supabase/functions/api/index.ts`, mirrored in `server/src/app.js`)
- **Admin key compared with `===`.** Now a length-guarded constant-time compare
  (`crypto.timingSafeEqual`), matching how Stripe signatures are already verified.
- **Header-based device auth.** `authDeviceFrom` now accepts `x-device-id`/`x-device-key`
  headers (body/query kept for old clients), so clients can keep the secret out of URLs.
  `Access-Control-Allow-Headers` updated on both runtimes.

### macOS overlay (`desktop/macos/`) — compile-checked by the `desktop-macos` CI job only
- **Destination URL opened without an https check.** `Ad.destinationURLOrFallback` now
  returns the ad URL only when it's `https:`, else the site; `rotateAd` routes the card
  through it too, so a click can never launch `file://` / a custom app scheme. (`main.swift`.)
- **Force-casts on foreign AX results could crash the app.** `focusedWindow`/`frame` now
  verify the CF type before casting instead of `as!`-trapping on an unexpected type from
  another app's AX server. (`AssistantDetector.swift`.)
- **Force-unwrap of a configurable base URL crashed at launch.** A malformed
  `FREEAI_API_URL`/`apiBaseURL` override now falls back to the built-in default.
  (`BackendClient.swift`.)
- **Unbounded main-thread AX IPC.** Added `AXUIElementSetMessagingTimeout(0.25s)` so a
  wedged target app can't beachball the menu-bar app. (`AssistantDetector.swift`.)

### Rust core (`desktop/core/`)
- **Integer overflow in impression-cost math.** `impression_cost_cents` used `+ 999`;
  a hostile `cpm_cents` near `i64::MAX` could overflow to a negative cost that passes the
  budget check. Now `saturating_add`. (`campaign.rs`.)

## Deferred — needs a product decision or a tested follow-up

- **Client-authoritative impressions (all three clients).** Credits are minted from
  client-reported impression counts; a user who extracts their own device key can POST
  forged batches to `/v1/events`. The DB-backed per-device and per-IP daily caps are the
  only backstop today, and gift-card fulfillment is manual (human in the loop). Before
  scaling spend, consider server-issued per-impression nonces tied to an actual ad-serve
  event, and confirm the caps are conservative. This is the single biggest structural
  fraud surface and is an architecture change, not a one-line fix — called out, not
  changed here.
- **No per-IP cap on magic-link / login email sends.** `/v1/web/login` (unauthenticated)
  and `/v1/auth/request-link` only throttle per-email (60s). One IP can send login emails
  to many distinct addresses — a spam-cannon / sender-reputation risk. The fix mirrors the
  existing waitlist per-IP cap: add `ip_hash` to `email_tokens` (idempotent migration),
  count per-IP-per-day in `createEmailToken`, and pass `hashIp(ctx)` + a cap from both
  routes. Deferred deliberately: it's a shared-schema migration in a money system and the
  server test suite couldn't be run in this environment (no Postgres) — it should land with
  its own test.
- **Device key shipped through the browser (macOS sign-in, `main.swift:openWebSignin`).**
  The `deviceKey` is placed in a URL fragment handed to the default browser; a malicious
  browser extension with history/tab access could lift it. Mint a short-lived, single-use
  link token server-side and put only that in the URL (same pattern as click intents).
- **macOS `FrequencyCaps` are implemented in the Rust core but never linked into the
  Swift shell** (`frequency.rs`). Port/enforce the min-repeat + daily cap client-side, or
  make an explicit decision to rely solely on server caps.
- **Extension link bridge trusts any `freeai_session` in site localStorage**
  (`src/link.js`) and the redeem page auto-links a device from a URL fragment
  (`redeem.js`). Both are attribution/fraud-laundering vectors that want an explicit
  user-consent step rather than silent linking.
- **Keychain accessibility** on macOS is `...AfterFirstUnlock` (backup-migratable);
  prefer `...ThisDeviceOnly` for a device-identity secret.
- **Robustness polish**: cap the extension's `pendingImpressions` and the macOS event
  queue during long outages; sweep stale terminal session dirs; escape catalog fields fed
  to a few remaining innerHTML interpolations in `redeem.js`.

## Deployment ordering note
The extension now sends device creds via headers to `/v1/me/affiliate`. The Edge Function
auto-deploys on merge to `main` (before any manually-submitted new extension build reaches
users), and header support is additive (query/body still work), so there's no ordering
gap; a stale extension against the new backend, or vice-versa, degrades to the sign-in CTA
at worst — never a crash or a money error.
