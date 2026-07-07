// DWELL — signed-in portal (portal.html). Email magic-link or OAuth sign-in,
// then the points dashboard: earnings, the activity ledger, the cash-out
// preview, referrals, and install status. Points are the unit everywhere:
// 1,000 points = $1.00 of earned ad value, backed 1:1 by the USDC reserve.
//
// Dev mode — open portal.html?dev=1. The flag sticks in localStorage and the
// whole portal renders from seeded, deterministic mock data with no backend
// (screenshots reproduce run to run). portal.html?dev=0 clears the flag.
// Outside dev mode the real API paths below are used unchanged.

const API_BASE = (
  window.DWELL_API ||
  document.querySelector('meta[name="dwell-api"]')?.content ||
  ""
).replace(/\/+$/, "");

const SESSION_KEY = "dwell_session";
const PENDING_LINK_KEY = "dwell_pending_link";
const DEV_KEY = "dwell_dev";
const $ = (id) => document.getElementById(id);

// ---- dev mode (sticky) ----
// Capture ?dev=1 / ?dev=0 before any URL scrubbing below runs.
(function captureDevFlag() {
  const dev = new URLSearchParams(location.search).get("dev");
  try {
    if (dev === "1") localStorage.setItem(DEV_KEY, "1");
    if (dev === "0") localStorage.removeItem(DEV_KEY);
  } catch (e) {}
})();
function isDev() {
  try { return localStorage.getItem(DEV_KEY) === "1"; } catch (e) { return false; }
}

// ---- formatters — mono-forward numbers, points first ----
const pts = (n) => Math.round(Number(n) || 0).toLocaleString();
const usd = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const usdFromPoints = (p) => usd((Number(p) || 0) / 1000);
// Signed points for ledger rows: credits read "+320 pts", debits "−2,000 pts".
const ptsSigned = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? "−" : "+") + Math.abs(v).toLocaleString() + " pts";
};

// ---- seeded mock data (dev mode) ----
// mulberry32 — a small deterministic PRNG so every dev-mode render matches.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_SEED = 20260706;

function buildMock() {
  const rand = mulberry32(MOCK_SEED);
  const sponsors = [
    "Vantage Analytics", "Copperline", "Northwind Cloud", "Fieldnote",
    "Arcline Robotics", "Helio Energy", "Bridgeport Labs", "Quillworks",
  ];

  // Ledger — ~3 weeks of entries, newest first. Mostly sponsored-line credits,
  // a referral share every few rows, and one token-claim debit kept as a
  // future-state example of what launch-day conversion looks like.
  const rows = [];
  const now = Date.now();
  for (let i = 0; i < 56; i++) {
    const t = new Date(now - Math.round(i * 9 + rand() * 6) * 3600e3);
    if (i === 4) {
      rows.push({
        id: "lg_claim_0001",
        type: "token_claim_debit",
        advertiser: "Future-state example",
        createdAt: t.toISOString(),
        points: -2000,
      });
      continue;
    }
    const referral = i % 7 === 3;
    rows.push({
      id: "lg_" + String(1000 + i),
      type: referral ? "referral_points_credit" : "points_credit",
      advertiser: sponsors[Math.floor(rand() * sponsors.length)],
      createdAt: t.toISOString(),
      points: referral ? 15 + Math.round(rand() * 120) : 40 + Math.round(rand() * 320),
    });
  }

  // Chart series — bucket values seeded per window so the shape never changes.
  const series = {};
  for (const [win, n] of [["24h", 24], ["7d", 7], ["30d", 30]]) {
    const r = mulberry32(MOCK_SEED + n);
    series[win] = Array.from({ length: n }, () => {
      const active = r() > 0.25;
      const count = active ? 1 + Math.floor(r() * (win === "24h" ? 3 : 14)) : 0;
      return { points: active ? count * (30 + Math.round(r() * 60)) : 0, count };
    });
  }

  // Per-friend referral table — your share is 10% of each friend's lifetime.
  const friends = [
    { name: "Maya R.",  joined: "May 14",  theirPoints: 21400, yourPoints: 3210 },
    { name: "Dev K.",   joined: "May 29",  theirPoints: 12800, yourPoints: 1920 },
    { name: "Sam O.",   joined: "Jun 11",  theirPoints: 6200,  yourPoints: 930 },
    { name: "Priya T.", joined: "Jun 26",  theirPoints: 1400,  yourPoints: 210 },
  ];

  return {
    email: "demo@dwell.example",
    points: 12450,             // = $12.45 of earned ad value
    todayPoints: 380,
    monthPoints: 5240,
    lifetimePoints: 14450,     // balance = lifetime − the 2,000-point claim
    rows, series, friends,
    affiliate: {
      code: "DWELL7F3K", rewardPct: 15, capPeople: 1000, attributedCount: 4,
      earnedPoints: 6270, canApplyCode: false, upgraded: false, upgradeRequested: false,
    },
    sources: { chrome: true, claude_code: false, desktop: false },
    summary: { balancePoints: 12450, reserveUsd: 48120, pointsOutstanding: 3912400 },
  };
}
const MOCK = buildMock();

// The shareable referral link — this page, with the code attached.
function portalLink(code) {
  return `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}`;
}

// Dev-mode responses for the GET paths the portal reads. Kept next to the real
// paths so the two contracts stay in sync.
function mockGet(path) {
  const p = path.split("?")[0];
  if (p === "/v1/web/me") {
    return { email: MOCK.email, points: MOCK.points, needsSurvey: false, needsReferral: false };
  }
  if (p === "/v1/web/earnings") {
    const win = /window=(\w+)/.exec(path)?.[1] || "7d";
    const unit = win === "24h" ? "hour" : "day";
    const stepMs = unit === "hour" ? 3600e3 : 86400e3;
    const buckets = MOCK.series[win] || MOCK.series["7d"];
    const end = bucketStart(Date.now(), unit).getTime();
    return {
      todayPoints: MOCK.todayPoints,
      monthPoints: MOCK.monthPoints,
      lifetimePoints: MOCK.lifetimePoints,
      series: buckets.map((b, i) => ({
        t: new Date(end - (buckets.length - 1 - i) * stepMs).toISOString(),
        points: b.points,
        count: b.count,
      })),
    };
  }
  if (p === "/v1/web/activity") return { rows: MOCK.rows };
  if (p === "/v1/web/affiliate") {
    const a = MOCK.affiliate;
    return { ...a, link: portalLink(a.code), friends: MOCK.friends };
  }
  if (p === "/v1/web/sources") return { sources: MOCK.sources };
  if (p === "/v1/web/points/summary") return MOCK.summary;
  // Non-empty inventory keeps the out-of-stock notice hidden in dev mode.
  if (p === "/v1/ads") return { ads: [{ id: "mock-ad" }] };
  return {};
}

// ---- device link + session capture (kept from the shared login flow) ----
// The desktop app opens this page with its device creds in the fragment
// (#linkDevice=…&deviceKey=…) so we can link that device to the account once
// signed in. Stash them across the sign-in round-trip (the fragment is lost on
// the OAuth navigation) and scrub immediately — fragments never reach a server.
(function captureDeviceLink() {
  const id = location.hash.match(/linkDevice=([^&]+)/);
  const key = location.hash.match(/deviceKey=([^&]+)/);
  if (id && key) {
    try {
      localStorage.setItem(PENDING_LINK_KEY, JSON.stringify({
        deviceId: decodeURIComponent(id[1]),
        deviceKey: decodeURIComponent(key[1]),
      }));
    } catch (e) {}
    history.replaceState(null, "", location.pathname);
  }
})();

// Session token from OAuth or magic-link arrives in URL fragment; stash and scrub.
(function captureSession() {
  const m = location.hash.match(/session=([^&]+)/);
  if (m) {
    localStorage.setItem(SESSION_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
  }
})();

// Show OAuth error from ?login= query param, then clean URL.
(function captureOAuthError() {
  const params = new URLSearchParams(location.search);
  const login = params.get("login");
  if (!login) return;
  history.replaceState(null, "", location.pathname);
  const msgs = {
    cancelled: "Sign-in was cancelled. Try again.",
    error:     "Something went wrong with sign-in. Try again or use email.",
    "no-google": "Google sign-in is not configured. Use email instead.",
    "no-apple":  "Apple sign-in is not configured. Use email instead.",
    expired:     "That sign-in link expired. Request a new one.",
  };
  showError(msgs[login] || "Sign-in failed. Try again.");
})();

// Referral code from ?ref= (shared link). Stash it, prefill the field, scrub URL.
let referralCode = "";
(function captureRef() {
  const ref = new URLSearchParams(location.search).get("ref");
  if (!ref) return;
  referralCode = ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  history.replaceState(null, "", location.pathname);
})();

// Current referral code: whatever's typed in the field, else the captured one.
function getReferralCode() {
  const v = ($("referral-code")?.value || "").trim();
  return v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

const getSession = () => localStorage.getItem(SESSION_KEY);

// ---- API layer ----
// Dev mode short-circuits to the seeded mocks above; outside it, a network
// failure resolves to status 0 so callers degrade quietly instead of throwing.
async function apiGet(path) {
  if (isDev()) return { status: 200, body: mockGet(path) };
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${getSession()}` },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    return { status: 0, body: {} };
  }
}
async function apiPost(path, payload) {
  if (isDev()) return { status: 200, body: {} };
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getSession()}` },
      body: JSON.stringify(payload || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    return { status: 0, body: {} };
  }
}

// Expired token: drop the session and start over from login.
function sessionExpired() {
  localStorage.removeItem(SESSION_KEY);
  location.reload();
}

// ---- page views ----
// Mutually-exclusive top-level states: loading splash, login, survey,
// onboarding, portal. The inline <head> script paints the splash for returning
// (and dev-mode) users; once we take over here we drop that gate class so the
// `hidden` attribute alone governs.
function clearAuthGate() {
  document.documentElement.classList.remove("auth-pending");
}
function hideAllPages() {
  $("portal-loading").hidden = true;
  $("login-page").hidden = true;
  $("survey-page").hidden = true;
  $("onboarding-page").hidden = true;
  $("portal-page").hidden = true;
}
function showLoading() {
  clearAuthGate();
  hideAllPages();
  $("portal-loading").hidden = false;
}
function showLoginPage() {
  clearAuthGate();
  hideAllPages();
  $("login-page").hidden = false;
}
// First-login survey gate: two multi-select questions (models, surfaces) shown
// before the refer-a-friend step. Cleared once /v1/web/onboarding/survey saves.
function showSurvey(email) {
  clearAuthGate();
  hideAllPages();
  $("survey-page").hidden = false;
  accountEmail = email;
  surveyStep("models");
}
// First-login gate: the user must invite two friends before the dashboard
// unlocks. A valid email is enough (the server validates it on invite).
function showOnboarding(email) {
  clearAuthGate();
  hideAllPages();
  $("onboarding-page").hidden = false;
  accountEmail = email;
}
function showPortalPage(email) {
  clearAuthGate();
  hideAllPages();
  $("portal-page").hidden = false;
  accountEmail = email;
  $("balance-email").textContent = email;
  // Portal nav: surface who's signed in, to the left of the wallet chip.
  const who = $("nav-signed-in");
  if (who) {
    who.textContent = "Signed in as " + email;
    who.hidden = false;
  }
  showSection("earnings");
}

// ---- authed sub-views: one section visible at a time ----
const SECTION_VIEWS = {
  earnings: "earnings-view",
  activity: "activity-view",
  cashout: "cashout-view",
  referrals: "referrals-view",
  install: "install-view",
};

function showSection(name) {
  for (const [key, id] of Object.entries(SECTION_VIEWS)) {
    const el = $(id);
    if (el) el.hidden = key !== name;
  }
  document.querySelectorAll(".dash-tab").forEach((tab) => {
    const on = tab.dataset.section === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (name === "referrals") loadAffiliate();
  if (name === "activity" && activityRows === null) retrieveActivity();
  if (name === "install") loadServiceActivation();
}

$("dash-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".dash-tab");
  if (tab) showSection(tab.dataset.section);
});

// ---- wallet chip + modal (mock — no web3 libraries, no live calls) ----
$("wallet-chip").addEventListener("click", () => { $("wallet-modal").hidden = false; });
$("wallet-modal-close").addEventListener("click", () => { $("wallet-modal").hidden = true; });
$("wallet-modal").addEventListener("click", (e) => {
  if (e.target === $("wallet-modal")) $("wallet-modal").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("wallet-modal").hidden = true;
});

// ---- install tab: per-service "active" status ----
// The checkbox and the brand-mark chip are both server truth — the user can't tick the
// box themselves. A product's row ticks its checkbox and fills its greyed logo
// into color the moment this account earns its first points from that service
// (GET /v1/web/sources); until then the box stays empty and the logo greyed.
const INSTALL_PRODUCTS = ["chrome", "claude_code", "desktop"];

function applyServiceActivation(sources) {
  let anyLive = false;
  for (const product of INSTALL_PRODUCTS) {
    const live = !!(sources && sources[product]);
    anyLive = anyLive || live;
    // querySelectorAll: the same product tile appears on both the Install tab
    // and the Earnings tab's status row — toggle every instance to stay in sync.
    document.querySelectorAll(`.logo[data-active="${product}"]`).forEach((logo) => {
      logo.classList.toggle("is-inactive", !live);
      const wrap = logo.closest(".install-active, .earn-surface");
      if (wrap) wrap.classList.toggle("is-live", live);
    });
    document.querySelectorAll(`[data-active-label="${product}"]`).forEach((label) => {
      label.textContent = live ? "Active" : "Inactive";
    });
    document.querySelectorAll(`.install-check[data-product="${product}"]`).forEach((chk) => {
      chk.classList.toggle("sel", live);
      chk.setAttribute("aria-checked", live ? "true" : "false");
    });
  }
  const heroLogo = $("install-hero-logo");
  if (heroLogo) heroLogo.classList.toggle("is-inactive", !anyLive);
  const heroTitle = $("install-hero-title");
  if (heroTitle) heroTitle.textContent = anyLive ? "You're earning" : "Not earning yet";
}

async function loadServiceActivation() {
  const { status, body } = await apiGet("/v1/web/sources");
  if (status === 401) return sessionExpired();
  if (status !== 200) return;
  applyServiceActivation(body && body.sources ? body.sources : body);
}

// ---- referrals (self-serve: everyone earns the protocol's 10% referrer
// share; the form is the partner upgrade for uncapped referrals) ----
async function loadAffiliate() {
  // Reveal the block up front so the tab isn't blank while the request is in
  // flight — the data-driven sub-states below fill in once it resolves.
  $("affiliate-block").hidden = false;
  const { status, body } = await apiGet("/v1/web/affiliate");
  if (status === 401) return sessionExpired();
  if (status !== 200) return;
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  $("aff-have-code").hidden = !body.canApplyCode;

  const upgraded = !!body.upgraded;
  const requested = !!body.upgradeRequested;
  const capPeople = body.capPeople ?? 1000;
  const attributed = body.attributedCount || 0;
  const uncapped = capPeople >= 100000; // 100k+ friends = effectively unlimited

  // Base enrollment — code + link + stats, always shown.
  show("aff-approved", true);
  $("aff-pct").textContent = (body.rewardPct ?? 15) + "%";
  $("aff-cap").textContent = uncapped ? "no cap" : capPeople.toLocaleString() + " friends";
  $("aff-link").value = body.link || "";
  $("aff-users").textContent = attributed;
  $("aff-earned").textContent = pts(body.earnedPoints ?? Math.round((body.creditedUsd || 0) * 1000));
  $("aff-remaining").textContent = uncapped ? "Unlimited" : Math.max(0, capPeople - attributed).toLocaleString();
  renderFriends(body.friends);

  // Partner upgrade — form, or its requested / granted state.
  show("aff-upgrade", !upgraded && !requested);
  show("aff-upgrade-requested", !upgraded && requested);
  show("aff-upgrade-granted", upgraded);
  if (upgraded) $("aff-custom-pct").textContent = (body.rewardPct ?? 15) + "%";
}

// Per-friend table: who joined with your code, their lifetime points, and
// your 10% share — carved from each campaign's pool, never from their 60%.
function renderFriends(friends) {
  const host = $("ref-friends");
  if (!host) return;
  if (!Array.isArray(friends) || !friends.length) {
    host.innerHTML = `<p class="ref-empty">No friends joined yet — share your link above.</p>`;
    return;
  }
  const head =
    `<div class="fr-row fr-head">` +
    `<span>Friend</span><span>Their lifetime points</span><span class="fr-share">Your 10% share</span>` +
    `</div>`;
  const items = friends.map((f) => (
    `<div class="fr-row">` +
    `<span class="fr-name">${escapeHtml(f.name || "")}<span class="fr-joined">joined ${escapeHtml(f.joined || "")}</span></span>` +
    `<span class="fr-their">${pts(f.theirPoints)} pts</span>` +
    `<span class="fr-share">+${pts(f.yourPoints)} pts</span>` +
    `</div>`
  )).join("");
  host.innerHTML = head + items;
}

function setMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  el.className = "ref-invite-msg" + (kind ? ` ${kind}` : "");
}

// Submit a partner application. Mirror the server rule client-side: at least
// one handle, and a follower count for every handle filled in.
$("aff-apply-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = (id) => ($(id).value || "").trim();
  const payload = {
    instagram: v("aff-ig"), instagramFollowers: v("aff-ig-f"),
    linkedin: v("aff-li"), linkedinFollowers: v("aff-li-f"),
    twitter: v("aff-tw"), twitterFollowers: v("aff-tw-f"),
  };
  const pairs = [["aff-ig", "aff-ig-f"], ["aff-li", "aff-li-f"], ["aff-tw", "aff-tw-f"]];
  const filled = pairs.filter(([h]) => v(h));
  if (!filled.length) { setMsg("aff-apply-msg", "Add at least one social handle.", "err"); return; }
  if (filled.some(([, f]) => !v(f))) { setMsg("aff-apply-msg", "Add a follower count for each handle.", "err"); return; }
  const btn = $("aff-apply-btn");
  btn.disabled = true;
  setMsg("aff-apply-msg", "Submitting…", "");
  const { status, body } = await apiPost("/v1/web/affiliate/apply", payload);
  btn.disabled = false;
  if (status === 401) return sessionExpired();
  if (status === 200) { setMsg("aff-apply-msg", "Upgrade requested — we'll review your socials and be in touch.", "ok"); loadAffiliate(); }
  else setMsg("aff-apply-msg", (body && body.error) || "Couldn't submit that. Try again.", "err");
});

// Retroactively attach a referral code to your account.
$("aff-code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = ($("aff-code-input").value || "").trim();
  if (!code) return;
  const btn = $("aff-code-btn");
  btn.disabled = true;
  setMsg("aff-code-msg", "Applying…", "");
  const { status, body } = await apiPost("/v1/web/affiliate-code", { code });
  btn.disabled = false;
  if (status === 401) return sessionExpired();
  if (status === 200) { setMsg("aff-code-msg", "Referral code applied to your account.", "ok"); $("aff-code-input").value = ""; loadAffiliate(); }
  else setMsg("aff-code-msg", (body && body.error) || "Couldn't apply that code.", "err");
});

$("aff-copy").addEventListener("click", () => copyFrom("aff-link", "aff-copy"));

// Copy a readonly input's value to the clipboard, flashing the button label.
async function copyFrom(inputId, btnId) {
  const input = $(inputId);
  const link = input && input.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
  } catch (e) {
    input.select();
    try { document.execCommand("copy"); } catch (e2) {}
  }
  const btn = $(btnId);
  const old = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---- auth card steps ----
function showError(msg) {
  const el = $("auth-error");
  el.textContent = msg;
  el.hidden = !msg;
}
function showStep(step) {
  $("auth-step-providers").hidden = step !== "providers";
  $("auth-step-sent").hidden      = step !== "sent";
  if (step !== "sent") showError("");
}

// ── OAuth provider buttons ──
function oauthUrl(provider) {
  const ref = getReferralCode();
  return `${API_BASE}/v1/auth/${provider}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}
$("google-btn").addEventListener("click", (e) => {
  e.preventDefault();
  if (!API_BASE) return showError("Sign-in is unavailable right now.");
  window.location.href = oauthUrl("google");
});
$("apple-btn").addEventListener("click", (e) => {
  e.preventDefault();
  if (!API_BASE) return showError("Sign-in is unavailable right now.");
  window.location.href = oauthUrl("apple");
});

// ── Send magic link ──
let lastEmail = "";

async function requestLink(email) {
  if (!API_BASE) { showError("Sign-in is unavailable right now."); return false; }
  const { status } = await apiPost("/v1/web/login", { email, referralCode: getReferralCode() });
  return status === 200;
}

$("login-btn").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  if (!email) return;
  lastEmail = email;
  $("login-btn").disabled = true;
  $("login-btn").textContent = "Sending…";
  const ok = await requestLink(email);
  $("login-btn").disabled = false;
  $("login-btn").textContent = "Email me a sign-in link";
  if (ok) {
    $("auth-sent-msg").textContent =
      `We sent a sign-in link to ${email}. Check your inbox — it expires in 30 minutes.`;
    showStep("sent");
  } else {
    showError("That didn't work. Double-check your email and try again.");
  }
});

$("login-email").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("login-btn").click();
});

// ── Resend (both buttons) ──
async function handleResend(btn) {
  if (!lastEmail) { showStep("providers"); return; }
  btn.disabled = true;
  btn.textContent = "Sending…";
  await requestLink(lastEmail);
  btn.disabled = false;
  btn.textContent = "Resend sign-in email";
  $("auth-sent-msg").textContent =
    `Resent to ${lastEmail}. Check your inbox — it expires in 30 minutes.`;
}
$("resend-btn").addEventListener("click", () => handleResend($("resend-btn")));
$("resend-btn-2").addEventListener("click", () => handleResend($("resend-btn-2")));

// ── "← back" from sent step ──
$("back-btn").addEventListener("click", () => showStep("providers"));

// ── Sign out ──
$("signout").addEventListener("click", async () => {
  // Revoke server-side first so the token is dead even if a copy lingers
  // anywhere; best-effort — clear locally and reload regardless. Dev mode is
  // cleared too, so signing out of a demo lands on the real login screen.
  try { await apiPost("/v1/web/logout", {}); } catch (e) {}
  localStorage.removeItem(SESSION_KEY);
  try { localStorage.removeItem(DEV_KEY); } catch (e) {}
  location.replace(location.pathname);
});

// ---- first-login survey: "what models" then "where do you use them" ----
const surveyModels = new Set();
const surveySurfaces = new Set();

function surveyStep(name) {
  $("survey-step-models").hidden = name !== "models";
  $("survey-step-surfaces").hidden = name !== "surfaces";
}
function setSurveyError(id, msg) {
  const el = $(id);
  el.textContent = msg || "";
  el.hidden = !msg;
}

// Toggle a multi-select chip and keep the backing set in sync.
function wireSurveyOptions(containerId, set, onChange) {
  $(containerId).addEventListener("click", (e) => {
    const opt = e.target.closest(".survey-opt");
    if (!opt) return;
    const v = opt.dataset.value;
    if (set.has(v)) { set.delete(v); opt.classList.remove("sel"); }
    else { set.add(v); opt.classList.add("sel"); }
    if (onChange) onChange();
  });
}
wireSurveyOptions("survey-models", surveyModels);
wireSurveyOptions("survey-surfaces", surveySurfaces, () => {
  // Reveal the free-text box only when "Other" is among the selected surfaces.
  $("survey-surface-other").hidden = !surveySurfaces.has("other");
});

// Step 1 → Step 2
$("survey-models-next").addEventListener("click", () => {
  if (!surveyModels.size) return setSurveyError("survey-models-error", "Pick at least one.");
  setSurveyError("survey-models-error", "");
  surveyStep("surfaces");
});
// Step 2 → back
$("survey-back").addEventListener("click", () => surveyStep("models"));

// Step 2 → submit the survey, then continue to the refer-a-friend step (or
// straight to the dashboard if this user has already referred).
$("survey-surfaces-next").addEventListener("click", async () => {
  if (!surveySurfaces.size) return setSurveyError("survey-surfaces-error", "Pick at least one.");
  const btn = $("survey-surfaces-next");
  setSurveyError("survey-surfaces-error", "");
  btn.disabled = true;
  btn.textContent = "Saving…";
  const payload = {
    models: [...surveyModels],
    surfaces: [...surveySurfaces],
    surfaceOther: surveySurfaces.has("other") ? ($("survey-surface-other").value || "").trim() : "",
  };
  const { status, body } = await apiPost("/v1/web/onboarding/survey", payload);
  if (status === 401) return sessionExpired();
  if (status === 200) {
    if (onboardNeedsReferral) showOnboarding(accountEmail);
    else enterDashboard(accountEmail);
    return;
  }
  btn.disabled = false;
  btn.textContent = "Continue";
  setSurveyError("survey-surfaces-error", (body && body.error) || "Couldn't save that. Try again.");
});

// ---- first-login onboarding: invite two friends to unlock the dashboard ----
function setOnboardError(msg) {
  const el = $("onboard-error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

$("onboard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email1 = ($("onboard-email").value || "").trim();
  const email2 = ($("onboard-email-2").value || "").trim();
  if (!email1 || !email2) return;
  // Two distinct friends — the same address twice is one invite, not two.
  if (email1.toLowerCase() === email2.toLowerCase()) {
    setOnboardError("Please enter two different friends' emails.");
    return;
  }
  const btn = $("onboard-btn");
  setOnboardError("");
  btn.disabled = true;
  btn.textContent = "Sending…";
  // Valid emails are all that's required — the friends never have to sign up
  // for the user to progress past onboarding. The server validates each
  // address and rejects the user's own email.
  for (const email of [email1, email2]) {
    const { status, body } = await apiPost("/v1/web/affiliate/invite", { email });
    if (status === 401) return sessionExpired();
    if (status !== 200) {
      btn.disabled = false;
      btn.textContent = "Send invites & continue";
      setOnboardError((body && body.error) || `Couldn't send the invite to ${email}. Check the email and try again.`);
      return;
    }
  }
  enterDashboard(accountEmail);
});

// ---- state ----
let balancePoints = 0;
let accountEmail = "";
// Captured from /v1/web/me so the survey step knows whether the refer-a-friend
// gate still stands once the survey is submitted.
let onboardNeedsReferral = false;

// Paint the points balance everywhere it appears: the Earnings header block
// and the Cash out tab's summary tiles. One number, one conversion rule.
function setBalance(points) {
  balancePoints = Math.round(Number(points) || 0);
  const big = `${pts(balancePoints)} <span class="balance-unit">points</span>`;
  $("balance").innerHTML = big;
  $("co-points").innerHTML = big;
  const conv = `= ${usdFromPoints(balancePoints)} of earned ad value`;
  $("balance-usd").textContent = conv;
  $("co-usd").textContent = conv;
  $("co-sum-points").textContent = pts(balancePoints);
  $("co-sum-usd").textContent = usdFromPoints(balancePoints);
}

// ---- points summary + reserve strip ----
// GET /v1/web/points/summary carries the balance plus protocol-wide reserve
// accounting. On any failure outside dev mode the strip keeps its static line.
async function loadPointsSummary() {
  const { status, body } = await apiGet("/v1/web/points/summary");
  if (status !== 200 || !body) return;
  if (body.balancePoints != null) setBalance(body.balancePoints);
  if (body.reserveUsd != null) $("reserve-usd").textContent = usdWhole(body.reserveUsd);
  if (body.pointsOutstanding != null) $("reserve-points").textContent = pts(body.pointsOutstanding);
}

// ---- earnings dashboard ----
let earnWindow = "7d";

// A bucket's points: the API may hand back points directly or a USD amount
// from the shared earnings path — normalize to points (1,000 per dollar).
const toPoints = (obj, ptsKey, usdKey) =>
  obj[ptsKey] != null ? Number(obj[ptsKey]) : Math.round((Number(obj[usdKey]) || 0) * 1000);

async function loadEarnings(window = earnWindow) {
  earnWindow = window;
  const { status, body } = await apiGet(`/v1/web/earnings?window=${window}`);
  if (status === 401) return sessionExpired();
  if (status !== 200) return;
  $("earn-today").textContent = pts(toPoints(body, "todayPoints", "todayUsd"));
  $("earn-month").textContent = pts(toPoints(body, "monthPoints", "monthUsd"));
  $("earn-lifetime").textContent = pts(toPoints(body, "lifetimePoints", "lifetimeUsd"));
  const series = (body.series || []).map((b) => ({
    t: b.t,
    points: toPoints(b, "points", "usd"),
    count: b.count || 0,
  }));
  renderChart(series, window);
  loadServiceActivation(); // light up the "Where you're earning" status row
}

// Snap a Date to the start of its hour/day bucket (local time) for axis fill.
function bucketStart(d, unit) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  if (unit === "day") x.setHours(0, 0, 0, 0);
  return x;
}

// Build a continuous, gap-filled axis from the sparse series so the chart
// shows zero-credit periods too.
function fillSeries(series, window) {
  const unit = window === "24h" ? "hour" : "day";
  const points = window === "24h" ? 24 : window === "7d" ? 7 : 30;
  const stepMs = unit === "hour" ? 3600e3 : 86400e3;
  const byKey = new Map();
  for (const b of series) byKey.set(bucketStart(b.t, unit).getTime(), b);
  const end = bucketStart(Date.now(), unit).getTime();
  const out = [];
  for (let i = points - 1; i >= 0; i--) {
    const t = end - i * stepMs;
    const hit = byKey.get(t);
    out.push({ t: new Date(t), points: hit ? hit.points : 0, count: hit ? hit.count : 0 });
  }
  return out;
}

function renderChart(series, window) {
  const host = $("earn-chart");
  const buckets = fillSeries(series, window);
  const totalPts = buckets.reduce((s, p) => s + p.points, 0);
  const totalEvents = buckets.reduce((s, p) => s + p.count, 0);
  $("earn-chart-foot").textContent =
    `${pts(totalPts)} points across ${totalEvents.toLocaleString()} event${totalEvents === 1 ? "" : "s"}`;

  const W = 720, H = 220, padL = 8, padR = 8, padT = 14, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...buckets.map((p) => p.points), 0);
  const baseY = padT + innerH;
  const xAt = (i) => padL + (buckets.length === 1 ? innerW / 2 : (i / (buckets.length - 1)) * innerW);
  const yAt = (v) => (max <= 0 ? baseY : baseY - (v / max) * innerH);

  // baseline grid + faint horizontal rules
  const grid = [0, 0.5, 1].map((f) => {
    const y = padT + innerH - f * innerH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="ec-grid" />`;
  }).join("");

  const linePts = buckets.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.points).toFixed(1)}`).join(" ");
  const areaPts = `${padL},${baseY} ${linePts} ${(W - padR)},${baseY}`;

  // sparse x labels: ~every Nth bucket
  const labelEvery = Math.ceil(buckets.length / 8);
  const labels = buckets.map((p, i) => {
    if (i % labelEvery !== 0 && i !== buckets.length - 1) return "";
    const txt = window === "24h"
      ? p.t.toLocaleTimeString(undefined, { hour: "numeric" })
      : p.t.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="ec-xlabel">${txt}</text>`;
  }).join("");

  const dots = max > 0
    ? buckets.map((p, i) => p.points > 0
        ? `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.points).toFixed(1)}" r="2.6" class="ec-dot" />`
        : "").join("")
    : "";

  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ec-svg" role="img" aria-label="Points earned over time">` +
    grid +
    `<polygon points="${areaPts}" class="ec-area" />` +
    `<polyline points="${linePts}" class="ec-line" />` +
    dots + labels +
    `</svg>`;
}

$("earn-window").addEventListener("click", (e) => {
  const btn = e.target.closest(".ew-btn");
  if (!btn) return;
  $("earn-window").querySelectorAll(".ew-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  loadEarnings(btn.dataset.window);
});

// ---- activity ledger ----
let activityRows = null;

const ACT_LABEL = {
  points_credit: "Watched a sponsored line",
  referral_points_credit: "Referral share — 10%",
  token_claim_debit: "Converted at token launch",
};

function setActStatus(text, ok) {
  const el = $("act-status");
  el.textContent = text;
  el.classList.toggle("ok", !!ok);
  el.hidden = !text; // no empty status pill once the ledger has loaded
}

// Auto-loaded on sign-in (and retryable on failure): pulls the last 200 ledger
// entries for this account; search + filter then run locally on the rows.
async function retrieveActivity() {
  setActStatus("Loading…");
  $("act-body").innerHTML =
    `<div class="act-loading"><div class="portal-spinner"></div><p>Loading your activity…</p></div>`;
  const { status, body } = await apiGet("/v1/web/activity?limit=200");
  if (status === 401) return sessionExpired();
  if (status !== 200) {
    setActStatus("Failed");
    $("act-body").innerHTML =
      `<div class="act-empty"><p>Couldn't load your activity. Check your connection and try again.</p>` +
      `<button class="btn-accent" id="act-retry" type="button">Retry</button></div>`;
    $("act-retry").addEventListener("click", retrieveActivity);
    return;
  }
  // Normalize each row's amount to points (shared paths may carry USD).
  activityRows = (body.rows || []).map((r) => ({ ...r, points: toPoints(r, "points", "amountUsd") }));
  setActStatus("", true);
  $("act-search").disabled = false;
  $("act-filter").disabled = false;
  renderActivity();
}

function filteredActivity() {
  if (!activityRows) return [];
  const q = ($("act-search").value || "").trim().toLowerCase();
  const type = $("act-filter").value;
  return activityRows.filter((r) => {
    if (type !== "all" && r.type !== type) return false;
    if (!q) return true;
    const hay = `${r.advertiser || ""} ${r.id} ${r.type} ${ACT_LABEL[r.type] || ""}`.toLowerCase();
    return hay.includes(q);
  });
}

// Ledger is paginated client-side — render at most one page of rows at a time.
const ACT_PAGE_SIZE = 50;
let actPage = 0;

function renderActivity() {
  const body = $("act-body");
  const pager = $("act-pager");
  const rows = filteredActivity();
  $("act-count").textContent = `${rows.length} of ${activityRows.length} rows`;

  if (!activityRows.length) {
    body.innerHTML = `<div class="act-empty"><p>No entries yet. Watch a sponsored line while your assistant thinks to start earning points.</p></div>`;
    if (pager) pager.hidden = true;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<div class="act-empty"><p>No entries match your search.</p></div>`;
    if (pager) pager.hidden = true;
    return;
  }

  // Clamp the page in case the filtered set shrank under the current offset.
  const pageCount = Math.ceil(rows.length / ACT_PAGE_SIZE);
  if (actPage > pageCount - 1) actPage = pageCount - 1;
  if (actPage < 0) actPage = 0;
  const start = actPage * ACT_PAGE_SIZE;
  const pageRows = rows.slice(start, start + ACT_PAGE_SIZE);

  const head =
    `<div class="act-row act-row-head">` +
    `<span>Entry</span><span>Sponsor</span><span>When</span><span class="act-amt">Points</span>` +
    `</div>`;
  const items = pageRows.map((r) => {
    const when = r.createdAt ? new Date(r.createdAt).toLocaleString() : "";
    // r.type is a server enum today, but escape it (text) and reduce it to safe
    // class characters (attribute) so a future backend change can't turn this
    // innerHTML sink into stored XSS in the signed-in portal.
    const label = escapeHtml(ACT_LABEL[r.type] || r.type || "");
    const typeClass = String(r.type || "").replace(/[^a-z0-9_-]/gi, "");
    const debit = r.points < 0;
    return (
      `<div class="act-row">` +
      `<span class="act-type ${typeClass}">${label}</span>` +
      `<span class="act-adv">${r.advertiser ? escapeHtml(r.advertiser) : "—"}</span>` +
      `<span class="act-when">${when}</span>` +
      `<span class="act-amt${debit ? " is-debit" : ""}">${ptsSigned(r.points)}</span>` +
      `</div>`
    );
  }).join("");
  body.innerHTML = head + items;
  renderActPager(rows.length, pageCount, start, pageRows.length);
}

// Prev / range / Next under the ledger; hidden when everything fits one page.
function renderActPager(total, pageCount, start, shown) {
  const pager = $("act-pager");
  if (!pager) return;
  if (pageCount <= 1) { pager.hidden = true; pager.innerHTML = ""; return; }
  pager.hidden = false;
  pager.innerHTML =
    `<button class="act-page-btn" id="act-prev" type="button" ${actPage === 0 ? "disabled" : ""}>← Prev</button>` +
    `<span class="act-page-info">${start + 1}–${start + shown} of ${total} · page ${actPage + 1} of ${pageCount}</span>` +
    `<button class="act-page-btn" id="act-next" type="button" ${actPage >= pageCount - 1 ? "disabled" : ""}>Next →</button>`;
  $("act-prev").addEventListener("click", () => { if (actPage > 0) { actPage--; renderActivity(); } });
  $("act-next").addEventListener("click", () => { if (actPage < pageCount - 1) { actPage++; renderActivity(); } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Any new search/filter resets to the first page of results.
$("act-search").addEventListener("input", () => { actPage = 0; renderActivity(); });
$("act-filter").addEventListener("change", () => { actPage = 0; renderActivity(); });

// ---- boot ----
// Link a pending desktop device (creds stashed by captureDeviceLink) to the
// now-signed-in account. On failure we keep the pending key (so it retries on
// the next signed-in load) AND tell the user, so a silent failure can't strand
// their points without explanation.
async function maybeLinkDevice() {
  let pend = null;
  try { pend = JSON.parse(localStorage.getItem(PENDING_LINK_KEY) || "null"); } catch (e) {}
  if (!pend || !pend.deviceId || !pend.deviceKey) return;
  const { status, body } = await apiPost("/v1/devices/link", {
    deviceId: pend.deviceId,
    deviceKey: pend.deviceKey,
  });
  if (status === 200) {
    localStorage.removeItem(PENDING_LINK_KEY);
    toast("✓ Desktop app linked to your account", "ok");
  } else {
    console.warn("[link] /v1/devices/link failed:", status, body);
    toast("Couldn't link your desktop app — try again from the app's menu.", "err");
  }
}

// Small bottom-center toast. kind: "ok" (default) or "err" (sticks longer).
// Styled by the .toast classes in portal.css — no inline colors here.
function toast(msg, kind = "ok") {
  try {
    const t = document.createElement("div");
    t.textContent = msg;
    t.className = "toast" + (kind === "err" ? " err" : "");
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 400);
    }, kind === "err" ? 5000 : 3500);
  } catch (e) {}
}

async function boot() {
  showStep("providers"); // default card state
  // Prefill a referral code shared via ?ref= and surface it to the new user.
  if (referralCode) {
    if ($("referral-code")) $("referral-code").value = referralCode;
    const note = $("referral-note");
    if (note) {
      note.textContent = `Referral code ${referralCode} applied.`;
      note.hidden = false;
    }
  }
  // Dev mode: straight to the dashboard on seeded mock data. No network.
  if (isDev()) {
    enterDashboard(MOCK.email);
    return;
  }
  if (!getSession() || !API_BASE) return showLoginPage();
  // Returning user: keep the splash up (login stays hidden) while we confirm
  // the session, so there's no flash of the login form before the dashboard.
  // A dead or revoked token falls back to login below.
  showLoading();
  const me = await apiGet("/v1/web/me");
  if (me.status !== 200) return showLoginPage();
  await maybeLinkDevice(); // link a desktop device if one is pending
  setBalance(toPoints(me.body, "points", "balanceUsd"));
  onboardNeedsReferral = !!me.body.needsReferral;
  // First-login onboarding runs in order: survey questions, then refer a
  // friend, then the dashboard. Each gate is skipped once cleared.
  if (me.body.needsSurvey) { showSurvey(me.body.email); return; }
  if (me.body.needsReferral) { showOnboarding(me.body.email); return; }
  enterDashboard(me.body.email);
}

// Reveal the dashboard and kick off its data loads. Shared by the returning-
// user path, the dev-mode path, and the moment a new user clears onboarding.
function enterDashboard(email) {
  showPortalPage(email);
  setBalance(balancePoints); // paint whatever we know now; summary refines it
  loadEarnings("7d");
  retrieveActivity();  // auto-load the ledger so it's ready when the tab opens
  loadPointsSummary(); // balance + the reserve strip
  checkInventory();
}

// The out-of-inventory notice: /v1/ads is public (no session needed) and
// returns an empty list whenever the auction has no funded campaign to serve.
// Mirrors the same check in the extension popup.
async function checkInventory() {
  try {
    const res = await apiGet("/v1/ads");
    const hasInventory = res.status === 200 && Array.isArray(res.body.ads) && res.body.ads.length > 0;
    if ($("inventory-notice")) $("inventory-notice").hidden = hasInventory;
  } catch (_) {}
}

boot();
