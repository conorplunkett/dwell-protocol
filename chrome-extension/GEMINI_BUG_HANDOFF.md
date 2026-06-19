# Handoff: Gemini ad-bar placement bug (FreeAI Chrome extension)

> **For the next Claude session (with live browser access).** This is a complete
> brief to take over debugging and fixing the Gemini placement bug end-to-end.
> Read it top to bottom before touching code.

---

## 0. TL;DR of the open bug

On **Gemini** (`gemini.google.com`), the injected sponsored ad bar **renders in
the wrong place during the thinking-dots (`...`) stage** — it lands in a *stale*
assistant turn, visually **above the user's newest message**, instead of below
the live thinking dots in the active turn. It "snaps" to the right spot once the
first thinking text streams in, but the dots-only window is broken.

**ChatGPT and Claude are correct.** Only Gemini's dots-only stage is wrong.

We've shipped several fixes that each looked right against synthetic DOM but the
real Gemini DOM keeps diverging. **Your job: reproduce live, capture the real
DOM, fix it for real, verify in a real browser, then commit/push/PR/merge.**

---

## 1. Repo + workflow facts

- **Repo:** `conorplunkett/freeai.fyi`. Working dir: `/home/user/freeai.fyi`.
- **Extension lives in:** `chrome-extension/`.
  - `src/content.js` — the content script (detection + ad-bar placement). **This
    is where the bug is.**
  - `src/inject.css` — the bar's styling (fade/reserved-box behavior).
  - `src/background.js` — MV3 service worker (prod backend calls; not relevant
    to this bug).
  - `test/run.js` — headless mock-DOM suite (`npm test`), **runs in CI**.
  - `test/live.js` — Puppeteer suite against real headless Chrome
    (`npm run test:live`), **NOT in CI** — so it can silently drift. Keep it
    honest.
- **Branch discipline:** never push to `main`. Create `claude/<topic>` branches,
  push, open a PR via the GitHub MCP tools (`mcp__github__create_pull_request`),
  squash-merge (`mcp__github__merge_pull_request`). The user says "merge it" when
  ready — they've been approving each one.
- **Commit message footer** (house style, both lines):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VAz4rSFbLhVvyMVcSZierV
  ```
  (Adjust the session URL to your own.) Do **not** put model IDs in commits.
- **Conventions:** read `AGENTS.md` at repo root. Hard rules that matter here:
  - **No hardcoded colors/fonts** anywhere — use `theme.css` tokens. The injected
    bar re-declares `--ov-*` tokens on `.bb-bar` in `inject.css` because
    `theme.css` can't load on third-party pages. The **only** color exception is
    per-sponsor brand colors in `ads.js` (`ad.color`/`ad.ink`), applied via
    `elChip.style`.
  - Revenue line is **"50% back as Claude credits."** Don't reword.
- **Run tests from the extension dir:**
  ```bash
  cd chrome-extension
  npm install            # first time (Puppeteer + a Chrome build)
  npm run lint           # node -c syntax check
  npm test               # mock-DOM (CI)
  npm run test:live      # real headless Chrome
  ```

---

## 2. How the ad bar works today (mental model)

`content.js` runs on every supported AI site. Core loop:

1. **`isThinking()`** — true while the model is generating. Checks two selector
   groups, **both visibility-gated** (`isVisible()` = nonzero
   `getBoundingClientRect`):
   - `STOP_SELECTORS` — the site's stop-generation button. **Only generation
     verbs** (`stop generating/streaming/response`, ChatGPT `data-testid`,
     Gemini `mattooltip*="stop"`). A bare `aria-label*="stop"` was removed
     because it matched ChatGPT sidebar titles like "6 Train Not **Stopping**".
   - `BUSY_SELECTORS` — streaming/thinking markers incl. Gemini's
     `thinking-dots-animation` / `.thinking-dots-animation`, Claude's
     `.epitaxy-spark-working`, `[aria-busy="true"]`, `.result-streaming`, etc.
2. **`evaluate()`** (polls ~3×/sec) → `startActive()` when thinking, else
   `stopActive()`.
3. **`mount()`** (called every 100 ms tick while active) → finds the anchor and
   appends the bar as that container's **last child** (`bb-inline`), re-asserting
   each tick because these apps re-render and append nodes after us.
4. **`findAnchor()`** — picks the container to mount into. **This is the heart of
   the bug.** Current logic:
   - **Gemini special-case (my latest fix):** find the last *visible* thinking
     dots via `lastVisibleMatch(["thinking-dots-animation",
     ".thinking-dots-animation"])`, then anchor to `dots.closest("model-response")`.
   - **Fallback (all other sites):** collect one candidate per `ANCHORS`
     selector (last match each), pick the one **latest in document order**
     (descendant beats ancestor). `ANCHORS` =
     `div[data-test-render-count]` (Claude turn), `[data-message-author-role="assistant"]`
     (ChatGPT), `.result-streaming` (ChatGPT old), `model-response` (Gemini
     fallback).
5. **Placement / fade (`inject.css`):** once anchored, the bar **stays mounted
   and space-reserved** (`display:flex`, `opacity:0`, `visibility:hidden`,
   `pointer-events:none`) and animates opacity — **0.25 s fade-in**, **2 s
   fade-out** — so the page never reflows (no text jump) and the ad eases out.
   The single box is **reused** across generations.
6. **One ad at a time:** `currentAd()` returns the **top of inventory**
   (`ads[0]`), never rotates.

Useful internals:
- Impressions only count while `bb-show` is on (visible).
- `window.__freeaiTest` hook exposes `isThinking/evaluate/tick/bar/currentAd/...`
  for the mock harness.

---

## 3. What we already tried (so you don't repeat it)

In rough order (all merged to `main`):

1. Inline placement at the streaming reply (was a fixed bottom pill).
2. "Below the thinking indicator" via an `after`-the-row insert.
3. Gemini `.thinking-dots-animation` detection; "always below the indicator."
4. Matched Gemini's real `<thinking-dots-animation>` custom element.
5. Document-order anchor pick (a descendant container wins over an ancestor) —
   fixed Claude's "empty streaming bubble above the star" case.
6. Gemini "dots row" insert (dots + first text share a row).
7. ChatGPT: single ad + only-while-thinking (removed the `aria-label*="stop"`
   catch-all; visibility-gated BUSY selectors).
8. Fade-out over 2 s with reserved box (no reflow).
9. **Anchor Gemini to `model-response` (last)** — then user reported it snaps
   **above the last user message**.
10. **Anchor Gemini to `dots.closest("model-response")`** (the *current* fix) —
    user says **still happening**.

**Key real-DOM facts learned from the user's console dumps:**

- Gemini's dots are nested **deep inside** `<model-response>`:
  `model-response › div.response-container... › ... › div.response-content ›
  thinking-overlay(absolute) › thinking-dots-animation › div.thinking-dots-animation › svg(28×28)`.
  `thinking-overlay` is **absolutely positioned**, so the dots' nearest in-flow
  ancestors can be collapsed (0 height) before any text streams.
- A diagnostic during the bug showed: **9** `model-response` elements;
  `dotsInsideLastModelResponse: false`; `barInsideLastModelResponse: true`;
  `barInsideSameContainerAsDots: false`. i.e. the **active (dots') model-response
  is NOT the last in the DOM**, and the bar went to the last one (stale, above
  the newest user message). That's why "anchor to last `model-response`" was
  wrong and we switched to `dots.closest('model-response')`.

**Why it may STILL be wrong (hypotheses to test first):**

- **(A) Extension not reloaded.** The user loads the unpacked extension; each
  merge only takes effect after `git pull` + ↻ on `chrome://extensions`. Confirm
  the running code is current (`window.__freeaiLoaded` is true, but that doesn't
  prove version — check the actual `findAnchor` source in the loaded extension,
  or add a temporary `console.log`/version stamp).
- **(B) Dots not "visible" per `isVisible()`.** If `thinking-dots-animation`
  (and its `.thinking-dots-animation` child) compute to **0 height** at the
  dots-only moment (because the real content is in the absolutely-positioned
  `thinking-overlay`/lottie), then `lastVisibleMatch(...)` returns `null`, the
  Gemini special-case bails, and `findAnchor` falls back to **last
  `model-response`** → the original stale-turn bug. **This is my leading
  suspicion.** Fix: detect the dots without requiring them to be visible, OR
  match the inner lottie/svg, OR climb from the overlay differently.
- **(C) Stale dots.** Old `thinking-dots-animation` nodes linger in earlier
  turns; `querySelector` (first match) returns a stale one. Mitigated by using
  the *last visible* dots, but if (B) holds, visibility filtering is moot.
- **(D) The active turn genuinely isn't `dots.closest('model-response')`** —
  maybe the dots are in a different per-turn container than the streamed reply,
  or Gemini reuses/relocates nodes mid-stream.

---

## 4. Your plan (do this in order)

### Step 1 — Reproduce live and confirm which hypothesis holds
Open `gemini.google.com`, send a prompt, and **while the `...` dots show and the
bar is in the wrong place**, run this in the console (it captures visibility +
vertical positions + model-response indices):

```js
(() => {
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const top = el => el ? Math.round(el.getBoundingClientRect().top) : null;
  const mrs = [...document.querySelectorAll('model-response')];
  const dotsAll = [...document.querySelectorAll('thinking-dots-animation, .thinking-dots-animation')];
  const visDots = dotsAll.filter(vis);
  const activeDots = visDots[visDots.length - 1] || null;
  const bar = document.querySelector('.bb-bar');
  const users = [...document.querySelectorAll('user-query, [data-test-id="user-query"], .query-text, .query-content')];
  const lastUser = users[users.length - 1];
  console.log(JSON.stringify({
    extensionLoaded: !!window.__freeaiLoaded,
    modelResponses: mrs.length,
    totalDots: dotsAll.length,
    visibleDots: visDots.length,
    barShown: bar ? bar.classList.contains('bb-show') : 'no bar',
    barTop: top(bar),
    lastUserTop: top(lastUser),
    barIsAboveLastUser: (bar && lastUser) ? top(bar) < top(lastUser) : null,
    dotsModelResponseIndex: activeDots ? mrs.indexOf(activeDots.closest('model-response')) : 'no visible dots',
    barModelResponseIndex: bar ? mrs.indexOf(bar.closest('model-response')) : null,
  }, null, 2));
})();
```

Interpretation:
- `visibleDots: 0` → **hypothesis (B)** confirmed: the dots aren't visible, the
  special-case bails. Fix detection to not depend on dots visibility.
- `visibleDots ≥ 1` but `dotsModelResponseIndex !== barModelResponseIndex` →
  the special-case isn't running (stale code → reload, or a bug in `findAnchor`).
- `dotsModelResponseIndex === barModelResponseIndex` but
  `barIsAboveLastUser: true` → the dots' `model-response` itself sits above the
  user message — anchor to a different container (the active turn is identified
  differently than "the model-response containing the dots").

Also **dump the ancestor chain of the active dots AND the position of the newest
user message relative to the active model-response** — capture the real tag/class
of Gemini's user-message element (we've been guessing the selector):

```js
(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const dots = [...document.querySelectorAll('thinking-dots-animation, .thinking-dots-animation')].filter(vis).pop()
            || document.querySelector('thinking-dots-animation, .thinking-dots-animation');
  const chain = [];
  for (let n = dots; n && chain.length < 16; n = n.parentElement) {
    const s = getComputedStyle(n);
    chain.push({ tag: n.tagName.toLowerCase(), cls: (n.getAttribute('class')||'').slice(0,60),
      pos: s.position, display: s.display, h: Math.round(n.getBoundingClientRect().height) });
  }
  console.log(JSON.stringify(chain, null, 2));
})();
```

### Step 2 — Decide the real anchor
Use the captured DOM to pick a **stable, in-flow, per-turn container that is the
ACTIVE generating turn** and sits **below the user's newest message**. Candidates
to evaluate from the real chain: the `model-response` element, the
`.conversation-container` for the turn, or a `[id^="model-response-message-content"]`
/ `[data-...]` attribute if one exists. The right anchor must:
- be the **current** turn (newest), not a stale one;
- be reliably findable in the **dots-only** stage (don't depend on the absolutely
  positioned overlay having height);
- keep working once text streams in (bar stays its last child, below the text).

If "the model-response containing the dots" is correct but detection fails on
visibility, the fix is likely: **find the dots without the `isVisible` gate**
(they exist in the DOM even if 0-height), e.g.
`document.querySelectorAll('thinking-dots-animation')` → take the one whose
`closest('model-response')` is the **last** such turn, or match the inner
`.thinking-dots-animation`/`svg`. Be careful about stale dots in old turns —
prefer the dots whose `model-response` is **latest in document order** among
model-responses that currently contain dots.

### Step 3 — Implement in `findAnchor()` (content.js)
Keep the change **surgical to Gemini**; do not disturb Claude
(`div[data-test-render-count]`) or ChatGPT (`[data-message-author-role]`). The
Gemini branch runs first and returns early; the document-order fallback stays for
the others.

### Step 4 — Add a faithful regression test in `test/live.js`
Build the **real nested structure** (model-response › … › absolutely-positioned
thinking-overlay › thinking-dots-animation), include a **trailing empty
`model-response`** and a **newest user message above the active turn**, and assert
the bar anchors to the **active (dots') turn**, below the dots, **below the user
message** — not the trailing/stale one. If hypothesis (B), make the test's dots
**0-height** (overlay absolute) to prove detection no longer depends on
visibility. Match real Gemini quirks you discovered in Step 1.

### Step 5 — Verify for real
- `npm run lint && npm test && npm run test:live` all green.
- **Then load the unpacked `chrome-extension/` in a real Chrome with browser
  mode and watch Gemini's dots-only stage with your own eyes** — this is the
  whole reason you (a browser-capable session) are taking over. Synthetic tests
  passed before and reality still diverged, so **trust the live browser, not just
  the suite.** Confirm: dots-only places the bar directly under the dots in the
  active turn, below the user's latest message; no jump; fades out over 2 s.

### Step 6 — Ship
Commit on a `claude/<topic>` branch, push, open a PR (GitHub MCP), and squash-merge
once the user confirms. Update `test/live.js` if any other site's test has drifted
(the Claude test already drifted once because live.js isn't in CI).

---

## 5. Guardrails / gotchas

- **`test/live.js` is not in CI.** It drifts. When you change anchors, update its
  fixtures to match real DOM, and keep `npm test` (mock) green too.
- **Mock DOM (`test/run.js`)** is hand-rolled and minimal: elements report
  `getBoundingClientRect` = `{10,10}` (always "visible"), `closest` is **not**
  implemented on mock nodes — so guard `typeof el.closest === "function"` (the
  current code does). Don't write mock tests that need `closest`.
- **Don't regress the shipped wins:** one ad only (no rotation); only-while-
  thinking (no permanent bar on ChatGPT); 2 s fade-out with reserved box (no
  reflow); bar below the indicator on all three sites; impressions only while
  visible; mock/test-mode events never hit the network.
- **Visibility gate** on BUSY selectors was added on purpose (a hidden
  `aria-busy` region was pinning the bar on ChatGPT). If you loosen dots
  detection to ignore visibility, scope it to the dots only — don't drop the
  gate globally.
- **Per-sponsor colors** via `elChip.style` are the sanctioned exception to the
  no-hardcoded-color rule. Everything else is a `theme.css` token.

---

## 6. Quick orientation commands

```bash
cd /home/user/freeai.fyi
git fetch origin main && git checkout main && git pull origin main
sed -n '1,210p' chrome-extension/src/content.js     # detection + findAnchor + mount
cat chrome-extension/src/inject.css                 # fade / reserved-box
cd chrome-extension && npm run lint && npm test && npm run test:live
```

The current Gemini anchor logic is in `findAnchor()` near the top of
`content.js` — look for `lastVisibleMatch(["thinking-dots-animation", ...])` and
`dots.closest("model-response")`. Start there.

Good luck — the live browser is your advantage. Watch the dots-only stage
directly and let reality, not the synthetic fixture, drive the fix.
