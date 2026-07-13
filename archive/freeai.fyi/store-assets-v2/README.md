# FreeAI.fyi — compliant Web Store asset set (v2)

Regenerated listing assets for resubmitting FreeAI.fyi as its own Chrome Web
Store item, with the policy-flagged copy removed. The originals that got the
Dwell listing rejected (routing ID FZSL — "Get Claude **for free**." on the
marquee/small tile) are preserved untouched in `../store-assets/`.

Built by `../tools/gen-store-assets-v2.mjs` (node, Playwright). Changes vs v1:

- Tiles: headline is now **"Earn Claude credits while AI thinks."** — no
  `free`, no revenue-% performance claim.
- Hero screenshot: the "FreeAI.fyi has rebranded to Dwell" banner and the
  mascot are hidden during capture.
- Popup screenshots are clipped to the bid-market and crew sections — the
  popup's fuel-ring hero says "toward a **free** month of Claude", so it stays
  out of frame.
- The stale `#install` capture (its section no longer exists in the archived
  page) is dropped.

## Upload set

| File | Slot |
| --- | --- |
| `store-icon-128x128.png` | Store icon |
| `marquee-1400x560.png` | Marquee promo tile |
| `promo-small-440x280.png` | Small promo tile |
| `screenshot-claude-1280x800.png` | Screenshot 1 — pill under Claude's spinner |
| `screenshot-chatgpt-1280x800.png` | Screenshot 2 — pill under ChatGPT's spinner |
| `screenshot-gemini-1280x800.png` | Screenshot 3 — pill under Gemini's spinner |
| `screenshot-popup-market-640x400.png` | Screenshot 4 — popup, live bid market |
| `screenshot-popup-crew-640x400.png` | Screenshot 5 — popup, referral crew |
| `screenshot-hero-1280x800.png` | Optional swap-in (shows "50% of the revenue goes to you as credits" — a product mechanic, not a store-performance claim, but it's the raciest line in the set) |

Chrome takes at most 5 screenshots.

## Residual risks (asset-independent)

- The **name** "FreeAI.fyi" itself leads with "Free" — assets can't fix that;
  a reviewer may still object to the listing name.
- **Duplicate-listing policy**: this extension and Dwell Protocol share
  lineage/backend; two listings with duplicate function from one developer
  can get both taken down.
- The archived extension calls the old `…/functions/v1/api` edge function and
  hard-depends on `freeai.fyi` being live (account link, click redirects,
  privacy-policy URL). Broken functionality is its own rejection reason.
