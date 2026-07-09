// Small shared helpers.

// Escape text for safe interpolation into HTML. Ad lines are advertiser-supplied
// and rendered on the site, the admin page, and the extension webview — so every
// one of those render paths must run untrusted text through this.
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"'/]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "/": "&#47;",
  }[ch]));
}

// Ad-line intake validation (defense in depth on top of render-time escaping):
// printable text, no angle brackets, no control chars, 3–60 chars.
function isCleanAdLine(s) {
  if (typeof s !== "string") return false;
  if (s.length < 3 || s.length > 60) return false;
  if (s.includes("<") || s.includes(">")) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false; // reject control characters
  }
  return true;
}

// Advertiser-supplied accent color. Accept "#rrggbb" or bare "rrggbb"; return
// canonical lowercase "#rrggbb", or null when absent/invalid (the client then
// falls back to a per-brand color).
function normalizeHexColor(value) {
  if (value == null || value === "") return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

// Performance-window keys for the recent-change % badge. 'auto' (the default) is
// NOT offered on the public ad form — it renders whichever window is biggest.
const TIMESCALES = ["5m", "15m", "1h", "4h", "1d"];

// Normalize an advertiser-supplied timescale to a stored value: one of the five
// concrete windows, else 'auto'. Anything unrecognized (including 'auto' itself
// arriving from an API caller) falls back to 'auto'.
function normalizeTimescale(value) {
  return TIMESCALES.includes(value) ? value : "auto";
}

// Resolve a per-timescale change map to the single number a client should show.
// A concrete timescale picks that window; 'auto' (or a missing/absent window)
// picks the biggest (most positive) value. Returns null when there's no data so
// the client renders no badge.
function resolveChangePct(changes, timescale) {
  if (!changes || typeof changes !== "object") return null;
  const vals = TIMESCALES
    .map((k) => changes[k])
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return null;
  if (timescale && timescale !== "auto") {
    const v = changes[timescale];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return Math.max(...vals);
}

module.exports = { escapeHtml, isCleanAdLine, normalizeHexColor, TIMESCALES, normalizeTimescale, resolveChangePct };
