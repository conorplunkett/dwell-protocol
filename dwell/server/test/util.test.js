// Unit tests for the pure helpers in src/util.js — no database needed.
// Run: node test/util.test.js
const assert = require("node:assert");
const { normalizeTimescale, resolveChangePct } = require("../src/util");

// The formatter lives client-side (green/red rendering is a UI concern), but the
// exact same digit rule is specified here and mirrored in web/script.js,
// chrome-extension/src/ads.js, terminal/src/util.js, and the macOS overlay. We
// re-implement it locally to lock the contract down in a server-side test too.
function formatChangePct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  let body;
  if (a >= 100) body = String(Math.min(999, Math.round(a)));
  else if (a >= 10) body = String(Math.round(a));
  else if (a >= 1) body = a.toFixed(1).replace(/\.0$/, "");
  else if (a > 0) { body = a.toFixed(1).replace(/^0/, ""); if (body === ".0") body = "0"; }
  else body = "0";
  return `(${v < 0 ? "-" : "+"}${body}%)`;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("util — recent-change % helpers\n");

check("formatChangePct: 3-digit and clamp", () => {
  assert.strictEqual(formatChangePct(235), "(+235%)");
  assert.strictEqual(formatChangePct(9363.96), "(+999%)"); // clamps to 999
  assert.strictEqual(formatChangePct(999), "(+999%)");
});
check("formatChangePct: 1–2 digit integers", () => {
  assert.strictEqual(formatChangePct(35), "(+35%)");
  assert.strictEqual(formatChangePct(9), "(+9%)");    // whole number, no forced decimal
  assert.strictEqual(formatChangePct(9.3), "(+9.3%)"); // fraction kept
  assert.strictEqual(formatChangePct(1), "(+1%)");
});
check("formatChangePct: sub-1 drops the leading zero", () => {
  assert.strictEqual(formatChangePct(0.5), "(+.5%)");
  assert.strictEqual(formatChangePct(-0.53), "(-.5%)");
});
check("formatChangePct: negatives and zero", () => {
  assert.strictEqual(formatChangePct(-1), "(-1%)");
  assert.strictEqual(formatChangePct(-47), "(-47%)");
  assert.strictEqual(formatChangePct(0), "(+0%)");
});
check("formatChangePct: non-finite → null (no badge)", () => {
  assert.strictEqual(formatChangePct(null), null);
  assert.strictEqual(formatChangePct(undefined), null);
  assert.strictEqual(formatChangePct(NaN), null);
});

check("resolveChangePct: auto picks the biggest window", () => {
  const changes = { "5m": 4.2, "15m": 12, "1h": 38, "4h": 96, "1d": 235 };
  assert.strictEqual(resolveChangePct(changes, "auto"), 235);
  assert.strictEqual(resolveChangePct(changes, undefined), 235); // missing → auto
});
check("resolveChangePct: auto on all-negative picks the least-negative", () => {
  assert.strictEqual(resolveChangePct({ "5m": -1, "1h": -8, "1d": -5 }, "auto"), -1);
});
check("resolveChangePct: a concrete window returns that value", () => {
  const changes = { "5m": 1.3, "1h": 8, "1d": 47 };
  assert.strictEqual(resolveChangePct(changes, "5m"), 1.3);
  assert.strictEqual(resolveChangePct(changes, "1d"), 47);
});
check("resolveChangePct: missing/empty data → null", () => {
  assert.strictEqual(resolveChangePct(null, "auto"), null);
  assert.strictEqual(resolveChangePct({}, "auto"), null);
  assert.strictEqual(resolveChangePct({ "1h": 8 }, "5m"), null); // window absent
});

check("normalizeTimescale: keeps the five windows, else 'auto'", () => {
  for (const t of ["5m", "15m", "1h", "4h", "1d"]) assert.strictEqual(normalizeTimescale(t), t);
  assert.strictEqual(normalizeTimescale("auto"), "auto");
  assert.strictEqual(normalizeTimescale("7d"), "auto");
  assert.strictEqual(normalizeTimescale(undefined), "auto");
});

console.log(`\nall ${passed} checks passed — change-% formatting and resolution.`);
