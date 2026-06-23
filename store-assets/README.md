# Chrome Web Store listing assets

Exact-sized and ready to upload to the Chrome Web Store developer dashboard —
no resizing needed on your end. Regenerate any time with `make store-assets`.

## Store icon
| File | Size | Format |
|---|---|---|
| `store-icon-128x128.png` | 128×128 | PNG (transparency OK) |

## Screenshots — pick up to 5
Chrome shows at most **5 screenshots**. Seven options are provided; you can mix
sizes (1280×800 and/or 640×400). All are 24-bit PNG with **no alpha**.

| File | Size | Shows |
|---|---|---|
| `screenshot-chatgpt-1280x800.png` | 1280×800 | Sponsored line in **ChatGPT** (Chrome) while it thinks |
| `screenshot-claude-1280x800.png` | 1280×800 | …in **Claude** |
| `screenshot-gemini-1280x800.png` | 1280×800 | …in **Gemini** (dark) |
| `screenshot-hero-1280x800.png` | 1280×800 | freeai.fyi homepage hero |
| `screenshot-install-1280x800.png` | 1280×800 | Install / "50% back as Claude credits" CTA |
| `screenshot-popup-credits-640x400.png` | 640×400 | Extension popup — fuel ring ($3.26 / $20) + crew |
| `screenshot-popup-market-640x400.png` | 640×400 | Extension popup — ads watched + live bid market |

_Suggested 5: the three chat shots + the two popup panels._

## Promo tiles
| File | Size | Slot |
|---|---|---|
| `marquee-1400x560.png` | 1400×560 | Marquee promo tile |
| `promo-small-440x280.png` | 440×280 | Small promo tile |

The **"no alpha" 24-bit** format avoids the dashboard's *"image size is
incorrect"* rejection. Screenshots are **downscaled only (never upscaled)**;
the portrait extension popup is centered on the site's **cream** background so
it fills the frame without distortion.

## Regenerate

    make store-assets        # or: node tools/gen-store-assets.mjs

`tools/gen-store-assets.mjs` drives the repo's Playwright Chromium, serves the
site from a throwaway static server, screenshots the **live product** (chat
demo, homepage hero, install card, and the extension popup populated via a
mocked `chrome.*` so the fuel ring / crew / bid market render), composes the
marquee + small promo tile from `theme.css` colors, and finalizes every output
through `tools/png_fit.py` (exact size, 24-bit, no alpha). Chat-screenshot
sources live in `screenshots/`; the icon is downscaled from the macOS
`AppIcon-1024.png`.
