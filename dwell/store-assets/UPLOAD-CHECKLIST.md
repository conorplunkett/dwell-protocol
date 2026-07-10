# Chrome Web Store — screenshot upload checklist

Which of the generated `store-assets/` images to upload for the listing, and
which to leave out. The site/lander is **not** changed — this is only about the
subset of images we hand to the Web Store dashboard.

> **Context — the v0.8.0 rejection (routing ID FZSL).** Google's "internal
> review" flagged assets that *mimic ranking, performance, or current Web Store
> status* — keywords like `free`, `#1`, `new`, `premium`, `recommended`, or an
> "in review" status line. In our asset set that language only appears in **one
> screenshot**, `screenshot-install-*` (see below). Everything else is clean, so
> the fix here is simply **don't upload that one** — no listing-copy or website
> edits required.

Chrome allows **up to 5 screenshots** (1280×800 or 640×400), plus the 128×128
icon and the optional promo tiles.

---

## Screenshots

### ✅ Upload these — current product, no status/ranking text

| Preview | File | Size | Shows |
| --- | --- | --- | --- |
| ![](./screenshot-claude-dwell-1280x800.png) | `screenshot-claude-dwell-1280x800.png` | 1280×800 | Sponsored pill (`$troll`) under Claude's thinking spinner |
| ![](./screenshot-chatgpt-dwell-1280x800.png) | `screenshot-chatgpt-dwell-1280x800.png` | 1280×800 | Sponsored pill (`$fwog`) under ChatGPT's spinner |
| ![](./screenshot-gemini-dwell-1280x800.png) | `screenshot-gemini-dwell-1280x800.png` | 1280×800 | Sponsored pill (`$ansem`) under Gemini's spinner |
| ![](./screenshot-popup-credits-dwell-640x400.png) | `screenshot-popup-credits-dwell-640x400.png` | 640×400 | Extension popup — live dwell balance + referral crew |
| ![](./screenshot-popup-market-dwell-640x400.png) | `screenshot-popup-market-dwell-640x400.png` | 640×400 | Extension popup — bid market / inventory |

That's a compliant set of 5. Swap the value-prop hero in if preferred (see caution below).

### ⚠️ Use with caution

| Preview | File | Why |
| --- | --- | --- |
| ![](./screenshot-hero-dwell-1280x800.png) | `screenshot-hero-dwell-1280x800.png` | Clean of ranking/status keywords, but shows illustrative earnings figures (`$1285`, `$ansem +235%`). These are demo ad inventory, not a Web Store claim — lower risk, but review before uploading. |

### 🚫 Do not upload

| Preview | File | Why |
| --- | --- | --- |
| ![](./screenshot-install-1280x800.png) | `screenshot-install-1280x800.png` | **This is the flagged asset.** Bakes in `01 · Browser` (ranking), `v0.8.0 · In review` (Web Store status), the word `Free`, and "In Chrome Web Store review." — the exact "ranking / status / free" pattern in the FZSL notice. |
| ![](./screenshot-install-dwell-1280x800.png) | `screenshot-install-dwell-1280x800.png` | Same image, `-dwell` twin — same flagged text. |
| — | `screenshot-chatgpt-1280x800.png` | Non-`-dwell` chat shots still render the **retired pre-rebrand sponsor bar**. Use the `-dwell` versions instead. |
| — | `screenshot-claude-1280x800.png` | Retired bar — use `screenshot-claude-dwell-*`. |
| — | `screenshot-gemini-1280x800.png` | Retired bar — use `screenshot-gemini-dwell-*`. |
| — | `screenshot-popup-credits-640x400.png` | Superseded by the `-dwell` popup shots. |
| — | `screenshot-popup-market-640x400.png` | Superseded by the `-dwell` popup shots. |

---

## Icon & promo tiles (separate slots — clean, safe to use)

| Preview | File | Size | Slot |
| --- | --- | --- | --- |
| ![](./store-icon-128x128.png) | `store-icon-128x128.png` | 128×128 | Store icon |
| ![](./marquee-1400x560.png) | `marquee-1400x560.png` | 1400×560 | Marquee promo tile (optional) |
| ![](./promo-small-440x280.png) | `promo-small-440x280.png` | 440×280 | Small promo tile (optional) |

Neither promo tile carries ranking/status/`free` text. If a future review still
objects to a tile, regenerate with `make store-assets` after removing the
keyword from the captured section — but that is not needed for this resubmission.
