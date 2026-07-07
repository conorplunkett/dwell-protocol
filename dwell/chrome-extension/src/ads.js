// Demo ad inventory — popup board + Test Mode display ONLY.
// Attached to globalThis so it works in content scripts, the popup, and the
// service worker (via importScripts). These brands never paid anything, so
// they are NEVER served as real ads and never earn: real serving uses only
// the live inventory from /v1/ads (funded campaigns), and when the auction
// is empty no ad shows at all.
(function (g) {
  g.BB_ADS = [
    { brand: "Fluidstack", chip: "F", color: "#1d6cff", ink: "#fff", line: "building 10GW of compute — join us.", url: "https://dwellprotocol.com/go/fluidstack", cat: "infra" },
    { brand: "Ramp", chip: "R", color: "#ffd54a", ink: "#1b1e25", line: "save time and money", url: "https://dwellprotocol.com/go/ramp", cat: "finance" },
    { brand: "Linear", chip: "L", color: "#5b5bd6", ink: "#fff", line: "issue tracking built for speed", url: "https://dwellprotocol.com/go/linear", cat: "devtools" },
    { brand: "Tuple", chip: "T", color: "#7c3aed", ink: "#fff", line: "the remote pairing app devs love", url: "https://dwellprotocol.com/go/tuple", cat: "devtools" },
    { brand: "Vercel", chip: "△", color: "#000", ink: "#fff", line: "ship your agent to prod", url: "https://dwellprotocol.com/go/vercel", cat: "infra" },
    { brand: "Neon", chip: "N", color: "#00e599", ink: "#04130a", line: "Postgres your agent can branch", url: "https://dwellprotocol.com/go/neon", cat: "infra" },
    { brand: "Resend", chip: "R", color: "#111", ink: "#fff", line: "email for developers", url: "https://dwellprotocol.com/go/resend", cat: "devtools" },
    { brand: "querybear", chip: "Q", color: "#f59e0b", ink: "#1b1e25", line: "talk to your database with MCP", url: "https://dwellprotocol.com/go/querybear", cat: "devtools" },
    { brand: "Solo", chip: "S", color: "#0ea5e9", ink: "#fff", line: "a better place to run your agents", url: "https://dwellprotocol.com/go/solo", cat: "infra" },
    { brand: "Liner", chip: "L", color: "#10b981", ink: "#fff", line: "the most performant & affordable search", url: "https://dwellprotocol.com/go/liner", cat: "ai" }
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
