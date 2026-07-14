# DWELL launch video

45-second launch video built with [Remotion](https://remotion.dev).
1920×1080 @ 30fps, 1350 frames, styled on the "Kinetic Broadcast" brand
(`src/theme.ts` hand-mirrors `../web/theme.css` — keep them in sync).

## Storyboard

| Scene | Time | Beat |
|---|---|---|
| Hook | 0:00–0:08 | Chat window, assistant thinking, the sponsor pill slides in — "You wait on AI all day." |
| Make money | 0:08–0:15 | **"Make money while you use AI."** + the LCD tally ticking up earnings |
| Token | 0:15–0:27 | **"Find the next big token."** — a token launch shows in the bar, cursor clicks it, the token card pops open |
| Payout | 0:27–0:35 | "Cash out. For real." — dwells → USDC to your wallet, or Claude credits (+10% boost) |
| CTA | 0:35–0:45 | Logo sweep, "Get paid for your attention.", **Start earning** → dwellprotocol.com |

## Run it

```sh
npm install
npm run studio    # live-edit at localhost:3000
npm run render    # → out/launch.mp4
```

In headless environments without a downloaded Chrome, point Remotion at a
local Chromium, e.g.:

```sh
npx remotion render LaunchVideo out/launch.mp4 \
  --browser-executable=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  --timeout=120000 --concurrency=4
```

Fonts (Sora, JetBrains Mono — SIL OFL) are vendored in `public/fonts/` so
renders never touch the network.
