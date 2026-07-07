# Open forgery surface: `/v1/events` self-reported impressions

> **Status: OPEN as of 3:30 PM, July 3 2026.**
> The server-authoritative impression-token path is live and the official clients
> use it, but the legacy `/v1/events` credit path is still enabled, and that is
> where the hole is. This file tracks why it's open and exactly what closes it.

## Where the hole comes from

`POST /v1/events` credits **client-reported** impression counts. A batch looks like:

```json
{ "deviceId": "…", "deviceKey": "…", "batchKey": "…",
  "events": [{ "campaignId": "…", "impressions": 500, "clicks": 0 }] }
```

The server takes `impressions` on trust. Device registration is anonymous and
open (`POST /v1/devices/register` needs no auth), so **anyone can get a device
key and POST forged batches directly to `/v1/events` to mint credit** — no
official client required. The `clicks` field is already ignored for billing;
`impressions` is the exposed number.

This is the exact problem the impression-token work (serve → dwell → redeem) was
built to remove: with tokens, an impression is billable only if the server
actually served that ad to that device, once. But tokens only close the hole
**once `/v1/events` stops crediting** — and it can't stop yet (see below).

## Why it's still open

`/v1/events` must keep crediting during the client transition. The updated
clients that bill via tokens instead of batches are:

- Chrome extension **0.6.0**
- Terminal **0.2.0**
- macOS overlay (serve/redeem build)

Until those updates propagate in the field (Chrome Web Store review, `npm`,
notarized `.dmg`), users on older builds still earn through `/v1/events`.
Disabling it now would cut off legitimate earners. So the batch path stays
credited on purpose, and the forgery surface stays open with it.

## What bounds the damage today (mitigations, not a fix)

- **Per-device daily cap** — `DAILY_IMPRESSION_CAP` (default 5000).
- **Per-IP daily cap** — `IP_DAILY_IMPRESSION_CAP`, hashed source IP; bounds
  farming across many anonymous devices behind one host.
- **Manual gift-card fulfillment** — a human reviews before any credit becomes a
  real gift card (48h window). Forged credit does not auto-convert to value.
- **Capability guard** — `/v1/events` refuses a batch from a client that
  advertises `capabilities: ["impression_tokens"]`. This prevents an *updated
  client* from double-crediting; it does **not** stop a forger, who simply omits
  the flag.

These bound the blast radius; they do not close the hole.

## How it closes (the actual fix)

1. **Ship the updated clients** (above) and let them reach users.
2. **Watch adoption.** Every credit is tagged with its surface (`source` =
   `chrome` / `claude_code` / `desktop`) and token credits carry `meta.via =
   "token"` in the ledger. When nearly all legitimate credit is flowing through
   the token path, the batch path is no longer load-bearing for real users.
3. **Disable legacy `/v1/events` crediting.** This is the step that closes the
   hole: once `ingestBatch` stops issuing `impression_credit`, a forged batch
   credits nothing and the token path is the only way to earn.

   ⚠️ **Not yet implemented.** There is no config killswitch for step 3 today —
   it needs a small change: gate the crediting in `ingestBatch`
   (`server/src/repo.js` and `supabase/functions/dwell-api/index.ts`) behind a flag
   such as `LEGACY_EVENTS_CREDIT` (default on), so the flip is a single env var
   once adoption is high. Add that flag before you need to flip it.

## Scope note

Closing `/v1/events` crediting ends **forgery and inflation** (fake or
exaggerated counts). It does **not** end **Sybil** abuse (one actor spinning up
many anonymous devices), which remains bounded by the per-IP cap, manual
fulfillment, and anomaly review — a separate, ongoing problem.
