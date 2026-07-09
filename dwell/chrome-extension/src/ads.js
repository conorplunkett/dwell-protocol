// Demo ad inventory — popup board + Test Mode display ONLY.
// Attached to globalThis so it works in content scripts, the popup, and the
// service worker (via importScripts). These brands never paid anything, so
// they are NEVER served as real ads and never earn: real serving uses only
// the live inventory from /v1/ads (funded campaigns), and when the auction
// is empty no ad shows at all.
(function (g) {
  g.BB_ADS = [
    { brand: "$ansem", chip: "🐂", color: "#0a0a0a", ink: "#fff", line: "the black bull", url: "https://dwellprotocol.com/go/ansem", cat: "crypto" },
    { brand: "$troll", chip: "🧌", color: "#3f6212", ink: "#fff", line: "troll szn is upon us", url: "https://dwellprotocol.com/go/troll", cat: "crypto" },
    { brand: "$pepe", chip: "🐸", color: "#4c9a2a", ink: "#fff", line: "the most memeable memecoin", url: "https://dwellprotocol.com/go/pepe", cat: "crypto" },
    { brand: "$chillguy", chip: "😎", color: "#d2a679", ink: "#1b1e25", line: "just a chill guy", url: "https://dwellprotocol.com/go/chillguy", cat: "crypto" }
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
