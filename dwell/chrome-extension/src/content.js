// Dwell Protocol — content script
// Detects when the AI assistant on this page is "thinking"/streaming, and shows
// ONE clickable sponsored line near the composer. The viewer earns DWELL points.
//
// Works on the three sites our ICP lives in — ChatGPT, Claude, and Google
// (Gemini / AI Studio) — plus a few more, via layered detection:
//   1) site-specific "stop generating" controls (most reliable)
//   2) a generic visible Stop button (aria-label contains "stop")
//   3) aria-busy live regions / known streaming class markers
//
// Test Mode (toggled from the popup) shows a clearly-labelled MOCK ad at all
// times on a supported page, so the whole thing can be verified without waiting
// for the model to actually generate.
(function () {
  if (window.__dwellLoaded) return;
  window.__dwellLoaded = true;

  // True only for a well-formed https URL — the sole scheme an ad destination is
  // ever allowed to open. Guards window.open against a hostile/garbled ad record.
  function isHttpsUrl(value) {
    try { return new URL(String(value)).protocol === "https:"; }
    catch (_) { return false; }
  }

  // Site-specific "the model is generating" controls. Each is the Stop button
  // that only exists while a response streams. Kept broad + case-insensitive so
  // small UI revisions don't silently break detection.
  // Each must denote a stop-GENERATION control, never an arbitrary element
  // whose label merely contains "stop". A bare aria-label*="stop" catch-all
  // matched ChatGPT sidebar conversation titles ("6 Train Not Stopping"),
  // pinning the bar on permanently — so we only match generation verbs.
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',            // ChatGPT
    'button[data-testid="stop-streaming"]',         // ChatGPT (older)
    'button[aria-label="Stop response"]',           // Claude
    'button[aria-label*="stop generating" i]',      // ChatGPT / generic
    'button[aria-label*="stop streaming" i]',       // generic
    'button[aria-label*="stop response" i]',        // Claude / Gemini variants
    'button[mattooltip*="stop" i]',                 // Gemini (Angular Material)
  ];
  const BUSY_SELECTORS = [
    '[aria-busy="true"]',
    ".result-streaming",
    "[data-is-streaming='true']",
    ".streaming-animation",
    ".thinking-dots-animation",    // Gemini — the ··· lottie before the reply renders
    "thinking-dots-animation",     // Gemini — the custom-element wrapper
    '[class*="thinking-dots"]',    // catch-all for either
    ".epitaxy-spark-working",      // Claude — the animated thinking star
  ];

  // Where to put the bar. Every anchor is a stable, in-flow container that
  // WRAPS the site's thinking indicator, so appending the bar as that
  // container's last child ("inside") lands it below the indicator (and below
  // any text that streams into the same container). findAnchor() picks the
  // candidate latest in document order, so a descendant container wins over an
  // ancestor.
  const ANCHORS = [
    // Claude — the per-turn container wraps the WHOLE assistant turn: the
    // thinking star, the "Thinking…" shimmer line, and the streamed reply. The
    // bar as its last child lands below all of them at every stage. Do NOT
    // anchor on [data-is-streaming="true"]: in the star-only stage that bubble
    // is EMPTY and sits ABOVE the star, so the bar mounted above the star.
    // (The old .epitaxy-spark-working / .epitaxy-transcript-width selectors were
    // removed when claude.ai rebuilt its thinking UI — they no longer match.)
    "div[data-test-render-count]",            // Claude — assistant turn container
    // ChatGPT — the stable per-message container. Anchor here and nowhere
    // nested: do NOT add .result-streaming as an anchor. It's a DESCENDANT of
    // this container, and findAnchor()'s "descendant beats ancestor" rule would
    // mount the bar INSIDE the streaming markdown — then ChatGPT appends the
    // finalized block after .result-streaming, stranding the bar above it for a
    // beat ("snaps up, then back"). The bar as this container's last child
    // stays below all streamed content the whole time. (.result-streaming
    // remains a detection signal in BUSY_SELECTORS.)
    '[data-message-author-role="assistant"]', // ChatGPT
    // Gemini — last-resort only. findAnchor() handles Gemini by climbing from
    // the newest <user-query> to its `.conversation-container` (the active
    // turn); this bare <model-response> is reached only if that fails. Gemini
    // keeps many model-responses around and the active one is often not last in
    // the DOM, so a document-order pick here can land the bar in a stale turn —
    // which is exactly why the .conversation-container path runs first.
    "model-response",                         // Gemini (fallback)
  ];

  let ads = [];
  let mockAd = (typeof self !== "undefined" && self.BB_MOCK_AD) || null;
  // House/default ad — filler shown only when the auction is empty. Never billed.
  let houseAd = (typeof self !== "undefined" && self.BB_DEFAULT_AD) || null;
  // Admin killswitch for the house ad (mirrors /v1/config → houseAdEnabled).
  let houseEnabled = true;
  let enabled = true;
  let testMode = false;
  let active = false;
  let demoUntil = 0;
  let lastImpressionAt = 0;

  // ---------- safe messaging (service worker may be asleep / context torn down) ----------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // swallow
          resolve(resp);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // ---------- build the injected sponsored bar ----------
  const bar = document.createElement("div");
  bar.className = "bb-bar";
  bar.setAttribute("role", "complementary");
  bar.innerHTML =
    '<span class="bb-chip">🐂</span>' +
    '<span class="bb-name">$ansem</span>' +
    '<span class="bb-change up">(+235%)</span>' +
    '<span class="bb-line">the black bull</span>';
  const elChip = bar.querySelector(".bb-chip");
  const elName = bar.querySelector(".bb-name");
  const elLine = bar.querySelector(".bb-line");
  const elChange = bar.querySelector(".bb-change");

  // The ad currently on screen. We surface ONE ad at a time — the top of the
  // returned inventory (the auction winner) — and never rotate within a page;
  // cycling through several ads in one session read as spammy.
  function currentAd() {
    if (testMode) return mockAd || (ads.length ? ads[0] : null);
    if (ads.length) return ads[0];
    // No live inventory: fall back to the house ad so the bar promotes DWELL
    // instead of going blank — unless the admin turned it off. It's filler:
    // tick() never bills it (see below).
    return houseEnabled ? houseAd : null;
  }

  bar.addEventListener("click", () => {
    const ad = currentAd();
    if (!ad) return;
    // Live ads carry a campaign id so the click is recorded server-side through
    // a single-use token; mock/bundled ads have none and just open the URL.
    // window.open MUST run synchronously inside the click gesture — awaiting
    // the service-worker round-trip first drops the user-activation and popup
    // blockers silently eat the navigation. The click report rides along async.
    // The house/default ad reports nothing — it just opens the advertise page.
    if (!ad.house) send({ type: "BB_CLICK", mock: !!ad.mock, campaignId: ad.id });
    // Only ever open an https destination. The backend validates the URL at
    // advertiser checkout, but the content script must not trust that: an
    // unexpected scheme (javascript:, data:, a custom app scheme) from a bad ad
    // record is refused here rather than navigated to.
    if (isHttpsUrl(ad.url)) window.open(ad.url, "_blank", "noopener");
  });

  // Attach the bar inline at the streaming reply. If no anchor exists yet the
  // bar stays HIDDEN — it must never flash at the bottom of the page before
  // the reply area appears. (The fixed bottom pill survives only for the
  // popup's 30s demo, which runs without any generation.) Re-checked every
  // tick because these apps re-render aggressively (React may evict us) and
  // the anchor often appears a beat after the Stop button.
  let anchorEl = null;
  let lastReposition = 0;
  function findAnchor() {
    // Gemini: anchor to the conversation turn that holds the NEWEST user
    // message, not the last <model-response> in the DOM. Gemini wraps each Q&A
    // turn in a `.conversation-container`; while the model is only showing its
    // loading spinner the new turn's <model-response> hasn't rendered yet, so
    // the only <model-response> present is the PREVIOUS (stale) turn — a
    // document-order pick lands the bar there, ABOVE the user's newest message.
    // The turn container and the <user-query> inside it exist from the moment
    // the prompt is sent (during the spinner stage it's a
    // <pending-request class="conversation-container">, later swapped for a real
    // <div class="conversation-container">), so climbing from the last
    // <user-query> to its `.conversation-container` keeps the bar below the
    // user's message and below the reply at every stage. (Gemini replaced the
    // old <thinking-dots-animation> we used to climb from with a detached,
    // page-level <chat-loading-animation> overlay that isn't inside the turn.)
    const users = document.querySelectorAll("user-query");
    if (users.length) {
      const lastUser = users[users.length - 1];
      if (lastUser && typeof lastUser.closest === "function") {
        const turn = lastUser.closest(".conversation-container");
        if (turn) return turn;
      }
    }
    // Everything else: collect one candidate per selector, then pick the
    // candidate LATEST in document order (a descendant beats its ancestor).
    // Priority lists fail here: e.g. Claude keeps an empty streaming bubble
    // ABOVE the thinking star, and anchoring there put the bar above the star.
    const candidates = [];
    for (const sel of ANCHORS) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) candidates.push(els[els.length - 1]);
      } catch (_) {}
    }
    if (!candidates.length) return null;
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        if (
          best !== c &&
          typeof best.compareDocumentPosition === "function" &&
          best.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          best = c;
        }
      } catch (_) {}
    }
    return best;
  }
  // Returns true when the bar has somewhere legitimate to live.
  // Re-checked every tick: these apps keep inserting elements (the star, the
  // dots, streamed text) after we mount, so we re-assert the bar's position.
  function mount() {
    const el = findAnchor();
    if (el) {
      try {
        if (typeof el.appendChild === "function") {
          // keep the bar as the last child of the reply container, below the
          // thinking indicator and any streamed text.
          //
          // CRITICAL: while a reply streams, the site appends new nodes after
          // the bar on nearly every frame, so "am I still last?" fails on
          // nearly every tick. Re-appending on each tick moved a
          // backdrop-filtered element inside a React/Angular-managed container
          // ~10x/second — fighting the framework's reconciliation (the classic
          // removeChild NotFoundError that white-screens the whole app) and
          // forcing constant GPU re-rasterization. That is what made the host
          // tab lock up / crash. So: re-attach immediately only when the bar
          // was evicted entirely, and re-assert "last child" at most ~1x/sec.
          const now = Date.now();
          if (bar.parentElement !== el) {
            el.appendChild(bar);
            lastReposition = now;
          } else if (el.lastElementChild !== bar && now - lastReposition >= 1000) {
            el.appendChild(bar);
            lastReposition = now;
          }
          anchorEl = el;
          bar.classList.add("bb-inline");
          return true;
        }
      } catch (_) {}
    }
    anchorEl = null;
    if (Date.now() < demoUntil) {
      // demo only: fixed pill above the composer (no reply area to anchor to)
      bar.classList.remove("bb-inline");
      if (!bar.isConnected && document.body) document.body.appendChild(bar);
      return true;
    }
    return false; // thinking, but the reply area isn't in the DOM yet — stay hidden
  }

  // ---------- render ----------
  function render() {
    const ad = currentAd();
    if (ad) {
      elChip.textContent = ad.chip;
      elChip.style.background = ad.color;
      elChip.style.color = ad.ink;
      // logo · brand · message — brand is its own bold element. Hide it if an
      // ad somehow arrives without one so we don't render an empty gap.
      elName.textContent = ad.brand || "";
      elName.style.display = ad.brand ? "" : "none";
      elLine.textContent = ad.line;
      // Recent-change % badge — green up / red down; hidden when the ad carries
      // no change data (real campaigns until live market data is wired).
      if (elChange) {
        const badge = self.BB_changeBadge ? self.BB_changeBadge(ad) : null;
        elChange.textContent = badge ? badge.text : "";
        elChange.style.display = badge ? "" : "none";
        elChange.classList.toggle("up", !!badge && badge.dir === "up");
        elChange.classList.toggle("down", !!badge && badge.dir === "down");
      }
    }
    // Head-only ad: no sub-tag pill. Keep the bb-test class so test-mode ads
    // stay visually distinguishable (and the live tests can assert on it).
    if (testMode) bar.classList.add("bb-test");
    else bar.classList.remove("bb-test");
  }

  // ---------- generation detector ----------
  function isVisible(el) {
    if (!el) return false;
    if (typeof el.getBoundingClientRect !== "function") return true; // test/mock DOM
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isThinking() {
    // NB: Test Mode no longer forces the bar on — it swaps in the mock ad, but
    // the bar still only shows while the model is actually generating.
    if (Date.now() < demoUntil) return true;
    for (const sel of STOP_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (const el of els) if (isVisible(el)) return true;
    }
    // Busy/streaming markers must also be VISIBLE. A persistent-but-hidden
    // match (e.g. an always-present aria-busy live region) otherwise pins the
    // bar "on" forever — which is what regressed on ChatGPT.
    for (const sel of BUSY_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (const el of els) if (isVisible(el)) return true;
    }
    return false;
  }

  // ---------- main loop ----------
  let spinTimer = null;
  function startActive() {
    if (active) return;
    active = true;
    if (mount()) bar.classList.add("bb-show"); // else: tick() shows it once the reply area exists
    render();
    lastImpressionAt = 0;
    // 250ms is plenty: the bar re-anchors at most ~1x/sec and impressions tick
    // every 2s. The old 100ms loop was a large part of the CPU/layout churn.
    spinTimer = setInterval(tick, 250);
  }
  function stopActive() {
    if (!active) return;
    active = false;
    bar.classList.remove("bb-show");
    if (spinTimer) clearInterval(spinTimer);
    spinTimer = null;
  }
  function tick() {
    // keep the bar pinned to the streaming reply across re-renders; show only
    // once an anchor exists so it never starts at the bottom of the page
    if (mount()) bar.classList.add("bb-show");
    else bar.classList.remove("bb-show");
    render();
    // one impression every 2s of serving — only while actually visible
    if (!bar.classList.contains("bb-show")) return;
    // The house/default ad is filler shown only when the auction is empty — it
    // must never count an impression or view, since no advertiser paid for it.
    const shown = currentAd();
    if (shown && shown.house) return;
    const now = Date.now();
    if (now - lastImpressionAt >= 2000) {
      // The FIRST qualifying view of a session is one ad the user actually saw.
      // Every later tick re-bills the SAME on-screen ad (we never rotate within
      // a page), so it's another impression but NOT another ad watched — a long
      // generation would otherwise inflate "ads watched" to a 2s-tick count
      // (4 queries → 24) even though only one ad was ever shown. lastImpressionAt
      // is reset to 0 in startActive(), so it's exactly 0 on the first tick.
      const firstViewOfSession = lastImpressionAt === 0;
      lastImpressionAt = now;
      send({ type: "BB_IMPRESSION", mock: testMode });
      if (firstViewOfSession) send({ type: "BB_VIEW", mock: testMode });
    }
  }

  function evaluate() {
    // Hidden tab: nobody can see the bar, so don't serve (or bill) there —
    // and skip the whole selector/layout sweep while backgrounded.
    if (!enabled || document.hidden === true) {
      stopActive();
      return;
    }
    if (isThinking()) startActive();
    else stopActive();
  }

  // poll the page state ~3x/sec (cheap; observers on these apps are noisy)
  const pollTimer = setInterval(evaluate, 350);

  // ---------- messages from the popup ----------
  chrome.runtime.onMessage.addListener((msg, _s, resp) => {
    if (msg.type === "BB_DEMO") {
      demoUntil = Date.now() + (msg.ms || 30000);
      resp && resp({ ok: true });
    }
    if (msg.type === "BB_REFRESH") {
      bootstrap().then(() => evaluate());
      resp && resp({ ok: true });
    }
  });

  // ---------- bootstrap ----------
  async function bootstrap() {
    const state = await send({ type: "BB_GET_STATE" });
    // Honour both the user toggle and the server killswitch (state.serving).
    enabled = state ? state.enabled !== false && state.serving !== false : true;
    testMode = state ? !!state.testMode : false;
    houseEnabled = state ? state.houseAdEnabled !== false : true;
    // Only ever show what the service worker vouches for (live, funded
    // inventory). No local fallback to the bundled demo list: an ad that no
    // campaign paid for must never render or count as earned.
    ads = (await send({ type: "BB_GET_ADS" })) || [];
    if (state && state.mockAd) mockAd = state.mockAd;
    evaluate();
  }
  bootstrap();

  // ---------- test hook (used by the headless harness; harmless in prod) ----------
  window.__dwellTest = {
    isThinking,
    evaluate,
    tick,
    bar,
    isActive: () => active,
    currentAd,
    setState: (s) => {
      enabled = s.enabled !== false;
      testMode = !!s.testMode;
      if (Array.isArray(s.ads)) ads = s.ads;
      if (s.mockAd) mockAd = s.mockAd;
      if (s.houseAd) houseAd = s.houseAd;
      if (typeof s.houseAdEnabled === "boolean") houseEnabled = s.houseAdEnabled;
    },
    _stopTimers: () => {
      clearInterval(pollTimer);
      if (spinTimer) clearInterval(spinTimer);
    },
  };
})();
