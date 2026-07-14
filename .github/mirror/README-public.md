# Dwell Protocol — public surfaces

This repository is a **read-only mirror** of the client-side surfaces of
[Dwell Protocol](https://dwellprotocol.com). It is generated automatically from
the private source repo — **do not open PRs here**; changes made directly to this
repo will be overwritten on the next sync.

## What's here

| Folder | What it is |
|---|---|
| `chrome-extension/` | The browser extension that inserts sponsor lines into Claude, ChatGPT, and Gemini. |
| `desktop/` | The macOS Sponsor Overlay desktop app. |
| `terminal/` | The `@dwell-protocol/terminal` CLI package. |

These ship to end users anyway (browser extensions, npm packages, and app
bundles are all inspectable), so they live in the open. The backend — server,
Supabase functions, and smart contracts — stays private.

## Downloads

- **macOS desktop app:** [dwellprotocol.com/download/mac](https://dwellprotocol.com/download/mac)
  (served from this repo's [latest release](../../releases/latest)).
- **Terminal:** `npm install -g @dwell-protocol/terminal && dwell claude setup`
- **Chrome extension:** via the Chrome Web Store.
