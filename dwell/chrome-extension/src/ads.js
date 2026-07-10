// Demo ad inventory — popup board + Test Mode display ONLY.
// Attached to globalThis so it works in content scripts, the popup, and the
// service worker (via importScripts). These brands never paid anything, so
// they are NEVER served as real ads and never earn: real serving uses only
// the live inventory from /v1/ads (funded campaigns), and when the auction
// is empty no ad shows at all.
(function (g) {
  // Recent-change % badge helpers, shared by content.js + popup.js. `timescale:
  // "auto"` renders whichever window is biggest; a concrete key renders that one.
  // Format: signed, ≤3 significant digit-chars, leading zero dropped, magnitude
  // clamped to 999. Mirrors resolveChangePct/formatChangePct in server/src/util.js.
  const TS = ["5m", "15m", "1h", "4h", "1d"];
  g.BB_resolveChange = function (changes, timescale) {
    if (!changes) return null;
    const vals = TS.map((k) => changes[k]).filter((v) => typeof v === "number" && isFinite(v));
    if (!vals.length) return null;
    if (timescale && timescale !== "auto") {
      const v = changes[timescale];
      return typeof v === "number" && isFinite(v) ? v : null;
    }
    return Math.max(...vals);
  };
  g.BB_formatChange = function (v) {
    if (typeof v !== "number" || !isFinite(v)) return null;
    const a = Math.abs(v);
    let body;
    if (a >= 100) body = String(Math.min(999, Math.round(a)));
    else if (a >= 10) body = String(Math.round(a));
    else if (a >= 1) body = a.toFixed(1).replace(/\.0$/, "");
    else if (a > 0) { body = a.toFixed(1).replace(/^0/, ""); if (body === ".0") body = "0"; }
    else body = "0";
    return "(" + (v < 0 ? "-" : "+") + body + "%)";
  };
  // Resolve a raw numeric `change` (server ads) or a `changes`+`timescale` map
  // (demo ads) to the formatted string + up/down class, or null when no data.
  g.BB_changeBadge = function (ad) {
    if (!ad) return null;
    const v = typeof ad.change === "number" ? ad.change : g.BB_resolveChange(ad.changes, ad.timescale);
    const s = g.BB_formatChange(v);
    return s == null ? null : { text: s, dir: v < 0 ? "down" : "up" };
  };
  // Resolve a demo ad's bundled `img` (a path relative to the extension root) to
  // a loadable chrome-extension:// URL — works in the popup and, via
  // web_accessible_resources, in the injected bar. Null when the ad has no logo
  // (real served ads) or chrome.runtime isn't available (tests) — callers then
  // fall back to the letter/emoji chip.
  g.BB_chipImg = function (ad) {
    if (!ad || !ad.img) return null;
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(ad.img);
    } catch (_) { /* not in an extension context */ }
    return null;
  };

  g.BB_ADS = [
    { brand: "$ansem", chip: "🐂", img: "assets/tokens/ansem.png", color: "#0a0a0a", ink: "#fff", line: "the black bull", url: "https://dwellprotocol.com/go/ansem", cat: "crypto", timescale: "auto", changes: { "5m": 4.2, "15m": 12, "1h": 38, "4h": 96, "1d": 235 } },
    { brand: "$troll", chip: "🧌", img: "assets/tokens/troll.png", color: "#f2f2f2", ink: "#1b1e25", line: "troll szn is upon us", url: "https://dwellprotocol.com/go/troll", cat: "crypto", timescale: "auto", changes: { "5m": 2.1, "15m": 9, "1h": 21, "4h": -7, "1d": 64 } },
    { brand: "$pepe", chip: "🐸", img: "assets/tokens/pepe.png", color: "#4c9a2a", ink: "#fff", line: "the most memeable memecoin", url: "https://dwellprotocol.com/go/pepe", cat: "crypto", timescale: "5m", changes: { "5m": 1.3, "15m": 3, "1h": 8, "4h": 19, "1d": 47 } },
    { brand: "$fwog", chip: "🐸", img: "assets/tokens/fwog.png", color: "#7fae6e", ink: "#1b1e25", line: "just a little fwog", url: "https://dwellprotocol.com/go/fwog", cat: "crypto", timescale: "auto", changes: { "5m": 3, "15m": 7, "1h": 15, "4h": 33, "1d": 88 } },
    { brand: "$chillguy", chip: "😎", img: "assets/tokens/chillguy.png", color: "#d2a679", ink: "#1b1e25", line: "just a chill guy", url: "https://dwellprotocol.com/go/chillguy", cat: "crypto", timescale: "auto", changes: { "5m": -1, "15m": -3, "1h": -2, "4h": -8, "1d": -5 } }
  ];

  // The mock ad shown in Test Mode. Deliberately obvious so it can never be
  // mistaken for real, billable inventory. Clicking it opens the DWELL test
  // page instead of an advertiser URL.
  g.BB_MOCK_AD = {
    brand: "DWELL Test",
    chip: "✓",
    color: "#ff0000", // DWELL brand red (--accent) — our own test ad, not a sponsor
    ink: "#fff",
    line: "this is a test ad — what advertisers will see here.",
    url: "https://dwellprotocol.com/?test=1",
    cat: "test",
    mock: true
  };
})(typeof self !== "undefined" ? self : window);
