// Dwell Protocol — service worker
// Holds earnings state and the revenue math. The viewer's share of each
// campaign's pool (the server-provided revenueShare) accrues as dwells:
// 1,000 dwells = $1.00 of earned ad value. State stays USD-denominated to
// match the API; the popup converts to dwells for display.
//
// Talks to the production backend (Supabase Edge Function):
//   • registers an anonymous device (deviceId + deviceKey)
//   • pulls the live ad inventory from the auction (/v1/ads)
//   • bills impressions through server-issued single-use tokens
//     (/v1/impressions/serve then /v1/impressions/redeem after the on-screen dwell)
//   • records clicks through single-use, forgery-proof tokens (/v1/clicks/intent)
//   • honours the server killswitch (/v1/config → serving)
// All network use is feature-guarded so the headless test harness (no fetch /
// alarms / crypto) still exercises the local revenue math unchanged.

importScripts("ads.js");

const API_BASE = "https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/dwell-api";

const DEFAULTS = {
  enabled: true,
  testMode: false, // show the mock ad continuously so you can verify the loop
  serving: true, // mirrors the server killswitch (/v1/config); ads off when false
  houseAdEnabled: true, // mirrors /v1/config; show the house ad on an empty auction
  revenueShare: 0.5, // offline fallback only — /v1/config's revenueShare always overrides
  grossCpm: 12, // gross USD per 1,000 qualifying (2-second) impressions
  blockedCategories: [],
  impressions: 0,
  clicks: 0,
  earnings: 0,
  // "Ads watched" — the count of DISTINCT ads the user actually saw (one per
  // generation the bar was shown for), NOT the 2s billing ticks in `impressions`.
  // A single ad shown across a long reply is many impressions but one ad watched.
  adViews: 0,
  // Test Mode events are kept in their own counters so they never pollute real,
  // billable earnings — the popup surfaces them only while Test Mode is on.
  testImpressions: 0,
  testClicks: 0,
  testAdViews: 0,
  installedAt: Date.now(),
};

async function getState() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s, mockAd: self.BB_MOCK_AD };
}

function perImpressionNet(s) {
  return (s.grossCpm / 1000) * s.revenueShare;
}

async function recordImpression(mock) {
  const s = await getState();
  if (!s.enabled) return s;
  // Mock impressions (Test Mode) tick a separate counter and earn nothing real.
  // Real impressions bump the OPTIMISTIC local counters for snappy popup
  // feedback; the AUTHORITATIVE credit is the server-side redeem (serve → dwell
  // → redeem, below) — not a self-reported count.
  let next;
  if (mock) {
    next = { testImpressions: s.testImpressions + 1 };
  } else {
    // No credit until the device is linked to an account — otherwise the popup
    // would show earnings the account-scoped web portal can never display. We
    // still count the impression so the popup reflects that ads are being served.
    const linked = await isDeviceLinked();
    next = {
      impressions: s.impressions + 1,
      earnings: linked ? +(s.earnings + perImpressionNet(s)).toFixed(6) : s.earnings,
    };
  }
  await chrome.storage.local.set(next);
  return { ...s, ...next };
}

// One ad view = one distinct ad the user saw (the content script fires BB_VIEW
// once per generation the bar was shown for). Purely a display stat — no billing,
// no network. The credit-minting path stays recordImpression → serve/redeem.
async function recordView(mock) {
  const s = await getState();
  if (!s.enabled) return s;
  const next = mock
    ? { testAdViews: s.testAdViews + 1 }
    : { adViews: s.adViews + 1 };
  await chrome.storage.local.set(next);
  return { ...s, ...next };
}

async function recordClick(mock) {
  const s = await getState();
  const next = mock
    ? { testClicks: s.testClicks + 1 }
    : {
        // clicks are free now — recorded for the count, but they don't earn
        // (the 50x click billing was removed server-side).
        clicks: s.clicks + 1,
      };
  await chrome.storage.local.set(next);
  return { ...s, ...next };
}

// ---------- prod backend ----------
// Server ads are { id, brand, line, url, cat } with no presentational fields;
// the injected bar renders a chip + colours, so derive them deterministically.
const AD_PALETTE = [
  { color: "#1d6cff", ink: "#fff" },
  { color: "#5b5bd6", ink: "#fff" },
  { color: "#00e599", ink: "#04130a" },
  { color: "#ffd54a", ink: "#1b1e25" },
  { color: "#111111", ink: "#fff" },
  { color: "#7c3aed", ink: "#fff" },
  { color: "#0ea5e9", ink: "#fff" },
  { color: "#10b981", ink: "#fff" },
  { color: "#f59e0b", ink: "#1b1e25" },
];
function decorateAd(a) {
  const brand = a.brand || "";
  const chip = ((brand.match(/[A-Za-z0-9]/) || ["•"])[0]).toUpperCase();
  let h = 0;
  for (let i = 0; i < brand.length; i++) h = (h * 31 + brand.charCodeAt(i)) >>> 0;
  const pal = AD_PALETTE[h % AD_PALETTE.length];
  return { id: a.id, brand, chip, color: pal.color, ink: pal.ink, line: a.line, url: a.url, cat: a.cat || "other", change: typeof a.change === "number" ? a.change : undefined };
}

async function getDevice() {
  const { deviceId, deviceKey } = await chrome.storage.local.get(["deviceId", "deviceKey"]);
  return deviceId && deviceKey ? { deviceId, deviceKey } : null;
}

async function getOrRegisterDevice() {
  const existing = await getDevice();
  if (existing) return existing;
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(`${API_BASE}/v1/devices/register`, { method: "POST" });
    if (!res.ok) return null;
    const { deviceId, deviceKey } = await res.json();
    if (deviceId && deviceKey) {
      await chrome.storage.local.set({ deviceId, deviceKey });
      return { deviceId, deviceKey };
    }
  } catch (_) {}
  return null;
}

async function refreshConfig() {
  if (typeof fetch !== "function") return;
  try {
    const res = await fetch(`${API_BASE}/v1/config`);
    if (!res.ok) return;
    const data = await res.json();
    const patch = {};
    if (typeof data.serving === "boolean") patch.serving = data.serving;
    if (typeof data.houseAdEnabled === "boolean") patch.houseAdEnabled = data.houseAdEnabled;
    if (typeof data.revenueShare === "number") patch.revenueShare = data.revenueShare;
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  } catch (_) {}
}

async function refreshAds() {
  if (typeof fetch !== "function") return;
  try {
    const res = await fetch(`${API_BASE}/v1/ads`);
    if (!res.ok) return;
    const data = await res.json();
    const ads = Array.isArray(data.ads) ? data.ads.map(decorateAd) : [];
    const patch = { liveAds: ads, adsFetchedAt: Date.now() };
    if (typeof data.revenueShare === "number") patch.revenueShare = data.revenueShare;
    await chrome.storage.local.set(patch);
  } catch (_) {}
}

// Server-authoritative impressions. Instead of self-reporting a count to
// /v1/events (which the server has to take on trust), each qualifying 2s view is
// billed through a single-use token the server issues. Pipelined so the 2s
// on-screen dwell sits BETWEEN serve and redeem: on each impression tick we
// redeem the previously-served token (now ≥ dwell old) and serve the next one. A
// token that never ripens (generation stopped, tab hidden) is simply dropped —
// no bill, which is exactly right for a view that didn't complete.
const IMP_DWELL_MS = 2000;
let impBusy = false;
async function serveImpressionToken(device) {
  try {
    const res = await fetch(`${API_BASE}/v1/impressions/serve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, deviceKey: device.deviceKey }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null; // null when capped / killswitch off / no ad
  } catch (_) {
    return null;
  }
}
async function redeemImpressionToken(device, token) {
  try {
    // source tags the credit so the portal's Install tab lights up the chrome
    // surface. A dropped/failed redeem just means one view goes unbilled.
    await fetch(`${API_BASE}/v1/impressions/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, deviceKey: device.deviceKey, token, source: "chrome" }),
    });
  } catch (_) {}
}
// Called once per real impression tick (≈ every 2s of continuous visibility).
// The impBusy guard is claimed before the first await so two ticks can't both
// redeem the same token or serve two at once.
async function tickImpressionToken() {
  if (typeof fetch !== "function" || impBusy) return;
  impBusy = true;
  try {
    const device = await getOrRegisterDevice();
    if (!device) return;
    // Register the device regardless (so it exists and can be linked from the
    // website later), but bill nothing until it's linked to an account: skip the
    // serve→redeem while anonymous so no credit lands on a device the account-
    // scoped web portal can't attribute to a user.
    if (!(await isDeviceLinked())) return;
    const { impToken } = await chrome.storage.local.get(["impToken"]);
    // Redeem the previously-served token once its 2s dwell has elapsed. Gating on
    // the client side (not just the server min-dwell) keeps an honest redeem from
    // ever tripping "too_soon" under tick jitter.
    if (impToken && impToken.token && Date.now() - impToken.at >= IMP_DWELL_MS) {
      await redeemImpressionToken(device, impToken.token);
      await chrome.storage.local.set({ impToken: null });
    }
    // Ensure exactly one token is in flight for the next window.
    const { impToken: cur } = await chrome.storage.local.get(["impToken"]);
    if (!cur || !cur.token) {
      const token = await serveImpressionToken(device);
      if (token) await chrome.storage.local.set({ impToken: { token, at: Date.now() } });
    }
  } finally {
    impBusy = false;
  }
}

// Forgery-proof click: ask the server for a single-use token tied to this
// device + campaign, then redeem it so the click is recorded server-side. The
// user's own navigation stays the synchronous window.open in the content script.
async function reportClick(campaignId) {
  if (typeof fetch !== "function" || !campaignId) return;
  const device = await getOrRegisterDevice();
  if (!device) return;
  try {
    const res = await fetch(`${API_BASE}/v1/clicks/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, deviceKey: device.deviceKey, campaignId }),
    });
    if (!res.ok) return;
    // The POST above already records the click server-side. If the server also
    // returns a tracking pixel, fire it ONLY when it's first-party — the
    // extension must never request a host it didn't declare in host_permissions.
    // Any advertiser-side pixel is fired by the server during the
    // dwellprotocol.com/go/* click redirect instead.
    const { trackingUrl } = await res.json();
    if (trackingUrl && isFirstPartyUrl(trackingUrl)) {
      try { await fetch(trackingUrl, { redirect: "manual" }); } catch (_) {}
    }
  } catch (_) {}
}

// True only for the hosts the extension actually declares in host_permissions
// (dwellprotocol.com and the Supabase backend), so the service worker never reaches out
// to an undeclared origin. Anything else (e.g. an advertiser's pixel) is left to
// the server to fire during the dwellprotocol.com/go/* click redirect.
function isFirstPartyUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === "dwellprotocol.com" || h === "www.dwellprotocol.com" || h.endsWith(".supabase.co");
  } catch (_) {
    return false;
  }
}

// Reconcile the local optimistic earnings counter with the server's
// authoritative ledger. The popup must never show credits the server doesn't
// owe (the old bundled-ad fallback ticked earnings no campaign ever funded);
// the local counter stays for snappy between-sync feedback, but the ledger
// wins on every refresh.
async function refreshEarnings() {
  if (typeof fetch !== "function") return;
  const device = await getDevice();
  if (!device) return;
  try {
    // Device creds go in headers, never the query string (see getCrew).
    const res = await fetch(`${API_BASE}/v1/me/earnings`, {
      headers: { "x-device-id": device.deviceId, "x-device-key": device.deviceKey },
    });
    if (!res.ok) return;
    const data = await res.json();
    // balanceUsd is the SPENDABLE number: credits minus redemptions/payouts,
    // including admin adjustments — the honest figure for the popup's
    // progress-toward-a-free-month ring.
    if (typeof data.balanceUsd === "number") {
      await chrome.storage.local.set({ earnings: data.balanceUsd });
    }
  } catch (_) {}
}

async function refreshAll() {
  await getOrRegisterDevice();
  await refreshConfig();
  await refreshAds();
  await refreshEarnings();
}

// ---------- crew (affiliate) ----------
// The popup's "earn with your friends" panel. The extension stays anonymous; the
// device links to a user via the magic link from /v1/auth/request-link. Once
// linked, the user is auto-enrolled as an approved affiliate, and the
// device-scoped /v1/me/affiliate returns the invite link + per-friend 10%
// breakdown — no web session, just device credentials. While unlinked it returns
// { linked:false } and the popup shows the sign-in CTA.
async function getCrew() {
  const device = await getDevice();
  if (!device || typeof fetch !== "function") return { linked: false, friends: [] };
  try {
    // Device creds go in headers, never the query string: a deviceKey in a URL
    // leaks into edge/proxy access logs and error pipelines. The backend accepts
    // x-device-id / x-device-key for this route.
    const res = await fetch(`${API_BASE}/v1/me/affiliate`, {
      headers: { "x-device-id": device.deviceId, "x-device-key": device.deviceKey },
    });
    if (!res.ok) return { linked: false, friends: [] };
    const data = await res.json();
    // Cache the last good crew so the popup paints instantly on open instead of
    // flashing the sign-in CTA / an empty list while the fetch is in flight.
    try { await chrome.storage.local.set({ crewCache: data }); } catch (_) {}
    return data;
  } catch (_) {
    // Offline / transient failure: serve the last known crew if we have one.
    try {
      const { crewCache } = await chrome.storage.local.get(["crewCache"]);
      if (crewCache) return crewCache;
    } catch (_) {}
    return { linked: false, friends: [] };
  }
}

// Earning is gated on the device being linked to a dwellprotocol.com account (see
// recordImpression / tickImpressionToken). An anonymous device must never accrue
// credits: the web portal is account-scoped, so device-only earnings can never
// show up there — the exact mismatch where the popup reads e.g. $0.20 but the
// portal reads $0. Cached briefly so a burst of impression ticks doesn't hammer
// /v1/me/affiliate; getCrew falls back to its own cache on a transient error, so
// an already-linked device stays "linked" through a blip rather than flapping.
// Only positive results are cached: while anonymous we re-check every call so
// earning begins the instant the user connects their account (no up-to-TTL lag).
let linkState = { linked: false, at: 0 };
const LINK_TTL_MS = 60 * 1000;
async function isDeviceLinked() {
  if (linkState.linked && Date.now() - linkState.at < LINK_TTL_MS) return true;
  const crew = await getCrew();
  linkState = { linked: !!(crew && crew.linked === true), at: Date.now() };
  return linkState.linked;
}

// Invite a friend to the crew from the popup. Device-scoped: the backend reads
// the linked user from the device credentials and sends an invite carrying the
// user's affiliate link, so the friend is attributed to them (10% forever). Only
// works once the device is linked to an account.
async function inviteFriend(email) {
  if (!email || typeof fetch !== "function") return { ok: false, error: "no email" };
  const device = await getDevice();
  if (!device) return { ok: false, error: "sign in to invite friends" };
  try {
    const res = await fetch(`${API_BASE}/v1/me/affiliate/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, deviceKey: device.deviceKey, email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || "could not send invite" };
    return { ok: true, invite: data.invite };
  } catch (_) {
    return { ok: false, error: "network error" };
  }
}

// Link this device to the dwellprotocol.com account whose web session the link bridge
// (src/link.js) found in the site's localStorage. Authed by device creds + that
// web session; the server sets devices.user_id and auto-enrolls the affiliate.
// We remember the last session we linked so we don't re-POST on every poll tick;
// the server call is idempotent regardless (service-worker eviction is fine).
let lastLinkedSession = null;
async function linkDevice(session) {
  if (!session || typeof fetch !== "function") return { ok: false };
  if (session === lastLinkedSession) return { ok: true, already: true };
  const device = await getOrRegisterDevice();
  if (!device) return { ok: false, error: "no device" };
  try {
    const res = await fetch(`${API_BASE}/v1/devices/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId, deviceKey: device.deviceKey, session }),
    });
    if (!res.ok) return { ok: false };
    lastLinkedSession = session;
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const has = await chrome.storage.local.get("installedAt");
  if (!has.installedAt) {
    await chrome.storage.local.set({ ...DEFAULTS });
  }
  refreshAll();
});

// Service workers get evicted, so periodic work runs off alarms (when available).
if (chrome.alarms) {
  chrome.alarms.create("dwell-refresh", { periodInMinutes: 10 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "dwell-refresh") refreshAll();
  });
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => refreshAll());

// Storage keys BB_SET is permitted to write — the popup's user-facing toggles
// only. Everything else (deviceId/deviceKey, earnings, impToken, serving,
// grossCpm, caches) is off-limits, so a message can't rewrite the credit-minting
// counters or corrupt the device identity.
const BB_SET_ALLOWED_KEYS = new Set(["enabled", "testMode", "blockedCategories"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Defense-in-depth: only accept messages from our own extension surfaces.
    // (No externally_connectable is declared, so nothing else can reach here
    // today; this keeps it that way if that ever changes.)
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false });
      return;
    }
    switch (msg.type) {
      case "BB_GET_STATE":
        sendResponse(await getState());
        break;
      case "BB_GET_CREW":
        sendResponse(await getCrew());
        break;
      case "BB_LINK":
        sendResponse(await linkDevice((msg.session || "").trim()));
        break;
      case "BB_INVITE":
        sendResponse(await inviteFriend(String(msg.email || "").trim()));
        break;
      case "BB_GET_ADS": {
        const s = await getState();
        const blocked = (s.blockedCategories || []).map((c) => String(c).toLowerCase());
        // Real mode serves ONLY live, funded inventory from the auction. The
        // bundled BB_ADS list is demo content (popup board, Test Mode): showing
        // it as a real ad would tick the earnings counter for money no
        // advertiser ever paid — a promise the server can never honour. When
        // the auction is empty, no ad shows and nothing earns.
        const { liveAds } = await chrome.storage.local.get(["liveAds"]);
        const source = Array.isArray(liveAds) ? liveAds : [];
        sendResponse(source.filter((a) => !blocked.includes(a.cat)));
        break;
      }
      case "BB_IMPRESSION": {
        const s = await recordImpression(!!msg.mock);
        sendResponse(s);
        if (!msg.mock) tickImpressionToken();
        break;
      }
      case "BB_VIEW": {
        sendResponse(await recordView(!!msg.mock));
        break;
      }
      case "BB_CLICK": {
        const s = await recordClick(!!msg.mock);
        sendResponse(s);
        if (!msg.mock) reportClick(msg.campaignId);
        break;
      }
      case "BB_SET": {
        const payload = msg.payload || {};
        const filtered = {};
        for (const k of Object.keys(payload)) {
          if (BB_SET_ALLOWED_KEYS.has(k)) filtered[k] = payload[k];
        }
        await chrome.storage.local.set(filtered);
        sendResponse(await getState());
        break;
      }
      case "BB_RESET":
        await chrome.storage.local.set({ impressions: 0, clicks: 0, earnings: 0, adViews: 0, testImpressions: 0, testClicks: 0, testAdViews: 0, impToken: null });
        sendResponse(await getState());
        break;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // async response
});
