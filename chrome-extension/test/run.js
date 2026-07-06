// DWELL.fyi — Chrome extension verification harness.
// Loads the REAL content.js and background.js against a hand-rolled minimal DOM
// + chrome API mock, so the whole loop can be checked headlessly:
//   detection on ChatGPT / Claude / Gemini · Test Mode shows the mock ad ·
//   mock events never touch real earnings · the 50% math.
//
// Usage: node test/run.js   (or: npm test)

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const check = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log("  ✓ " + name); });

// ---------- a tiny DOM ----------
// Only as much as content.js touches. "Page" elements (for the detector) are
// registered via page.add(); the injected bar resolves its own child spans from
// the class names in the innerHTML string it's given.
function makeChild() {
  return { textContent: "", style: {} };
}
function parseChildren(html) {
  const map = {};
  const re = /class="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const cls = m[1].split(/\s+/)[0];
    map[cls] = makeChild();
  }
  return map;
}
function makeEl(tag) {
  let html = "";
  let kids = {};
  const set = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    _attrs: {},
    style: {},
    isConnected: false,
    _click: null,
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    appendChild(child) { child.isConnected = true; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(ev, fn) { if (ev === "click") this._click = fn; },
    set innerHTML(v) { html = v; kids = parseChildren(v); },
    get innerHTML() { return html; },
    querySelector(sel) { return kids[sel.replace(/^\./, "")] || null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; },
  };
}

// page-level element registry + a minimal attribute/class selector matcher
const page = {
  els: [],
  add(tag, attrs = {}, classes = []) { this.els.push({ tag, attrs, classes }); return this; },
  clear() { this.els = []; return this; },
};
function matchOne(el, sel) {
  // tag prefix
  let rest = sel;
  const tagMatch = rest.match(/^([a-zA-Z]+)/);
  if (tagMatch) {
    if (el.tag.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }
  // .class
  const cls = rest.match(/^\.([\w-]+)$/);
  if (cls) return el.classes.includes(cls[1]);
  // [attr], [attr="v"], [attr*="v" i]
  const attr = rest.match(/^\[([\w-]+)(?:([*]?)=(['"])(.*?)\3(\s+i)?)?\]$/);
  if (attr) {
    const [, name, star, , val, ci] = attr;
    if (val === undefined) return name in el.attrs;
    const have = el.attrs[name];
    if (have === undefined) return false;
    if (star === "*") {
      return ci ? have.toLowerCase().includes(val.toLowerCase()) : have.includes(val);
    }
    return ci ? have.toLowerCase() === val.toLowerCase() : have === val;
  }
  return false;
}
const documentMock = {
  body: { appendChild: (child) => { child.isConnected = true; } },
  createElement: (tag) => makeEl(tag),
  querySelector: (sel) => (page.els.find((e) => matchOne(e, sel)) ? makeEl("x") : null),
  querySelectorAll: (sel) => page.els.filter((e) => matchOne(e, sel)).map(() => makeEl("button")),
};

// ---------- chrome mock ----------
function makeChrome(stateRef, sentRef) {
  return {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => { sentRef.push(msg); cb && cb(stateRef.response(msg)); },
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {},
  };
}

(async () => {
  console.log("dwell chrome-extension verification\n");

  // ---------- load ads.js into a shared global scope ----------
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.window = {};
  sandbox.document = documentMock;
  sandbox.setInterval = () => 0; // detector/loop driven manually in tests
  sandbox.clearInterval = () => {};
  sandbox.setTimeout = () => 0;
  sandbox.URL = URL; // content scripts expose URL globally; the https guard uses it
  const opened = [];
  sandbox.window.open = (url) => opened.push(url);

  const sent = [];
  const stateRef = {
    state: { enabled: true, testMode: false },
    response(msg) {
      if (msg.type === "BB_GET_STATE") return { ...this.state, mockAd: sandbox.BB_MOCK_AD };
      if (msg.type === "BB_GET_ADS") return sandbox.BB_ADS;
      return { ok: true };
    },
  };
  sandbox.chrome = makeChrome(stateRef, sent);

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("src/ads.js"), ctx);
  vm.runInContext(read("src/content.js"), ctx);

  const T = sandbox.window.__dwellTest;

  await check("content script loads and injects the bar", () => {
    assert.ok(T, "test hook missing");
    assert.ok(T.bar, "bar not created");
  });

  await check("no generation signal ⇒ not thinking", () => {
    page.clear();
    T.setState({ enabled: true, testMode: false, ads: sandbox.BB_ADS });
    assert.strictEqual(T.isThinking(), false);
  });

  await check("detects ChatGPT stop button", () => {
    page.clear().add("button", { "data-testid": "stop-button" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("detects Claude stop button", () => {
    page.clear().add("button", { "aria-label": "Stop response" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("detects Gemini stop button (aria-label contains 'stop')", () => {
    page.clear().add("button", { "aria-label": "Stop generating response" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("detects a generic aria-busy region", () => {
    page.clear().add("div", { "aria-busy": "true" });
    assert.strictEqual(T.isThinking(), true);
  });

  await check("a sidebar title containing 'stop' does NOT count as thinking", () => {
    // ChatGPT regression: a conversation titled "6 Train Not Stopping" rendered
    // a visible button whose aria-label contained "stop", pinning the bar on.
    page.clear().add("button", { "aria-label": "Open conversation options for 6 Train Not Stopping" });
    assert.strictEqual(T.isThinking(), false, "matched a non-generation control");
  });

  await check("Test Mode without generation ⇒ bar stays hidden", () => {
    page.clear(); // nothing generating
    T.setState({ enabled: true, testMode: true, ads: sandbox.BB_ADS, mockAd: sandbox.BB_MOCK_AD });
    assert.strictEqual(T.isThinking(), false, "ad must only show while the model is thinking");
  });

  await check("Test Mode while generating ⇒ swaps in the mock ad", () => {
    page.add("button", { "data-testid": "stop-button" }); // model is thinking
    page.add("div", { "data-message-author-role": "assistant" }); // the reply area to anchor to
    assert.strictEqual(T.isThinking(), true, "mock ad should show while generating");
    const ad = T.currentAd();
    assert.ok(ad && ad.mock === true, "current ad is not the mock");
    assert.ok(/test/i.test(ad.line), "mock ad line should say 'test'");
  });

  await check("Test Mode renders the bar and tags it as a test", () => {
    T.evaluate();
    assert.ok(T.isActive(), "bar not active");
    assert.ok(T.bar.classList.contains("bb-show"), "bar not shown");
    assert.ok(T.bar.classList.contains("bb-test"), "bar not marked bb-test");
  });

  await check("a test-mode impression is tagged mock:true", () => {
    sent.length = 0;
    T.tick();
    const imp = sent.find((m) => m.type === "BB_IMPRESSION");
    assert.ok(imp, "no impression sent");
    assert.strictEqual(imp.mock, true, "test impression not tagged mock");
  });

  await check("only one ad is surfaced — the top of inventory, never rotating", () => {
    page.clear()
      .add("button", { "data-testid": "stop-button" })
      .add("div", { "data-message-author-role": "assistant" });
    const inventory = [
      { id: "ramp", chip: "R", line: "Ramp" },
      { id: "fluidstack", chip: "F", line: "FluidStack" },
      { id: "linear", chip: "L", line: "Linear" },
    ];
    T.setState({ enabled: true, testMode: false, ads: inventory });
    T.evaluate();
    assert.strictEqual(T.currentAd().id, "ramp", "not pinned to the top ad");
    for (let i = 0; i < 300; i++) T.tick(); // far past the old 2.6s rotation cadence
    assert.strictEqual(T.currentAd().id, "ramp", "the ad rotated — should stay put");
  });

  await check("clicking the bar opens the ad URL synchronously (popup blockers)", () => {
    // The sendMessage callback deliberately never fires — the SW may be asleep.
    // window.open must NOT wait on the round-trip, or the user-activation is
    // gone and popup blockers eat the navigation.
    const orig = sandbox.chrome.runtime.sendMessage;
    sandbox.chrome.runtime.sendMessage = () => {};
    try {
      T.setState({ enabled: true, testMode: false, ads: [{ id: "x", chip: "X", line: "X ad", url: "https://dwell-protocol.vercel.app/go/x" }] });
      opened.length = 0;
      T.bar._click();
      assert.deepStrictEqual(opened, ["https://dwell-protocol.vercel.app/go/x"], "ad did not open synchronously");
    } finally {
      sandbox.chrome.runtime.sendMessage = orig;
    }
  });

  await check("hidden tab ⇒ bar stops serving (no billing for unseen ads)", () => {
    page.clear()
      .add("button", { "data-testid": "stop-button" })
      .add("div", { "data-message-author-role": "assistant" });
    T.setState({ enabled: true, testMode: false, ads: sandbox.BB_ADS });
    documentMock.hidden = true;
    T.evaluate();
    assert.strictEqual(T.isActive(), false, "served an ad in a hidden tab");
    documentMock.hidden = false;
    T.evaluate();
    assert.strictEqual(T.isActive(), true, "did not resume when the tab became visible");
  });

  // ---------- background.js earnings vs mock ----------
  const bg = {};
  bg.self = bg;
  bg.importScripts = () => {}; // ads.js already provided below
  bg.BB_ADS = sandbox.BB_ADS;
  bg.BB_MOCK_AD = sandbox.BB_MOCK_AD;
  const store = {};
  bg.crypto = require("node:crypto"); // randomUUID for event batch keys
  bg.URL = URL; // service workers expose URL globally; the host guard uses it
  const alarmListeners = [];
  const fireAlarm = async (name) => { for (const fn of alarmListeners) await fn({ name }); };
  bg.chrome = {
    runtime: { onInstalled: { addListener: () => {} }, onMessage: { addListener: (fn) => { bg._onMessage = fn; } } },
    alarms: { create: () => {}, onAlarm: { addListener: (fn) => alarmListeners.push(fn) } },
    storage: { local: {
      get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
      set: async (obj) => { Object.assign(store, obj); },
    } },
  };
  // Fake prod backend — records every call so the wiring can be asserted.
  const fetches = [];
  // Whether the device is linked to an account. Earning is gated on this: an
  // anonymous device counts impressions but accrues nothing until it links.
  let affiliateLinked = false;
  bg.fetch = async (url, options = {}) => {
    const u = String(url);
    fetches.push({ url: u, options });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.endsWith("/v1/devices/register")) return ok({ deviceId: "dev-1", deviceKey: "key-1" });
    if (u.endsWith("/v1/me/affiliate")) return ok({ linked: affiliateLinked, email: "me@example.com", crewSize: 10, rewardPct: 10, friends: [], invited: [] });
    if (u.endsWith("/v1/config")) return ok({ serving: true, revenueShare: 0.5 });
    if (u.endsWith("/v1/ads")) return ok({ revenueShare: 0.5, ads: [] });
    // earned > balance so the reconciliation test proves the SPENDABLE number wins
    if (u.endsWith("/v1/me/earnings")) return ok({ revenueShare: 0.5, earnedUsd: 0.25, paidOutUsd: 0, redeemedUsd: 0.2, balanceUsd: 0.05 });
    if (u.endsWith("/v1/events")) return ok({ ok: true, creditedMillicents: 0 });
    // Server-authoritative impressions: serve mints a single-use token, redeem bills it.
    if (u.endsWith("/v1/impressions/serve")) return ok({ token: "served-tok", revenueShare: 0.5, ad: { id: "c1", brand: "Acme", line: "Acme — live ad", url: "https://acme.example", cat: "devtools" } });
    if (u.endsWith("/v1/impressions/redeem")) return ok({ ok: true, creditedMillicents: 6 });
    // Return an UNDECLARED third-party tracking host; the SW must refuse to fetch it.
    if (u.endsWith("/v1/clicks/intent")) return ok({ trackingUrl: "https://tracker.example.com/go/tok123" });
    if (u.includes("/v1/go/") || u.includes("tracker.example.com")) return ok({});
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const bgCtx = vm.createContext(bg);
  vm.runInContext(read("src/background.js"), bgCtx);
  const msg = (m) => new Promise((res) => bg._onMessage(m, {}, res));
  // Drain the fire-and-forget network side effects (register/flush/click report).
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1)); };

  await check("unlinked device counts the impression but earns nothing (connect to start earning)", async () => {
    const s = await msg({ type: "BB_IMPRESSION", mock: false });
    assert.strictEqual(s.impressions, 1);
    assert.strictEqual(s.earnings, 0, "an unlinked device must not accrue earnings");
  });

  await check("once linked, a real impression earns 50% of the per-impression gross", async () => {
    affiliateLinked = true;
    await settle(); // let the prior tick register the device so the link check can resolve
    const before = (await msg({ type: "BB_GET_STATE" })).earnings;
    const s = await msg({ type: "BB_IMPRESSION", mock: false });
    assert.strictEqual(s.impressions, 2);
    assert.ok(Math.abs(s.earnings - (before + (12 / 1000) * 0.5)) < 1e-9, "earnings != 50% share");
  });

  await check("real click is recorded but pays nothing (50x billing removed)", async () => {
    const before = (await msg({ type: "BB_GET_STATE" })).earnings;
    const s = await msg({ type: "BB_CLICK", mock: false });
    assert.strictEqual(s.clicks, 1);
    assert.ok(Math.abs(s.earnings - before) < 1e-9, "a click must not change earnings");
  });

  await check("mock impression/click never touch real earnings", async () => {
    const before = await msg({ type: "BB_GET_STATE" });
    await msg({ type: "BB_IMPRESSION", mock: true });
    await msg({ type: "BB_CLICK", mock: true });
    const after = await msg({ type: "BB_GET_STATE" });
    assert.strictEqual(after.earnings, before.earnings, "mock event changed real earnings");
    assert.strictEqual(after.impressions, before.impressions, "mock changed real impressions");
    assert.strictEqual(after.testImpressions, 1, "test impression not counted");
    assert.strictEqual(after.testClicks, 1, "test click not counted");
  });

  await check("BB_VIEW counts one ad watched, independent of billing impressions", async () => {
    const before = await msg({ type: "BB_GET_STATE" });
    // Two 2s billing ticks for the SAME on-screen ad, but only one ad watched.
    await msg({ type: "BB_IMPRESSION", mock: false });
    await msg({ type: "BB_IMPRESSION", mock: false });
    const s = await msg({ type: "BB_VIEW", mock: false });
    assert.strictEqual(s.adViews, before.adViews + 1, "ad view not counted");
    assert.strictEqual(s.impressions, before.impressions + 2, "views must not touch impressions");
  });

  await check("a mock ad view ticks the test counter, never real ads watched", async () => {
    const before = await msg({ type: "BB_GET_STATE" });
    const s = await msg({ type: "BB_VIEW", mock: true });
    assert.strictEqual(s.adViews, before.adViews, "mock view changed real ads watched");
    assert.strictEqual(s.testAdViews, before.testAdViews + 1, "mock view not counted");
  });

  await check("reset zeroes both real and test counters", async () => {
    const s = await msg({ type: "BB_RESET" });
    assert.strictEqual(s.impressions, 0);
    assert.strictEqual(s.earnings, 0);
    assert.strictEqual(s.adViews, 0);
    assert.strictEqual(s.testImpressions, 0);
    assert.strictEqual(s.testClicks, 0);
    assert.strictEqual(s.testAdViews, 0);
  });

  // ---------- prod backend wiring ----------
  await settle(); // let earlier fire-and-forget flushes finish

  await check("a real impression registers a device and is persisted", async () => {
    assert.ok(store.deviceId && store.deviceKey, "device credentials not persisted");
    assert.ok(fetches.some((f) => f.url.endsWith("/v1/devices/register")), "never registered a device");
  });

  await check("BB_GET_ADS prefers cached live inventory over the bundled list", async () => {
    store.liveAds = [
      { id: "c1", brand: "Acme", chip: "A", color: "#111", ink: "#fff", line: "Acme — live ad", url: "https://acme.example", cat: "devtools" },
    ];
    const ads = await msg({ type: "BB_GET_ADS" });
    assert.ok(Array.isArray(ads) && ads.length === 1, "did not return the live list");
    assert.strictEqual(ads[0].line, "Acme — live ad");
  });

  await check("an empty auction serves NOTHING — the bundled demo list never becomes a real ad", async () => {
    // Bundled ads have no campaign behind them; serving one would tick the
    // earnings counter for money no advertiser ever paid.
    const noAds = async (why) => {
      const ads = await msg({ type: "BB_GET_ADS" });
      assert.ok(Array.isArray(ads) && ads.length === 0, why);
    };
    store.liveAds = [];
    await noAds("served ads from an empty auction");
    delete store.liveAds; // before the first fetch: same story
    await noAds("served bundled ads before any auction fetch");
  });

  await check("refresh reconciles the earnings counter to the server ledger (phantom local credits are corrected)", async () => {
    store.earnings = 0.14; // a stale optimistic tally the server never credited
    await fireAlarm("dwell-refresh");
    await settle();
    const earnings = fetches.find((f) => f.url.endsWith("/v1/me/earnings"));
    assert.ok(earnings, "refresh never asked the server for the real balance");
    assert.strictEqual(earnings.options.headers["x-device-key"], "key-1", "device key not sent via header");
    assert.strictEqual(store.earnings, 0.05, "local earnings not reconciled to the server's number");
  });

  await check("a real impression serves an impression token (server-authoritative, no self-reported batch)", async () => {
    store.impToken = null;
    fetches.length = 0;
    await msg({ type: "BB_IMPRESSION", mock: false });
    await settle();
    const serve = fetches.find((f) => f.url.endsWith("/v1/impressions/serve"));
    assert.ok(serve, "no /v1/impressions/serve POST");
    assert.strictEqual(JSON.parse(serve.options.body).deviceId, "dev-1", "serve not authed with the device");
    // the credit-minting path must NOT self-report a count to /v1/events anymore
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/events")), "must not post a self-reported /v1/events batch");
    // the served token is persisted so it can be redeemed after the dwell
    assert.ok(store.impToken && store.impToken.token === "served-tok", "served token not persisted for redemption");
  });

  await check("the served token is redeemed once its 5s dwell elapses (one bill per completed view)", async () => {
    // simulate the previously-served token having dwelled ≥ 5s on screen
    store.impToken = { token: "ripe-tok", at: Date.now() - 6000 };
    fetches.length = 0;
    await msg({ type: "BB_IMPRESSION", mock: false });
    await settle();
    const redeem = fetches.find((f) => f.url.endsWith("/v1/impressions/redeem"));
    assert.ok(redeem, "no /v1/impressions/redeem POST");
    const body = JSON.parse(redeem.options.body);
    assert.strictEqual(body.token, "ripe-tok", "redeemed the wrong token");
    assert.strictEqual(body.deviceId, "dev-1", "redeem not authed with the device");
    assert.strictEqual(body.source, "chrome", "credit not tagged with the chrome surface");
    // and a fresh token is served for the next window
    assert.ok(fetches.some((f) => f.url.endsWith("/v1/impressions/serve")), "did not serve the next token");
  });

  await check("a not-yet-ripe token is neither redeemed nor double-served (no too_soon, no double bill)", async () => {
    store.impToken = { token: "fresh-tok", at: Date.now() }; // served just now
    fetches.length = 0;
    await msg({ type: "BB_IMPRESSION", mock: false });
    await settle();
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/impressions/redeem")), "redeemed before the dwell elapsed");
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/impressions/serve")), "served a second token while one is in flight");
    assert.strictEqual(store.impToken.token, "fresh-tok", "in-flight token was disturbed");
  });

  await check("mock impressions and clicks never reach the network", async () => {
    fetches.length = 0;
    await msg({ type: "BB_IMPRESSION", mock: true });
    await msg({ type: "BB_CLICK", mock: true });
    await settle();
    assert.ok(!fetches.some((f) => f.url.includes("/v1/impressions/")), "mock impression hit the token endpoints");
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/events")), "mock impression hit the ledger");
    assert.ok(!fetches.some((f) => f.url.endsWith("/v1/clicks/intent")), "mock click requested a token");
  });

  await check("a live-ad click records via a first-party token and never fetches an undeclared host", async () => {
    fetches.length = 0;
    await msg({ type: "BB_CLICK", mock: false, campaignId: "c1" });
    await settle();
    const intent = fetches.find((f) => f.url.endsWith("/v1/clicks/intent"));
    assert.ok(intent, "no /v1/clicks/intent POST"); // click recorded on our own backend
    assert.strictEqual(JSON.parse(intent.options.body).campaignId, "c1");
    // the server returned a third-party trackingUrl; the SW must NOT request it
    // (only declared hosts — dwell-protocol.vercel.app / *.supabase.co — may be fetched).
    assert.ok(!fetches.some((f) => f.url.includes("tracker.example.com")), "fetched an UNDECLARED tracking host");
  });

  console.log(`\nall ${pass} checks passed — detection, test mode, the 50% split, and prod wiring verified.`);
})().catch((err) => {
  console.error("\n✗ FAILED:", err.stack || err.message);
  process.exit(1);
});
