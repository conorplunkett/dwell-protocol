// --- Recent-change % badge (the crypto-ticker figure next to each token) ---
// Shared by the ticker, the "With DWELL" rotator, and the advertiser preview.
// `timescale: "auto"` renders whichever window is biggest; a concrete key
// ("5m"/"15m"/"1h"/"4h"/"1d") renders that window. Format: signed, at most 3
// significant digit-chars, leading zero dropped, magnitude clamped to 999.
// Green when up, red when down. Mirrors resolveChangePct in server/src/util.js.
const CHANGE_TIMESCALES = ["5m", "15m", "1h", "4h", "1d"];
function resolveChangePct(changes, timescale) {
  if (!changes) return null;
  const vals = CHANGE_TIMESCALES.map((k) => changes[k]).filter((v) => typeof v === "number" && isFinite(v));
  if (!vals.length) return null;
  if (timescale && timescale !== "auto") {
    const v = changes[timescale];
    return typeof v === "number" && isFinite(v) ? v : null;
  }
  return Math.max(...vals);
}
function formatChangePct(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const a = Math.abs(v);
  let body;
  if (a >= 100) body = String(Math.min(999, Math.round(a)));   // 235, 9364→999
  else if (a >= 10) body = String(Math.round(a));               // 35
  else if (a >= 1) body = a.toFixed(1).replace(/\.0$/, "");     // 9.3, but 9.0→9
  else if (a > 0) { body = a.toFixed(1).replace(/^0/, ""); if (body === ".0") body = "0"; } // .5 (leading 0 dropped)
  else body = "0";
  return `(${v < 0 ? "-" : "+"}${body}%)`;
}
// Inline badge markup for a token/ad carrying `changes`+`timescale` (or a raw
// numeric `change` straight off the API). Returns "" when there's no data.
function changeBadgeHtml(src) {
  const v = src && typeof src.change === "number" ? src.change : resolveChangePct(src && src.changes, src && src.timescale);
  const s = formatChangePct(v);
  if (s == null) return "";
  return `<span class="change-badge ${v < 0 ? "down" : "up"}">${s}</span>`;
}

// --- Live ticker (top banner) ---
// Seeded with mock winning bids. When the API is wired, the leaderboard feed
// can populate this the same way loadLeaderboard() fills the board below.
// Each entry carries a little brand logo chip (initial + brand color) shown
// before the name in the moving banner, plus a recent-change % badge.
const TICKER_ADS = [
  { brand: "$ansem", img: "assets/tokens/ansem.png", color: "#0a0a0a", text: "The black bull runs", timescale: "auto", changes: { "5m": 4.2, "15m": 12, "1h": 38, "4h": 96, "1d": 235 } },
  { brand: "$troll", img: "assets/tokens/troll.png", color: "#f2f2f2", text: "Troll szn is upon us", timescale: "auto", changes: { "5m": 2.1, "15m": 9, "1h": 21, "4h": -7, "1d": 64 } },
  { brand: "$pepe", img: "assets/tokens/pepe.png", color: "#4c9a2a", text: "The most memeable memecoin on Solana", timescale: "5m", changes: { "5m": 1.3, "15m": 3, "1h": 8, "4h": 19, "1d": 47 } },
  { brand: "$fwog", img: "assets/tokens/fwog.png", color: "#7fae6e", text: "Just a little fwog", timescale: "auto", changes: { "5m": 3, "15m": 7, "1h": 15, "4h": 33, "1d": 88 } },
  { brand: "$chillguy", img: "assets/tokens/chillguy.png", color: "#8c9a76", text: "Just a chill guy", timescale: "auto", changes: { "5m": -1, "15m": -3, "1h": -2, "4h": -8, "1d": -5 } },
];
(function buildTicker() {
  const track = document.getElementById("ticker-track");
  if (!track) return;
  const cell = (ad) =>
    `<span class="tick">` +
    `<span class="tick-logo" style="background:${ad.color}"><img src="${ad.img}" alt="" loading="lazy" /></span>` +
    `<span class="tick-brand">${ad.brand}</span>` +
    changeBadgeHtml(ad) +
    `<span class="tick-text">${ad.text}</span></span>`;
  // Duplicate the run so the -50% scroll loops seamlessly.
  const run = TICKER_ADS.map(cell).join("");
  track.innerHTML = run + run;
})();

// --- Stock-side spinner word rotation (the "before" card) ---
const STOCK_WORDS = [
  "Baking", "Discombobulating", "Percolating", "Simmering", "Marinating",
  "Computing", "Vibing", "Noodling", "Ruminating", "Conjuring",
];
let sw = 0;
const wordStock = document.getElementById("word-stock");
if (wordStock) {
  setInterval(() => {
    sw = (sw + 1) % STOCK_WORDS.length;
    wordStock.textContent = STOCK_WORDS[sw];
  }, 1600);
}

// --- Sponsored ad rotation (the "with DWELL" line) ---
// Sponsored lines for the "With DWELL" card. Each chip carries the sponsor's
// own brand color; copy follows one house style — "Brand · Sentence-case line"
// with a middot separator — to stay consistent with TICKER_ADS above.
// Keep each line short — it must fit ONE line in the demo card at both desktop
// and mobile widths (verified per-ad; see styles.css .brand-line).
const ADS = [
  { img: "assets/tokens/ansem.png", color: "#0a0a0a", text: "$ansem · The black bull", timescale: "auto", changes: { "5m": 4.2, "15m": 12, "1h": 38, "4h": 96, "1d": 235 } },
  { img: "assets/tokens/troll.png", color: "#f2f2f2", text: "$troll · Troll szn", timescale: "auto", changes: { "5m": 2.1, "15m": 9, "1h": 21, "4h": -7, "1d": 64 } },
  { img: "assets/tokens/pepe.png", color: "#4c9a2a", text: "$pepe · Feels good man", timescale: "5m", changes: { "5m": 1.3, "15m": 3, "1h": 8, "4h": 19, "1d": 47 } },
  { img: "assets/tokens/fwog.png", color: "#7fae6e", text: "$fwog · Just a little fwog", timescale: "auto", changes: { "5m": 3, "15m": 7, "1h": 15, "4h": 33, "1d": 88 } },
  { img: "assets/tokens/chillguy.png", color: "#8c9a76", text: "$chillguy · Just a chill guy", timescale: "auto", changes: { "5m": -1, "15m": -3, "1h": -2, "4h": -8, "1d": -5 } },
];
// Warm the cache so the rotating chip swaps its background-image instantly and
// never flashes the previous token's logo mid-transition.
[...TICKER_ADS, ...ADS].forEach((a) => { if (a.img) { const im = new Image(); im.src = a.img; } });
let ai = 0;
const rotator = document.getElementById("brand-line");
const chip = document.querySelector(".brandchip");
const brandChange = document.getElementById("brand-change");
// Paint the token logo into the round chip (background-image so the same span
// works for the static first frame in the HTML).
function paintChip(ad) {
  if (!chip) return;
  chip.textContent = "";
  chip.style.backgroundColor = ad.color;
  chip.style.backgroundImage = `url("${ad.img}")`;
  chip.style.backgroundSize = "cover";
  chip.style.backgroundPosition = "center";
}
// Paint the badge (text + up/down color) for the ad at ADS[i].
function paintBrandChange(ad) {
  if (!brandChange) return;
  const v = resolveChangePct(ad.changes, ad.timescale);
  const s = formatChangePct(v);
  brandChange.textContent = s || "";
  brandChange.classList.toggle("up", s != null && v >= 0);
  brandChange.classList.toggle("down", s != null && v < 0);
}
// Paint the first ad immediately so the "With DWELL" line is never empty,
// even before the first rotation tick.
if (rotator && chip) {
  const first = ADS[0];
  rotator.textContent = first.text;
  paintChip(first);
  rotator.style.opacity = "1";
  chip.style.opacity = "1";
  paintBrandChange(first);
}
setInterval(() => {
  ai = (ai + 1) % ADS.length;
  const ad = ADS[ai];
  if (!rotator || !chip) return;
  rotator.style.opacity = "0";
  chip.style.opacity = "0";
  if (brandChange) brandChange.style.opacity = "0";
  setTimeout(() => {
    rotator.textContent = ad.text;
    paintChip(ad);
    rotator.style.opacity = "1";
    chip.style.opacity = "1";
    paintBrandChange(ad);
    if (brandChange) brandChange.style.opacity = "1";
  }, 260);
}, 2600);
if (brandChange) { brandChange.style.transition = "opacity .26s"; }
if (rotator) { rotator.style.transition = "opacity .26s"; }
if (chip) { chip.style.transition = "opacity .26s, background .26s"; }

// --- Ad line character counter ---
const adline = document.getElementById("adline");
const adlineCount = document.getElementById("adline-count");
if (adline) {
  adline.addEventListener("input", () => {
    adlineCount.textContent = `${adline.value.length} / 60`;
  });
}

// --- Ad color: keep the swatch picker and the #hex text field in sync ---
const adcolor = document.getElementById("adcolor");
const adcolorSwatch = document.getElementById("adcolor-swatch");
if (adcolor && adcolorSwatch) {
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);
  // Picker → text: write the chosen hex (lowercase, with #).
  adcolorSwatch.addEventListener("input", () => {
    adcolor.value = adcolorSwatch.value.toLowerCase();
  });
  // Text → picker: mirror a complete #rrggbb into the swatch. The field is
  // optional, so a blank or mid-typing value just leaves the swatch as-is.
  adcolor.addEventListener("input", () => {
    const v = adcolor.value.trim();
    const hex = v.startsWith("#") ? v : `#${v}`;
    if (isHex(hex)) adcolorSwatch.value = hex.toLowerCase();
  });
}

// --- Brand icon dropzone: click-to-browse + drag-and-drop. Click-to-browse
// relies on the browser's native label→input forwarding (the file input is a
// hidden descendant of the same <label>), so there's no explicit click handler
// here — that would double-open the file dialog. Enter/Space on the dropzone
// (role="button", tabindex) covers keyboard users, since a hidden input isn't
// tabbable. Preview-only for now: there's no backend endpoint to upload the
// icon yet, so the file just previews client-side. ---
const iconDropzone = document.getElementById("icon-dropzone");
const iconInput = document.getElementById("icon-input");
const iconMsg = document.getElementById("dropzone-msg");
const iconPreview = document.getElementById("dropzone-preview");
const iconThumb = document.getElementById("dropzone-thumb");
const iconName = document.getElementById("dropzone-name");
const iconRemove = document.getElementById("dropzone-remove");
if (iconDropzone && iconInput) {
  const MAX_ICON_BYTES = 64 * 1024;
  const ICON_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const showIconError = (msg) => {
    iconMsg.textContent = msg;
    iconMsg.classList.add("dropzone-msg--err");
    iconInput.value = "";
  };
  const acceptIconFile = (file) => {
    if (!file) return;
    if (!ICON_TYPES.includes(file.type)) return showIconError("PNG, JPG, or WebP only — try again.");
    if (file.size > MAX_ICON_BYTES) return showIconError(`That's ${Math.ceil(file.size / 1024)} KB — 64 KB max. Try a smaller image.`);
    const reader = new FileReader();
    reader.onload = () => {
      iconThumb.src = reader.result;
      iconName.textContent = file.name;
      iconMsg.hidden = true;
      iconMsg.classList.remove("dropzone-msg--err");
      iconPreview.hidden = false;
      iconDropzone.classList.add("dropzone--filled");
    };
    reader.readAsDataURL(file);
  };
  const clearIcon = () => {
    iconInput.value = "";
    iconPreview.hidden = true;
    iconMsg.hidden = false;
    iconMsg.textContent = "Drop an image here or click to browse";
    iconMsg.classList.remove("dropzone-msg--err");
    iconDropzone.classList.remove("dropzone--filled");
  };
  iconInput.addEventListener("change", () => acceptIconFile(iconInput.files?.[0]));
  iconDropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); iconInput.click(); }
  });
  iconDropzone.addEventListener("dragover", (e) => { e.preventDefault(); iconDropzone.classList.add("dropzone--drag"); });
  iconDropzone.addEventListener("dragleave", () => iconDropzone.classList.remove("dropzone--drag"));
  iconDropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    iconDropzone.classList.remove("dropzone--drag");
    acceptIconFile(e.dataTransfer?.files?.[0]);
  });
  iconRemove?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); clearIcon(); });
}

// --- Live ad preview: mirror the spinner overlay as the advertiser types ---
const adPrevBar = document.getElementById("adpreview-bar");
function readableInk(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "#fff";
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62 ? "#1b1e25" : "#fff"; // dark ink on light chips
}
function updateAdPreview() {
  if (!adPrevBar) return;
  const form = document.querySelector(".adform");
  const brand = (form?.querySelector('input[name="organization"]')?.value || "").trim();
  const line = (document.getElementById("adline")?.value || "").trim();
  const raw = (document.getElementById("adcolor")?.value || "").trim();
  const hex = /^#?[0-9a-f]{6}$/i.test(raw) ? (raw[0] === "#" ? raw : "#" + raw) : "";
  const accent = hex || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff0000";
  const chip = document.getElementById("prev-chip");
  const lineEl = document.getElementById("prev-line");
  // Chip initial skips the $ so "$ANSEM" chips as "A"; the preview line pairs
  // ticker + slogan the same way the live overlay renders them.
  const chipSrc = (brand || line || "Your token here").trim().replace(/^\$+/, "");
  if (chip) chip.textContent = (chipSrc[0] || "Y").toUpperCase();
  if (lineEl) lineEl.textContent = (brand && line) ? `${brand} · ${line}` : (line || brand || "Your token here");
  adPrevBar.style.setProperty("--prev-accent", accent);
  adPrevBar.style.setProperty("--prev-ink", readableInk(accent));
  // Sample performance badge — illustrative (live market data lands later; see
  // dwell/ROADMAP.md) so the advertiser sees where their number renders and how
  // the timescale choice changes it.
  const prevChange = document.getElementById("prev-change");
  if (prevChange) {
    const ts = document.getElementById("adtimescale")?.value || "auto";
    const v = resolveChangePct(PREVIEW_CHANGES, ts);
    const s = formatChangePct(v);
    prevChange.textContent = s || "";
    prevChange.classList.toggle("up", s != null && v >= 0);
    prevChange.classList.toggle("down", s != null && v < 0);
  }
}
// Illustrative per-timescale sample for the advertiser preview only.
const PREVIEW_CHANGES = { "5m": 6, "15m": 14, "1h": 33, "4h": 72, "1d": 128 };
{
  const form = document.querySelector(".adform");
  if (form && adPrevBar) { form.addEventListener("input", updateAdPreview); updateAdPreview(); }
}

// --- Performance-window segmented control ---
// Buttons drive the hidden #adtimescale input the checkout payloads read; Auto
// (the default, rightmost) resolves to the biggest window at render time. The
// "?" helper is informational, so clicking it never changes the selection.
{
  const group = document.getElementById("tsgroup");
  const hidden = document.getElementById("adtimescale");
  if (group && hidden) {
    group.addEventListener("click", (e) => {
      if (e.target.closest(".tshelp")) return;
      const btn = e.target.closest(".tsbtn");
      if (!btn || !group.contains(btn)) return;
      hidden.value = btn.dataset.ts;
      group.querySelectorAll(".tsbtn").forEach((b) => b.classList.toggle("is-active", b === btn));
      updateAdPreview();
    });
  }
}

// --- Destination URL: accept bare domains by auto-adding https:// ---
// The backend requires https://, so prepend the scheme when the advertiser
// tabs out of the field (and again on submit), and upgrade a typed http://.
function normalizeUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (/^https:\/\//i.test(v)) return v;
  if (/^http:\/\//i.test(v)) return v.replace(/^http:\/\//i, "https://");
  if (/^\/\//.test(v)) return "https:" + v; // protocol-relative //host
  return "https://" + v;
}
const urlInput = document.querySelector('.adform input[name="url"]');
if (urlInput) {
  urlInput.addEventListener("blur", () => { urlInput.value = normalizeUrl(urlInput.value); });
}

// --- Budget + CPM estimate calculator ---
// Advertiser sets a budget and a CPM (cost per 1,000 impressions); they pay the
// full budget and get floor(budget*1000/cpm) impressions. CPM drives the auction.
const budgetEl = document.getElementById("budget");
const cpmEl = document.getElementById("cpm");
const cpmBubble = document.getElementById("cpm-bubble");
const cpmGhost = document.getElementById("cpm-ghost");
const cpmGhostLbl = document.getElementById("cpm-ghost-lbl");
const fmt = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => n.toLocaleString();

let MIN_BUDGET = 100, MAX_BUDGET = 100000, SUGGESTED_BUDGET = 2500, MIN_CPM = 5, MAX_CPM = 100; // overridden by loadPricing()
// The ghost marker = the current top bid on the marketplace. Hardcoded to $50
// until the admin turns on "live top CPM" (then loadPricing copies the real top).
let TOP_CPM = 50;
const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

// Map a CPM value to the thumb-aligned x position on the track. The 22px thumb
// is centered, so nudge by (0.5 - pct) * 22px so markers sit over the thumb at
// both ends.
function cpmLeft(val) {
  const min = Number(cpmEl.min) || MIN_CPM, max = Number(cpmEl.max) || MAX_CPM;
  const v = Math.min(max, Math.max(min, val));
  const pct = max > min ? (v - min) / (max - min) : 0;
  return `calc(${pct * 100}% + ${(0.5 - pct) * 22}px)`;
}
function positionCpmBubble() {
  if (!cpmEl || !cpmBubble) return;
  const val = Number(cpmEl.value) || (Number(cpmEl.min) || MIN_CPM);
  cpmBubble.style.left = cpmLeft(val);
  cpmBubble.textContent = fmt(val);
}
// The read-only ghost thumb marking the current top bid (TOP_CPM). Vertically
// centered on the slider's own box so it sits exactly where the real thumb does
// — move the thumb to TOP_CPM and the two circles overlap perfectly.
function positionCpmGhost() {
  if (!cpmEl || !cpmGhost) return;
  cpmGhost.style.left = cpmLeft(TOP_CPM);
  cpmGhost.style.top = (cpmEl.offsetTop + cpmEl.offsetHeight / 2) + "px";
  if (cpmGhostLbl) cpmGhostLbl.textContent = "top $" + Math.round(TOP_CPM).toLocaleString();
}

function recompute() {
  if (!budgetEl || !cpmEl) return;
  // Blank budget falls back to the suggested (the placeholder), so the estimate
  // reflects the soft default until the advertiser types their own number.
  const raw = parseFloat(budgetEl.value);
  const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Number.isFinite(raw) && raw > 0 ? raw : SUGGESTED_BUDGET));
  const cpm = Math.max(MIN_CPM, parseInt(cpmEl.value, 10) || MIN_CPM);
  const impressions = Math.floor((budget * 1000) / cpm); // round down — advertiser pays full budget
  setTxt("est-cpm", fmt(cpm));
  setTxt("est-imp", fmtInt(impressions));
  // One-line summary above the pay button mirrors the budget box.
  setTxt("sum-budget", "$" + fmtInt(Math.round(budget)));
  setTxt("sum-cpm", fmt(cpm));
  setTxt("sum-imp", fmtInt(impressions));
  positionCpmBubble();
  positionCpmGhost();
}
if (budgetEl && cpmEl) {
  budgetEl.addEventListener("input", recompute);
  cpmEl.addEventListener("input", recompute);
  // Don't let the mouse wheel scrub the budget number — scroll the page instead.
  budgetEl.addEventListener("wheel", (e) => { if (document.activeElement === budgetEl) e.preventDefault(); }, { passive: false });
  // The thumb-aligned marker positions are width-dependent — re-place on resize.
  window.addEventListener("resize", () => { positionCpmBubble(); positionCpmGhost(); });
  recompute();
}

// --- Copy install command ---
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = btn.getAttribute("data-copy");
    navigator.clipboard?.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = old), 1400);
  });
});

// --- Download-button email capture (Chrome + Mac) -----------------------
// Neither DWELL's own Chrome extension nor its desktop app is out yet, so
// clicking either button opens the existing FreeAI listing in a background
// tab (best-effort — browsers don't let a page reliably suppress the focus
// switch, but re-focusing the opener right after the tab opens gets close)
// and, in the same click, swaps the button for an inline email field so we
// can tell the person when DWELL's own version ships.
function wireDownloadCapture(id, source) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", () => {
    setTimeout(() => window.focus(), 0);
    const col = btn.closest(".dl-col");
    if (!col || col.dataset.captured) return;
    col.dataset.captured = "1";
    const row = document.createElement("div");
    row.className = "dl-cli";
    row.innerHTML =
      '<input type="email" class="dl-email-input" placeholder="you@example.com" autocomplete="email" inputmode="email" aria-label="Email for the DWELL launch notice" />' +
      '<button type="button" class="dl-copy dl-email-btn">Notify me</button>';
    const note = document.createElement("p");
    note.className = "dl-email-note";
    note.textContent = "Get an email when the full version is live.";
    btn.replaceWith(row, note);
    const input = row.querySelector(".dl-email-input");
    const saveBtn = row.querySelector(".dl-email-btn");
    input.focus();
    const submit = async () => {
      const value = input.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        if (API_BASE) {
          await fetch(`${API_BASE}/v1/waitlist`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: value, source: "download:" + source }),
          });
        }
      } catch (_) {
        /* best-effort — still confirm below */
      }
      note.textContent = "You’re on the list ✓ — we’ll email you at launch.";
      row.remove();
    };
    saveBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
  });
}
wireDownloadCapture("dl-chrome", "chrome");
wireDownloadCapture("dl-mac", "mac");

// --- API wiring ---------------------------------------------------------
// In production the leaderboard + advertiser checkout point at the live backend
// (set via <meta name="dwell-api"> in index.html, or window.DWELL_API).
//
// Developer mode: append ?dev=1 to the URL to flip the lander into its
// self-contained mock-data mode (hardcoded leaderboard/ticker/hero, no network);
// it sticks via localStorage, and ?dev=0 turns it back off. A small badge makes
// the mode obvious. This is the "easy on-switch" for showing mock data on the
// lander without touching prod.
const DEV_MODE = (() => {
  const flag = new URLSearchParams(location.search).get("dev");
  try {
    if (flag === "1") { localStorage.setItem("dwell_dev", "1"); return true; }
    if (flag === "0") { localStorage.removeItem("dwell_dev"); return false; }
    return localStorage.getItem("dwell_dev") === "1";
  } catch (_) {
    return flag === "1";
  }
})();

// In dev mode we deliberately drop the API base so loadLeaderboard() and the bid
// form fall back to the page's built-in mock data (no network calls at all).
const API_BASE = DEV_MODE
  ? ""
  : (
      window.DWELL_API ||
      document.querySelector('meta[name="dwell-api"]')?.content ||
      ""
    ).replace(/\/+$/, "");

// (Dev mode still works via ?dev=1; the on-screen "DEV · mock data" badge was
// removed by request.)

const escapeHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Site config (/v1/config), fetched once and shared across the lander widgets
// that need its admin-tunable flags (leaderboardPublic, liveTopCpm).
let _cfgPromise = null;
function getConfig() {
  if (!API_BASE) return Promise.resolve(null);
  if (!_cfgPromise) _cfgPromise = fetch(`${API_BASE}/v1/config`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return _cfgPromise;
}

// Pull the live bid market into the leaderboard (escaped — advertiser text).
// The whole section is hidden by default; it's only revealed when the admin has
// turned the "Live bid market" switch on (surfaced via /v1/config →
// leaderboardPublic). Dev/offline mode keeps it hidden.
async function loadLeaderboard() {
  const section = document.getElementById("leaderboard");
  const board = document.getElementById("board");
  if (!section || !board || !API_BASE) return;
  try {
    const cfg = await getConfig();
    if (!cfg || !cfg.leaderboardPublic) return; // switch is off — stay hidden
    const res = await fetch(`${API_BASE}/v1/leaderboard`);
    if (res.ok) {
      const { leaderboard } = await res.json();
      if (Array.isArray(leaderboard) && leaderboard.length) {
        board.innerHTML = leaderboard
          .map((r) => `<li><span class="rk">${r.rank}</span> ${escapeHtml(r.line)}</li>`)
          .join("");
      }
    }
    section.hidden = false; // reveal now that we know it's public
  } catch (_) {
    /* offline — keep it hidden */
  }
}
loadLeaderboard();

// Pull admin-tunable pricing (CPM min/suggested/max/top + budget min/suggested/max)
// from /v1/pricing and reflect it in the form + estimate. Falls back to the
// hardcoded defaults if the API is unreachable.
async function loadPricing() {
  if (!API_BASE) return;
  try {
    const res = await fetch(`${API_BASE}/v1/pricing`);
    if (!res.ok) return;
    const c = await res.json();
    const dollars = (cents, fallback) => (Number.isFinite(cents) ? cents / 100 : fallback);
    const minCpm = dollars(c.minCpmCents ?? c.minBidCents, 5);
    const sugCpm = dollars(c.suggestedCpmCents ?? c.suggestedBidCents, 15);
    const topCpm = dollars(c.topCpmCents ?? c.topBidCents, 110);
    const maxCpm = dollars(c.maxCpmCents, 100);
    const minBudget = dollars(c.minBudgetCents, 100);
    const sugBudget = dollars(c.suggestedBudgetCents, 2500);
    const maxBudget = dollars(c.maxBudgetCents, 100000);
    const money = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const money0 = (n) => "$" + Math.round(n).toLocaleString();

    MIN_CPM = minCpm; MAX_CPM = maxCpm; MIN_BUDGET = minBudget; MAX_BUDGET = maxBudget; SUGGESTED_BUDGET = sugBudget;
    // Start the slider at the suggested CPM (no "suggested" label shown).
    if (cpmEl) { cpmEl.min = minCpm; cpmEl.max = maxCpm; cpmEl.value = sugCpm; }
    // Budget stays blank; the suggested becomes the placeholder + the soft default.
    if (budgetEl) { budgetEl.min = String(minBudget); budgetEl.max = String(maxBudget); budgetEl.placeholder = String(Math.round(sugBudget)); }
    setTxt("budget-hint", `min ${money0(minBudget)} · max ${money0(maxBudget)}`);
    setTxt("cpm-min-lbl", money0(minCpm));
    setTxt("cpm-max-lbl", money0(maxCpm));
    // The "top bid" the ghost marker + note point at: the live marketplace top
    // only when the admin has flipped "live top CPM" on; otherwise hardcoded $50.
    const cfg = await getConfig();
    TOP_CPM = (cfg && cfg.liveTopCpm && Number.isFinite(topCpm)) ? topCpm : 50;
    setTxt("note-top", money(TOP_CPM));
    setTxt("note-min", money(minCpm));
    recompute();
  } catch (_) {
    /* offline — keep the hardcoded defaults */
  }
}
loadPricing();

// Real advertiser checkout: create a campaign + redirect to Stripe.
const adForm = document.querySelector(".adform");
if (adForm) {
  // Email is optional in the form, but Stripe checkout needs it for the
  // receipt — enforce it only on the card/submit path (native `required` would
  // also block a future crypto path, where it stays optional).
  const emailInput = adForm.querySelector('input[name="email"]');
  emailInput?.addEventListener("input", () => emailInput.setCustomValidity(""));
  // Shared required-field gate for every checkout rail. reportValidity covers
  // the native `required` fields (ticker/slogan/link) — needed explicitly on
  // the crypto rails, whose plain buttons bypass form submission; the hidden
  // file input can't carry native `required`, so the icon is checked via the
  // dropzone's filled state.
  window.validateTickerFields = () => {
    if (!adForm.reportValidity()) return false;
    const iconZone = document.getElementById("icon-dropzone");
    if (iconZone && !iconZone.classList.contains("dropzone--filled")) {
      const msg = document.getElementById("dropzone-msg");
      if (msg) {
        msg.textContent = "Ticker icon is required — drop an image here or click to browse.";
        msg.classList.add("dropzone-msg--err");
      }
      iconZone.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    return true;
  };
  adForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stripeBtn = adForm.querySelector(".stripe-btn");
    const get = (sel) => adForm.querySelector(sel)?.value?.trim() || "";
    if (!window.validateTickerFields()) return;
    if (emailInput && !emailInput.value.trim()) {
      emailInput.setCustomValidity("Email is required for Stripe checkout — your receipt goes there.");
      emailInput.reportValidity();
      return;
    }
    const payload = {
      email: get('input[name="email"]'),
      adLine: document.getElementById("adline")?.value?.trim() || "",
      url: normalizeUrl(get('input[name="url"]')),
      brand: get('input[name="organization"]'),
      color: document.getElementById("adcolor")?.value?.trim() || "",
      budget: parseFloat(document.getElementById("budget")?.value || "0"),
      cpm: parseInt(document.getElementById("cpm")?.value || "0", 10),
      showOnLeaderboard: adForm.querySelector('input[type="checkbox"]')?.checked !== false,
      timescale: document.getElementById("adtimescale")?.value || "auto",
    };

    if (!API_BASE) {
      // No API configured. This is the live page, so surface a neutral retry
      // message rather than any demo/test wording.
      const old = stripeBtn.innerHTML;
      stripeBtn.textContent = "Couldn't reach checkout — try again";
      setTimeout(() => (stripeBtn.innerHTML = old), 2200);
      return;
    }
    stripeBtn.disabled = true;
    const old = stripeBtn.innerHTML;
    stripeBtn.textContent = "Redirecting to Stripe…";
    try {
      const res = await fetch(`${API_BASE}/v1/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        stripeBtn.textContent = data.error || "Something went wrong";
        setTimeout(() => { stripeBtn.innerHTML = old; stripeBtn.disabled = false; }, 2600);
      }
    } catch (_) {
      stripeBtn.textContent = "Network error — try again";
      setTimeout(() => { stripeBtn.innerHTML = old; stripeBtn.disabled = false; }, 2600);
    }
  });
}

// --- Crypto checkout: USDC/SOL or $DWELL (dwell/docs/08) --------------------
// Non-custodial pay-and-swap: the backend builds ONE atomic Solana transaction
// the advertiser signs from their own wallet via a Solana Pay link. Two crypto
// rails: USDC/SOL (10% fee to treasury, 90% market-bought into $DWELL for the
// rewards pool) and $DWELL direct (no swap — 10% fee + 90% to the pool, and the
// campaign gets +10% impressions). Fully wired but HIDDEN: the backend 404s the
// whole surface until the $DWELL mint exists (DWELL_MINT env), so this flag
// stays false until launch — flip it to reveal the slider.
const USDC_CHECKOUT = false;
(() => {
  const tabs = document.getElementById("paytabs");
  if (!tabs || !adForm) return;
  if (!USDC_CHECKOUT || !API_BASE) return; // stays hidden pre-launch (and in dev mode)

  // Reveal the payment-method slider and wire the tabs. Order: USDC/SOL
  // (default), $DWELL, Credit card. The thumb width comes from the segment
  // count (CSS), so selecting tab i is just translateX(i * 100%).
  tabs.hidden = false;
  const thumb = document.getElementById("paytabs-thumb");
  const tabEls = [...tabs.querySelectorAll(".paytab")];
  const selectTab = (idx) => {
    if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
    tabEls.forEach((t, i) => {
      const on = i === idx;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
      const pane = document.getElementById(t.dataset.pane);
      if (pane) pane.hidden = !on;
    });
  };
  tabEls.forEach((t, i) => t.addEventListener("click", () => selectTab(i)));
  selectTab(0);

  const usd = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const readForm = () => {
    const get = (sel) => adForm.querySelector(sel)?.value?.trim() || "";
    return {
      email: get('input[name="email"]'),
      adLine: document.getElementById("adline")?.value?.trim() || "",
      url: normalizeUrl(get('input[name="url"]')),
      brand: get('input[name="organization"]'),
      color: document.getElementById("adcolor")?.value?.trim() || "",
      budget: parseFloat(document.getElementById("budget")?.value || "0") || SUGGESTED_BUDGET,
      cpm: parseInt(document.getElementById("cpm")?.value || "0", 10),
      showOnLeaderboard: adForm.querySelector('input[type="checkbox"]')?.checked !== false,
      timescale: document.getElementById("adtimescale")?.value || "auto",
    };
  };

  // Wire one crypto pane. `ids` names its elements; `currency` is the initial
  // rail; `fill(data)` populates the pane-specific rows and returns a status
  // string; `altBtn` (optional) is the USDC↔SOL switch, which re-orders on the
  // toggled currency.
  const wirePane = ({ ids, currency, fill, altCurrency }) => {
    const btn = document.getElementById(ids.btn);
    const panel = document.getElementById(ids.panel);
    const statusEl = document.getElementById(ids.status);
    const payLink = document.getElementById(ids.paylink);
    const copyBtn = document.getElementById(ids.copy);
    const altBtn = ids.alt ? document.getElementById(ids.alt) : null;
    if (!btn || !panel) return;
    let cur = currency;
    let pollTimer = null;
    const setStatus = (t, cls) => { statusEl.textContent = t; statusEl.className = "usdc-status" + (cls ? " " + cls : ""); };
    const poll = (orderId) => {
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/v1/ads/usdc/orders/${orderId}`);
          if (!res.ok) return;
          const o = await res.json();
          if (o.status === "confirmed") {
            clearInterval(pollTimer);
            setStatus("Payment confirmed — your ad is in review and goes live once approved.", "ok");
            payLink.hidden = true;
            if (altBtn) altBtn.hidden = true;
          } else if (o.status === "expired") {
            clearInterval(pollTimer);
            setStatus("This order expired. Reopen crypto checkout to price a fresh one.", "err");
          } else if (o.status === "failed") {
            clearInterval(pollTimer);
            setStatus("That payment didn't verify (" + (o.failReason || "unknown") + "). Reopen crypto checkout to retry.", "err");
          }
        } catch (_) { /* offline — keep polling */ }
      }, 3500);
    };
    const create = async () => {
      // Same required-field gate as the card rail (email stays optional here).
      if (window.validateTickerFields && !window.validateTickerFields()) return;
      btn.disabled = true;
      const old = btn.innerHTML;
      btn.textContent = "Pricing your campaign…";
      try {
        const res = await fetch(`${API_BASE}/v1/ads/usdc/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...readForm(), currency: cur }),
        });
        const data = await res.json();
        if (!res.ok) {
          btn.textContent = data.error || "Something went wrong";
          setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 2600);
          return;
        }
        btn.innerHTML = old;
        btn.disabled = false;
        const statusText = fill(data, cur);
        payLink.hidden = false;
        payLink.href = data.solanaPayUrl;
        copyBtn.onclick = () => {
          navigator.clipboard?.writeText(data.solanaPayUrl).then(
            () => { copyBtn.textContent = "Copied"; setTimeout(() => (copyBtn.textContent = "Copy payment link"), 1600); },
            () => {}
          );
        };
        if (altBtn) { altBtn.hidden = false; altBtn.textContent = cur === "sol" ? "Pay with USDC instead" : "Pay with SOL instead"; }
        setStatus(statusText);
        panel.hidden = false;
        poll(data.orderId);
      } catch (_) {
        btn.textContent = "Network error — try again";
        setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 2600);
      }
    };
    btn.addEventListener("click", create);
    if (altBtn && altCurrency) altBtn.addEventListener("click", () => { cur = cur === currency ? altCurrency : currency; create(); });
  };

  // USDC/SOL pane (default rail usdc; the switch flips to sol).
  wirePane({
    currency: "usdc",
    altCurrency: "sol",
    ids: { btn: "usdc-btn", panel: "usdc-panel", status: "usdc-status", paylink: "usdc-paylink", copy: "usdc-copy", alt: "usdc-switch" },
    fill: (data, cur) => {
      document.getElementById("usdc-price").textContent = usd(data.priceUsdc);
      document.getElementById("usdc-fee").textContent = usd(data.feeUsdc);
      document.getElementById("usdc-tranche").textContent = usd(data.trancheUsdc);
      const solRow = document.getElementById("usdc-sol-row");
      solRow.hidden = cur !== "sol";
      if (cur === "sol" && Number.isFinite(data.estPayTotalSol)) {
        document.getElementById("usdc-sol-total").textContent = data.estPayTotalSol.toFixed(4) + " SOL";
      }
      return cur === "sol"
        ? "Open the link in your Solana wallet and approve — one signature pays the fee in SOL and funds the rewards pool. The SOL amount re-prices when the wallet fetches the transaction."
        : "Open the link in your Solana wallet and approve the transaction — one signature pays the fee and funds the rewards pool.";
    },
  });

  // $DWELL pane — pay the budget directly in $DWELL (no swap), +10% impressions.
  wirePane({
    currency: "dwell",
    ids: { btn: "dwell-btn", panel: "dwell-panel", status: "dwell-status", paylink: "dwell-paylink", copy: "dwell-copy" },
    fill: (data) => {
      document.getElementById("dwell-price").textContent = usd(data.priceUsdc);
      document.getElementById("dwell-fee").textContent = usd(data.feeUsdc);
      document.getElementById("dwell-tranche").textContent = usd(data.trancheUsdc);
      const boostPct = Number.isFinite(data.boostBps) ? (data.boostBps / 100) : 10;
      document.getElementById("dwell-boost").textContent = "+" + boostPct + "% impressions";
      if (Number.isFinite(data.estPayTotalDwell)) {
        document.getElementById("dwell-amount").textContent =
          Number(data.estPayTotalDwell).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " $DWELL";
      }
      return "Open the link in your Solana wallet and approve — one signature pays 10% to the treasury and 90% to the rewards pool. Your campaign runs with +" + boostPct + "% impressions.";
    },
  });
})();

// --- Surfaces showcase: provider-tab cross-fade ("Native everywhere it
// appears"). Clicking a tab swaps the active screenshot within that surface
// row only. Scoped to .surfaces so it can't touch anything else on the page. ---
document.querySelectorAll(".surfaces .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const key = tab.dataset.shot;
    const scope = tab.closest(".surface");
    if (!scope) return;
    scope.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.shot === key));
    scope.querySelectorAll(".shot").forEach((s) => s.classList.toggle("active", s.dataset.shot === key));
  });
});

// (Removed: the animated "$/mo" earnings ticker. Quantified earnings claims
// are banned copy — see docs/05-legal-structure.md and
// docs/08-securities-framework.md. The .earn-amt pills are static copy now.)

// --- Protocol-hero mesh: the drifting node/line constellation behind the
// DWELL PROTOCOL lockup. Plain canvas 2D — nodes wander slowly, lines fade in
// between nearby pairs (the brand card's geometric web, set in motion). The
// CSS mask on .proto-mesh weights it to the right, so nodes render everywhere
// and the mask does the composition. Static single frame under
// prefers-reduced-motion.
(function protoMesh() {
  const canvas = document.getElementById("proto-mesh");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let W = 0, H = 0, dpr = 1, nodes = [];
  const LINK = 220;         // px — max distance for a connecting line
  const SPEED = 0.16;       // px/frame — a slow drift

  function seed() {
    // Density scales with area so wide and narrow viewports feel the same.
    const count = Math.max(60, Math.round((W * H) / 8500));
    const node = (x) => ({
      x,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * SPEED * 2,
      vy: (Math.random() - 0.5) * SPEED * 2,
      r: 1.2 + Math.random() * 2.4,
    });
    nodes = Array.from({ length: count }, () => node(Math.random() * W));
    // The composition is right-weighted: pile extra nodes into the far-right
    // third so the web is densest at the edge (the mask fades the left anyway).
    const extra = Math.round(count * 0.7);
    for (let i = 0; i < extra; i++) nodes.push(node(W * (0.66 + Math.random() * 0.34)));
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (reduced) draw();
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < LINK) {
          ctx.strokeStyle = `rgba(26, 26, 26, ${0.085 * (1 - d / LINK)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = "rgba(26, 26, 26, 0.11)";
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function tick() {
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < -20) n.x = W + 20; else if (n.x > W + 20) n.x = -20;
      if (n.y < -20) n.y = H + 20; else if (n.y > H + 20) n.y = -20;
    }
    draw();
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resize);
  resize();
  if (!reduced) requestAnimationFrame(tick);
})();


// --- Impressions odometer ("Get your token in front of N eyeballs") ---------
// Mechanical-counter style: one dark cell per digit (the last cell red, like a
// flip counter), each cell a vertical reel of 0–9 that rolls UPWARD to the new
// digit. There's no public network-total endpoint yet, so the figure is an
// optimistic projection: a fixed base plus steady time-based growth (so it's
// consistent across visits and always climbing), plus a gentle live tick.
(function impOdometer() {
  const el = document.getElementById("imp-counter");
  if (!el) return;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const IMP_BASE = 21_437_615;                       // network total at the epoch
  const IMP_EPOCH = Date.parse("2026-07-01T00:00:00Z");
  const IMP_RATE = 2.7;                              // impressions/second, network-wide
  const projected = () => IMP_BASE + Math.floor(((Date.now() - IMP_EPOCH) / 1000) * IMP_RATE);

  let value = projected();
  let cols = [];      // [{reel, digit}] most-significant first, commas excluded

  // The reel holds 0–9 twice so a 9→0 wrap can keep rolling upward (into the
  // second copy) and snap back down transition-less once it's offscreen.
  function build(str) {
    el.classList.add("imp-odometer--live");
    el.innerHTML = "";
    cols = [];
    for (const ch of str) {
      if (ch === ",") {
        const c = document.createElement("span");
        c.className = "imp-comma";
        c.textContent = ",";
        el.appendChild(c);
        continue;
      }
      const cell = document.createElement("span");
      cell.className = "imp-digit";
      const reel = document.createElement("span");
      reel.className = "imp-reel";
      for (let k = 0; k < 20; k++) {
        const d = document.createElement("span");
        d.textContent = String(k % 10);
        reel.appendChild(d);
      }
      cell.appendChild(reel);
      el.appendChild(cell);
      const digit = Number(ch);
      reel.style.transform = `translateY(${-digit}em)`;
      cols.push({ reel, digit });
    }
    // Flip counters mark the low-order cell — tint the last digit accent red.
    const cells = el.querySelectorAll(".imp-digit");
    cells[cells.length - 1]?.classList.add("imp-digit--accent");
  }

  function render() {
    const str = value.toLocaleString("en-US");
    const digits = str.replace(/,/g, "");
    if (digits.length !== cols.length) { build(str); return; }
    let i = 0;
    for (const ch of digits) {
      const col = cols[i++];
      const d = Number(ch);
      if (d === col.digit) continue;
      if (reduced) {
        col.reel.style.transition = "none";
        col.reel.style.transform = `translateY(${-d}em)`;
      } else if (d < col.digit) {
        // Wrap (e.g. 9→0): roll up into the reel's second 0–9 copy, then snap
        // back to the equivalent low position once the transition lands.
        const reel = col.reel;
        reel.style.transform = `translateY(${-(d + 10)}em)`;
        reel.addEventListener("transitionend", function snap() {
          reel.removeEventListener("transitionend", snap);
          reel.style.transition = "none";
          reel.style.transform = `translateY(${-d}em)`;
          void reel.offsetHeight; // flush so the transition re-arms cleanly
          reel.style.transition = "";
        });
      } else {
        col.reel.style.transform = `translateY(${-d}em)`;
      }
      col.digit = d;
    }
  }

  build(value.toLocaleString("en-US"));
  // Steady upward roll: re-sync to the projection (never letting the shown
  // number go backwards) so the counter climbs a few impressions per tick.
  setInterval(() => {
    value = Math.max(value + 1, projected());
    render();
  }, 1200);
})();

// --- Boost fold: the hero "Boost your token" button folds the advertiser card
// open right underneath it, pushing "Get it on your platform" lower. The card
// is NOT a copy — script moves the real #advertisers section node between its
// home slot (#advertisers-home, bottom of the page) and the fold slot under
// the button, so it's the exact same component with all its wiring intact. ---
(function boostFold() {
  const btn = document.getElementById("boost-toggle");
  const fold = document.getElementById("boost-fold");
  const slot = document.getElementById("boost-fold-slot");
  const home = document.getElementById("advertisers-home");
  const card = document.getElementById("advertisers");
  if (!btn || !fold || !slot || !home || !card) return;

  let open = false;
  btn.addEventListener("click", () => {
    open = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("open", open);
    if (open) {
      slot.appendChild(card);            // mount under the button…
      void fold.offsetHeight;            // …then let the 0fr→1fr fold animate
      fold.classList.add("open");
      // Nudge the CPM slider markers — they're width-dependent and the fold
      // slot can be narrower than the section's home mount.
      window.dispatchEvent(new Event("resize"));
    } else {
      fold.classList.remove("open");
      // Send the card back home once the fold has collapsed shut.
      fold.addEventListener("transitionend", function done(e) {
        if (e.propertyName !== "grid-template-rows") return;
        fold.removeEventListener("transitionend", done);
        if (!fold.classList.contains("open")) {
          home.after(card);
          window.dispatchEvent(new Event("resize"));
        }
      });
    }
  });
})();

// --- Auto-hiding nav: hidden over the full-viewport protocol hero, slides in
// once the user scrolls past a small threshold (and back out at the top). ---
(function autoNav() {
  const nav = document.querySelector(".nav-autohide");
  if (!nav) return;
  const onScroll = () => nav.classList.toggle("nav--show", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
