// Generate the FreeAI.fyi social share / link-preview image — og.png (1200×630).
//
// This is the picture every platform (iMessage, Slack, Discord, WhatsApp,
// Twitter/X, Facebook, LinkedIn, Telegram…) shows when someone pastes a
// freeai.fyi link. It has one job: state the offer and look like a real brand,
// not a template. So it's deliberately spare — wordmark, one headline, flat
// background. The og:description under the image carries the pitch.
//
// Like tools/gen-icons.py, this drives a local Chromium (real font rendering)
// rather than pulling an image toolchain. Colors are read straight from the
// design-system source of truth, theme.css, so the card can never drift from
// the palette (AGENTS.md ▸ Design system — never hardcode a color).
//
// Writes (overwrites):  og.png  at the repo root.
// Run:  make og   (or:  node tools/gen-og.mjs)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Playwright is installed globally in this repo's tooling; resolve it from the
// global node_modules so we don't need a local dependency.
const require = createRequire(import.meta.url);
let chromium;
for (const spec of [
  "playwright",
  "/opt/node22/lib/node_modules/playwright",
  "playwright-core",
]) {
  try {
    ({ chromium } = require(spec));
    break;
  } catch {
    /* try next */
  }
}
if (!chromium) {
  console.error(
    "gen-og: Playwright not found. Install it (npm i -g playwright) and run again.",
  );
  process.exit(1);
}

// ── Pull the tokens we need straight out of theme.css's :root block ──────────
// We resolve one level of `var(--x)` aliasing so legacy names still work.
const themeCss = readFileSync(join(root, "web", "theme.css"), "utf8");
const rootBlock = themeCss.slice(themeCss.indexOf(":root"));
const raw = {};
for (const m of rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  raw[m[1]] = m[2].trim();
}
const tok = (name) => {
  let v = raw[name];
  const ref = v && v.match(/^var\((--[\w-]+)\)$/);
  if (ref) v = raw[ref[1]];
  if (v == null) throw new Error(`gen-og: token ${name} not found in theme.css`);
  return v.trim();
};

const C = {
  accentD: tok("--accent-d"),
  gradA: tok("--accent-grad-a"),
  gradB: tok("--accent-grad-b"),
  cream: tok("--bg-cream"),
  ink: tok("--ink"),
  ink2: tok("--ink-2"),
};

const fontData = (file) =>
  `data:font/woff2;base64,${readFileSync(join(__dirname, "fonts", file)).toString("base64")}`;

// ── The card markup. Fixed at exactly the OpenGraph canonical size, 1200×630
// (1.91:1). Deliberately spare: flat brand background, the wordmark, one
// headline, and at most one quiet line of context. The og:description under
// the image carries the pitch — the picture doesn't have to. ──
const cardHtml = ({ h1, note, sub }) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* Fonts are vendored in tools/fonts/ (SIL OFL) and inlined as data: URIs so
     the render is deterministic and works offline — a Google Fonts fetch here
     would make og.png depend on the network weather of whoever last ran
     \`make og\`. Inter-latin.woff2 is the variable font (one file, all weights). */
  @font-face {
    font-family: "Inter"; font-style: normal; font-weight: 100 900;
    src: url("${fontData("Inter-latin.woff2")}") format("woff2");
  }
  @font-face {
    font-family: "JetBrains Mono"; font-style: normal; font-weight: 700;
    src: url("${fontData("JetBrainsMono-700-latin.woff2")}") format("woff2");
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    font-family: "Inter", system-ui, sans-serif;
    color: ${C.ink};
    background: ${C.cream};
    overflow: hidden;
  }
  .pad { padding: 76px 84px; height: 100%; display: flex; flex-direction: column; }

  .top { display: flex; align-items: center; gap: 16px; }
  .logo {
    width: 54px; height: 54px; border-radius: 14px;
    background: linear-gradient(160deg, ${C.gradA}, ${C.gradB});
    display: flex; align-items: center; justify-content: center;
    font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 27px; color: #fff;
  }
  .wordmark { font-weight: 700; font-size: 28px; letter-spacing: -0.02em; }

  .mid { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .note { font-size: 30px; font-weight: 500; color: ${C.ink2}; margin-bottom: 20px; }
  h1 { font-weight: 700; letter-spacing: -0.035em; line-height: 1.06; font-size: 92px; max-width: 980px; }
  h1 .pop { color: ${C.accentD}; }
  .sub { font-size: 32px; font-weight: 500; color: ${C.ink2}; margin-top: 22px; }
</style></head>
<body>
  <div class="pad">
    <div class="top">
      <div class="logo">F$</div>
      <div class="wordmark">FreeAI.fyi</div>
    </div>
    <div class="mid">
      ${note ? `<p class="note">${note}</p>` : ""}
      <h1>${h1}</h1>
      ${sub ? `<p class="sub">${sub}</p>` : ""}
    </div>
  </div>
</body></html>`;

// Every link-preview image we ship. The default (og.png) is the homepage card;
// og-referral.png is the invite card a member's referral link
// (redeem.html?ref=…) previews as. Note the referral card says "earn" rather
// than "get" — there's no "your first month is free" mechanic (the old $20
// referral bonus is retired; a referrer now earns a 10% affiliate cut of what
// their friend earns, not a gift for the friend). "Earn a free month" stays
// true: use the AI you already use, credits accrue from ad revenue, and a
// month of Claude Pro is a real redeemable amount (see the redeem.html plans).
const CARDS = [
  {
    file: "og.png",
    h1: `Get Claude <span class="pop">for free.</span>`,
    sub: "Ads while your AI thinks.",
  },
  {
    file: "og-referral.png",
    note: "A friend invited you.",
    h1: `Earn a <span class="pop">free month</span> of Claude.`,
    sub: "Ads while your AI thinks.",
  },
];

// Output exactly the OpenGraph canonical size, 1200×630. Staying at 1× keeps the
// PNG small (~150KB) — below WhatsApp's ~300KB rich-preview threshold, so the
// big card (not a tiny thumbnail) shows in chat apps — while matching the
// og:image:width/height we advertise so no platform second-guesses the crop.
const SCALE = 1;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: SCALE,
  });
  for (const card of CARDS) {
    await page.setContent(cardHtml(card), { waitUntil: "networkidle" });
    // Make sure the embedded fonts have actually painted before we snapshot —
    // a DejaVu-fallback card must never ship silently.
    await page.evaluate(() => document.fonts.ready);
    const interOk = await page.evaluate(() => document.fonts.check('700 20px "Inter"'));
    if (!interOk) throw new Error("gen-og: Inter did not load — refusing to snapshot a fallback-font card");
    const out = join(root, "web", card.file);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(`gen-og: wrote ${card.file} (1200×630 @${SCALE}x) → ${out}`);
  }
} finally {
  await browser.close();
}

// Quiet the unused import lint — pathToFileURL kept for parity with sibling tools.
void pathToFileURL;

