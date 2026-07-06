// AIAD landing script. Self-contained: the page renders fully standalone, and
// every economics number on the page — the split bars, the referral example,
// the step cards, the advertiser estimate — derives from the single ECONOMICS
// const below. Mechanics are stated as facts; nothing here is a price promise.

// ── ECONOMICS — the one source of truth for every number on the page ──────
// Per $100 of ad spend (fixed dollar CPM, paid by card):
//   ~$2.50 card fees · ~$2.50 provider fees · $5 to the business · $90 escrowed.
// The escrowed pool then splits 85% viewer / 15% referrer; when a viewer has
// no referrer, the 15% referrer leg falls to the protocol treasury.
// Points: 1,000 points = $1.00 of earned ad value, 1:1 backed by the reserve.
const ECONOMICS = {
  gross: 100,          // the reference $100 of ad spend
  cardFees: 2.5,       // ≈ card processing
  providerFees: 2.5,   // ≈ infrastructure / provider fees
  business: 5,         // to the business
  pool: 90,            // escrowed in the USDC reserve for the earn side
  split: { viewer: 0.85, referrer: 0.15 },
  pointsPerDollar: 1000, // 1,000 points = $1.00 of earned ad value
};

// Derived per-$100 dollars (Viewer $76.50 / Referrer $13.50).
const POOL_USD = {
  viewer: ECONOMICS.pool * ECONOMICS.split.viewer,
  referrer: ECONOMICS.pool * ECONOMICS.split.referrer,
};

// ── formatting helpers ─────────────────────────────────────────────────────
const $id = (id) => document.getElementById(id);
const setTxt = (id, v) => { const el = $id(id); if (el) el.textContent = v; };
const usd = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n) => "$" + Math.round(n).toLocaleString();
const int = (n) => Math.round(n).toLocaleString();
const pct = (share) => Math.round(share * 100) + "%";

const prefersReducedMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Developer mock-data mode — the sticky ?dev=1 convention ───────────────
// ?dev=1 flips the page into its self-contained mock-data mode (no network;
// the reserve ticker animates from a deterministic seed). It sticks via
// localStorage; ?dev=0 exits. This is the one developer affordance on the page.
const DEV_MODE = (() => {
  const flag = new URLSearchParams(location.search).get("dev");
  try {
    if (flag === "1") { localStorage.setItem("aiad_dev", "1"); return true; }
    if (flag === "0") { localStorage.removeItem("aiad_dev"); return false; }
    return localStorage.getItem("aiad_dev") === "1";
  } catch (_) {
    return flag === "1";
  }
})();

// In dev mode the API base is dropped so everything stays local and seeded.
const API_BASE = DEV_MODE
  ? ""
  : (
      window.AIAD_API ||
      document.querySelector('meta[name="aiad-api"]')?.content ||
      ""
    ).replace(/\/+$/, "");

// ── HERO DEMO — the assistant thinks, one sponsored line shows, the viewer's
// session points tick up. The earn math is real: at DEMO_CPM dollars per 1,000
// views, one view is worth (DEMO_CPM/1000) × 90% × 85% to the viewer, ×1000
// for points — $15 CPM → 11.48 points per view.
const DEMO_CPM = 15;
const PTS_PER_VIEW =
  (DEMO_CPM / 1000) * (ECONOMICS.pool / ECONOMICS.gross) * ECONOMICS.split.viewer * ECONOMICS.pointsPerDollar;

const THINK_WORDS = [
  "Thinking", "Percolating", "Simmering", "Marinating", "Computing",
  "Noodling", "Ruminating", "Conjuring", "Distilling", "Untangling",
];

// Sponsored lines for the demo pill. House style: "Brand · Sentence-case line",
// short enough to hold ONE line in the pill at every width.
const ADS = [
  { chip: "R", text: "Ramp · Close your books faster" },
  { chip: "L", text: "Linear · Issue tracking for teams" },
  { chip: "N", text: "Neon · Postgres, branched" },
  { chip: "△", text: "Vercel · Ship to prod in seconds" },
  { chip: "T", text: "Tuple · Pair programming, done right" },
  { chip: "R", text: "Resend · Email for developers" },
];

(function heroDemo() {
  const word = $id("word-stock");
  const secs = $id("think-secs");
  const line = $id("brand-line");
  const chip = $id("brand-chip");
  const plus = $id("earn-plus");
  const session = $id("earn-session");
  const sessionUsd = $id("earn-usd");
  if (!line || !chip) return;

  // Paint the first frame immediately so the pill is never blank.
  let adIdx = 0;
  line.textContent = ADS[0].text;
  chip.textContent = ADS[0].chip;
  let earnedPts = PTS_PER_VIEW;
  const fmtPts = (n) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const paintEarn = () => {
    if (plus) plus.textContent = "+" + fmtPts(PTS_PER_VIEW) + " pts";
    if (session) session.textContent = fmtPts(earnedPts) + " pts";
    if (sessionUsd) sessionUsd.textContent = "$" + (earnedPts / ECONOMICS.pointsPerDollar).toFixed(4);
  };
  paintEarn();

  // Spinner word + elapsed-seconds counter.
  let w = 0, t = 2;
  if (word) setInterval(() => { w = (w + 1) % THINK_WORDS.length; word.textContent = THINK_WORDS[w]; }, 1600);
  if (secs) setInterval(() => { t = t >= 9 ? 1 : t + 1; secs.textContent = String(t); }, 1000);

  // Sponsor rotation: cross-fade the line, credit the session on each new view.
  line.style.transition = "opacity .26s";
  chip.style.transition = "opacity .26s";
  setInterval(() => {
    adIdx = (adIdx + 1) % ADS.length;
    const ad = ADS[adIdx];
    line.style.opacity = "0";
    chip.style.opacity = "0";
    setTimeout(() => {
      line.textContent = ad.text;
      chip.textContent = ad.chip;
      line.style.opacity = "1";
      chip.style.opacity = "1";
      earnedPts += PTS_PER_VIEW;
      paintEarn();
    }, 260);
  }, 3200);
})();

// ── THE SPLIT — render both waterfall bars from ECONOMICS. Widths start at 0
// (CSS) and grow when the section scrolls into view; with reduced motion (or
// no IntersectionObserver) they render at full width immediately. ────────────
(function splitWaterfall() {
  const waterfall = $id("waterfall");
  if (!waterfall) return;
  const E = ECONOMICS;

  const setSeg = (id, share, label) => {
    const el = $id(id);
    if (el) el.style.width = (share * 100) + "%";
    if (label !== undefined) setTxt("seglbl-" + id.replace(/^seg-/, ""), label);
  };
  const grow = () => {
    // Bar 1 — $100 of ad spend.
    setSeg("seg-card", E.cardFees / E.gross);
    setSeg("seg-provider", E.providerFees / E.gross);
    setSeg("seg-business", E.business / E.gross);
    setSeg("seg-pool", E.pool / E.gross, usd(E.pool) + " → escrow");
    // Bar 2 — the escrowed pool.
    setSeg("seg-viewer", E.split.viewer, usd(POOL_USD.viewer));
    setSeg("seg-referrer", E.split.referrer, usd(POOL_USD.referrer));
    waterfall.classList.add("wf-in");
  };

  // Legend numbers + percentages are visible before the bars animate.
  setTxt("lbl-card", "~" + usd(E.cardFees));
  setTxt("lbl-provider", "~" + usd(E.providerFees));
  setTxt("lbl-business", usd(E.business));
  setTxt("lbl-pool", usd(E.pool));
  setTxt("pct-pool", pct(E.pool / E.gross));
  setTxt("wf-flow-amt", usd(E.pool));
  setTxt("lbl-viewer", usd(POOL_USD.viewer));
  setTxt("lbl-referrer", usd(POOL_USD.referrer));
  setTxt("pct-viewer", pct(E.split.viewer));
  setTxt("pct-referrer", pct(E.split.referrer));

  if (prefersReducedMotion || !("IntersectionObserver" in window)) { grow(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { grow(); io.disconnect(); }
  }, { threshold: 0.35 });
  io.observe(waterfall);
})();

// ── RESERVE TICKER — escrowed USDC, points outstanding, campaigns funded.
// RESERVE_SEED is the deterministic baseline every load shows. Points
// outstanding derive from the escrow: points are minted to viewers (85%) and
// referrers (15%) — 65¢ of every escrowed pool dollar — so each escrowed
// dollar carries 650 points. In dev mode a seeded PRNG (mulberry32) advances
// the figures on a timer, identically on every load. A live /v1/reserve
// response overrides the seed when an API base is configured.
const RESERVE_SEED = { escrowedUsd: 412830, campaigns: 1284 };
const PTS_PER_ESCROWED_USD =
  ((ECONOMICS.split.viewer + ECONOMICS.split.referrer) * ECONOMICS.pointsPerDollar);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(function reserveTicker() {
  const state = { escrowedUsd: RESERVE_SEED.escrowedUsd, campaigns: RESERVE_SEED.campaigns };
  const render = () => {
    setTxt("stat-reserve", usd0(state.escrowedUsd));
    setTxt("stat-points", int(state.escrowedUsd * PTS_PER_ESCROWED_USD));
    setTxt("stat-campaigns", int(state.campaigns));
  };
  render();

  if (DEV_MODE) {
    const caption = $id("reserve-caption");
    if (caption) { caption.textContent = "live preview · seeded mock data"; caption.classList.add("is-live"); }
    if (!prefersReducedMotion) {
      const rnd = mulberry32(0x41494144); // "AIAD" — same sequence every load
      setInterval(() => {
        state.escrowedUsd += 1 + rnd() * 4;        // views being escrowed
        if (rnd() < 0.12) state.campaigns += 1;    // a new campaign funds
        render();
      }, 2400);
    }
    return;
  }

  // Live figures when an API base is configured; the seed stays otherwise.
  if (API_BASE) {
    fetch(`${API_BASE}/v1/reserve`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (Number.isFinite(data.escrowedUsd)) state.escrowedUsd = data.escrowedUsd;
        if (Number.isFinite(data.campaigns)) state.campaigns = data.campaigns;
        render();
        const caption = $id("reserve-caption");
        if (caption) { caption.textContent = "live"; caption.classList.add("is-live"); }
      })
      .catch(() => { /* offline — the seeded figures stand */ });
  }
})();

// ── HOW IT WORKS + REFERRALS — fill the shares/worked example from ECONOMICS.
setTxt("step-viewer-pct", pct(ECONOMICS.split.viewer));
setTxt("step-ref-pct", pct(ECONOMICS.split.referrer));
setTxt("ref-rate", pct(ECONOMICS.split.referrer));
setTxt("ref-friend", usd(POOL_USD.viewer));
setTxt("ref-you", usd(POOL_USD.referrer));

// ── ADVERTISER ESTIMATE — budget + fixed-CPM slider. The estimate rows restate
// the ECONOMICS split live: views, the escrowed 90%, and the viewers' 85% of
// the pool. The pay CTA is inert in this preview build. ─────────────────────
(function advertiserForm() {
  const budgetEl = $id("budget");
  const cpmEl = $id("cpm");
  const bubble = $id("cpm-bubble");
  if (!budgetEl || !cpmEl) return;

  const MIN_BUDGET = 100, MAX_BUDGET = 100000, SUGGESTED_BUDGET = 2500;
  const MIN_CPM = 5, MAX_CPM = 100;
  setTxt("cpm-min-lbl", usd0(MIN_CPM));
  setTxt("cpm-max-lbl", usd0(MAX_CPM));

  // Keep the value bubble over the 22px slider thumb across the track.
  const bubbleLeft = (val) => {
    const p = (val - MIN_CPM) / (MAX_CPM - MIN_CPM);
    return `calc(${p * 100}% + ${(0.5 - p) * 22}px)`;
  };

  const recompute = () => {
    const raw = parseFloat(budgetEl.value);
    const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Number.isFinite(raw) && raw > 0 ? raw : SUGGESTED_BUDGET));
    const cpm = Math.max(MIN_CPM, parseInt(cpmEl.value, 10) || MIN_CPM);
    const views = Math.floor((budget * 1000) / cpm); // rounded down; the full budget is paid
    const escrow = budget * (ECONOMICS.pool / ECONOMICS.gross);
    const toViewers = escrow * ECONOMICS.split.viewer;
    setTxt("est-imp", int(views));
    setTxt("est-escrow", usd(escrow));
    setTxt("est-viewers", usd(toViewers));
    setTxt("sum-budget", usd0(budget));
    setTxt("sum-cpm", usd(cpm));
    setTxt("sum-imp", int(views));
    setTxt("pay-amt", usd0(budget));
    if (bubble) { bubble.style.left = bubbleLeft(cpm); bubble.textContent = usd(cpm); }
  };
  budgetEl.addEventListener("input", recompute);
  cpmEl.addEventListener("input", recompute);
  // Don't let the mouse wheel scrub the budget number — scroll the page instead.
  budgetEl.addEventListener("wheel", (e) => { if (document.activeElement === budgetEl) e.preventDefault(); }, { passive: false });
  recompute();

  // Ad line character counter.
  const adline = $id("adline");
  const count = $id("adline-count");
  if (adline && count) {
    adline.addEventListener("input", () => { count.textContent = `${adline.value.length} / 60`; });
  }

  // Live preview: mirror the viewer's pill as the advertiser types.
  const form = document.querySelector(".adform");
  const paintPreview = () => {
    const brand = (form?.querySelector('input[name="organization"]')?.value || "").trim();
    const line = (adline?.value || "").trim();
    setTxt("prev-chip", ((brand || line || "Your ad here").trim()[0] || "Y").toUpperCase());
    setTxt("prev-line", line || "Your ad here");
  };
  if (form) { form.addEventListener("input", paintPreview); paintPreview(); }

  // Inert submit — this is the preview build; nothing is charged.
  const note = $id("pay-note");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (note) {
      note.textContent = "Preview build — checkout isn't wired up yet. Nothing was charged.";
      note.classList.add("is-on");
      setTimeout(() => note.classList.remove("is-on"), 2600);
    }
  });
})();
