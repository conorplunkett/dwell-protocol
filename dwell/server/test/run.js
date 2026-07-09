// DWELL API — end-to-end verification.
// Boots the REAL app + repository against a REAL Postgres (DATABASE_URL), with
// only Stripe + mail transports faked, and drives the full hardened flow:
//   checkout -> webhook (deduped) -> moderation -> auction -> 90% ledger ->
//   server-side clicks -> email-gated Connect onboarding -> payouts; plus XSS
//   escaping, rate limiting, body caps, and CORS.
//
// Usage: DATABASE_URL=postgres://... node test/run.js   (or: npm test)

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../src/app");
const { createRepo } = require("../src/repo");
const { createStripe, signWebhookPayload } = require("../src/stripe");
const { createRateLimiter } = require("../src/ratelimit");

const WEBHOOK_SECRET = "whsec_test_secret";

// ---------- fake Stripe transport ----------
const stripeCalls = [];
const fakeFetch = async (url, opts) => {
  const p = new URL(url).pathname;
  const params = Object.fromEntries(new URLSearchParams(opts.body || ""));
  stripeCalls.push({ path: p, params });
  const id =
    p === "/v1/checkout/sessions" ? "cs_test_" + crypto.randomBytes(6).toString("hex")
    : p === "/v1/accounts" ? "acct_test_" + crypto.randomBytes(6).toString("hex")
    : p === "/v1/transfers" ? "tr_test_" + crypto.randomBytes(6).toString("hex")
    : p === "/v1/refunds" ? "re_test_" + crypto.randomBytes(6).toString("hex")
    : "obj_test";
  const body =
    p === "/v1/checkout/sessions" ? { id, url: `https://checkout.stripe.com/c/pay/${id}` }
    : p === "/v1/account_links" ? { url: "https://connect.stripe.com/setup/e/test" }
    : { id };
  return { ok: true, status: 200, json: async () => body };
};

// ---------- fake mailer ----------
const mailbox = [];
const fakeMailer = {
  sendVerifyEmail: async (to, link) => { mailbox.push({ to, link }); },
  sendWebLoginEmail: async (to, link) => { mailbox.push({ to, link }); },
  sendAdvertiserReceiptEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendCampaignRejectedEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  buildCampaignCompletedEmail: (s) => ({ subject: "Your DWELL campaign wrapped up — the final numbers", html: `<p>shown ${s.impressionsShown} clicks ${s.clicks} spent ${s.totalPaidUsd}</p>` }),
  sendCampaignCompletedEmail: async (to, stats) => { mailbox.push({ to, kind: "campaign_completed", ...stats }); },
  sendGiftRedemptionEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendReferralInviteEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendCrewInviteEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendRedemptionConfirmationEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendReferralRewardEmail: async (to, details) => { mailbox.push({ to, ...details }); },
  sendWaitlistConfirmationEmail: async (to) => { mailbox.push({ to, kind: "waitlist" }); },
};

// ---------- stub the X (Twitter) API used by onboarding-post verification ----------
// The app calls the global fetch for api.twitter.com; the api() helper's calls to
// the local server pass straight through to the real fetch. twitterTweets is the
// controllable "timeline" a verification read sees.
let twitterTweets = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (/api\.twitter\.com\/2\/users\/.+\/tweets/.test(String(url))) {
    return { ok: true, status: 200, json: async () => ({ data: twitterTweets }) };
  }
  return realFetch(url, opts);
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required — e.g. docker compose up -d db");
    process.exit(1);
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ns = "bbtest_" + crypto.randomBytes(4).toString("hex");
  await pool.query(`create schema ${ns}`);
  // search_path set at connection startup so every pooled connection lands in ns
  const poolNs = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${ns}` });
  await poolNs.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));

  const config = {
    revenueShare: 0.9, dailyImpressionCap: 5000, ipDailyImpressionCap: 0, dailyClickCap: 5, payoutThresholdCents: 1000,
    payoutFeeBps: 1000, redemptionFeeBps: 1000, // the protocol's 10% cut on cash payouts and gift redemptions
    referralRewardCents: 2000, referralCap: 10,
    affiliateRewardBps: 1000, affiliateCapPeople: 1000,
    stripeWebhookSecret: WEBHOOK_SECRET, siteUrl: "https://dwellprotocol.com",
    apiBaseUrl: "", corsOrigin: "https://dwellprotocol.com", adminKey: "test-admin",
    emailTokenTtlMs: 1800000, emailCooldownMs: 0, emailIpDailyCap: 0, webSessionTtlMs: 2592000000, clickTokenTtlMs: 120000, maxBodyBytes: 65536,
    impressionTokenTtlMs: 120000, impressionMinDwellMs: 0, // dwell off for the main suite; a dedicated test exercises it
    logRequests: false, giftFulfillmentEmail: "hello@dwellprotocol.com",
    twitterBearerToken: "test-bearer",
  };
  const repo = createRepo(poolNs);
  const stripe = createStripe("sk_test_fake", { fetchImpl: fakeFetch });
  const bigLimiter = createRateLimiter({ capacity: 100000, refillPerSec: 100000 });
  const { server } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.apiBaseUrl = base; // handlers read config at request time

  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };

  let pass = 0;
  const check = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log("  ✓ " + name); });

  const payWebhook = async (campaignId, paymentIntent = "pi_test_" + crypto.randomBytes(4).toString("hex"), eventId = "evt_" + crypto.randomBytes(6).toString("hex")) => {
    const payload = JSON.stringify({
      id: eventId, type: "checkout.session.completed",
      data: { object: { metadata: { campaign_id: campaignId }, payment_intent: paymentIntent } },
    });
    return api("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET) });
  };
  const approve = (campaignId) => api("POST", "/v1/admin/campaigns/approve", { adminKey: "test-admin", campaignId });

  console.log("dwell api verification (real postgres, fake stripe + mail)\n");

  await check("healthz", async () => assert.strictEqual((await api("GET", "/healthz")).status, 200));

  await check("CORS preflight returns 204 with allow-origin", async () => {
    const r = await fetch(base + "/v1/ads", { method: "OPTIONS" });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get("access-control-allow-origin"), "https://dwellprotocol.com");
    // authed web endpoints send a Bearer token, so the preflight must allow it
    assert.ok(/authorization/i.test(r.headers.get("access-control-allow-headers")), "Authorization not in allowed headers");
  });

  // ---------- checkout + validation ----------
  let campA;
  await check("checkout creates pending campaign + Stripe session", async () => {
    const r = await api("POST", "/v1/checkout", {
      email: "ads@linear.app", adLine: "Linear — issue tracking built for speed",
      url: "https://linear.app/", brand: "Linear", pricePerBlock: 5, blocks: 2,
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.checkoutUrl.startsWith("https://checkout.stripe.com/"));
    campA = r.body.campaignId;
    const call = stripeCalls.find((c) => c.path === "/v1/checkout/sessions");
    assert.strictEqual(call.params["line_items[0][price_data][unit_amount]"], "500");
    assert.strictEqual(call.params["metadata[campaign_id]"], campA);
  });

  await check("checkout rejects sub-$0.50 bids and XSS ad lines", async () => {
    // $0.50 is the floor (Stripe USD minimum); anything below is rejected.
    assert.strictEqual((await api("POST", "/v1/checkout", { email: "a@b.co", adLine: "ok line", url: "https://x.com", pricePerBlock: 0.49, blocks: 1 })).status, 400);
    const xss = await api("POST", "/v1/checkout", { email: "a@b.co", adLine: '<script>alert(1)</script>', url: "https://x.com", pricePerBlock: 5, blocks: 1 });
    assert.strictEqual(xss.status, 400);
  });

  // ---------- payment -> review -> approve ----------
  await check("paid campaign waits in review (not served) until approved", async () => {
    let ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 0);
    const wh = await payWebhook(campA);
    assert.strictEqual(wh.status, 200);
    // the transitioning webhook emails the advertiser a receipt exactly once
    const receipt = mailbox.find((m) => m.campaignId === campA);
    assert.ok(receipt, "no advertiser receipt sent on payment");
    assert.strictEqual(receipt.to, "ads@linear.app");
    assert.strictEqual(receipt.blocks, 2);
    assert.strictEqual(receipt.pricePerBlockCents, 500);
    ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads.length, 0, "served before moderation");
    const queue = await api("GET", "/v1/admin/campaigns", undefined, { "X-Admin-Key": "test-admin" });
    assert.strictEqual(queue.body.campaigns.length, 1);
    await approve(campA);
    ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads[0].line, "Linear — issue tracking built for speed");
  });

  await check("webhook bad signature rejected; moderation needs admin key", async () => {
    const r = await api("POST", "/v1/webhooks/stripe", JSON.stringify({ id: "e", type: "x" }), { "stripe-signature": "t=1,v1=bad" });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await api("GET", "/v1/admin/campaigns?adminKey=nope")).status, 401);
  });

  await check("duplicate webhook event id is ignored (no double-funding)", async () => {
    const eid = "evt_dup_fixed";
    const r1 = await payWebhook(campA, "pi_x", eid); // campA already past pending_payment -> markCampaignPaid no-ops anyway
    const r2 = await payWebhook(campA, "pi_x", eid);
    assert.strictEqual(r2.body.duplicate, true);
    const credits = await poolNs.query(`select count(*)::int n from ledger where campaign_id = $1 and entry_type = 'campaign_credit'`, [campA]);
    assert.strictEqual(credits.rows[0].n, 1, "campA funded more than once");
  });

  // ---------- auction ranking ----------
  let campFluid;
  await check("auction ranks the higher bid first", async () => {
    const r = await api("POST", "/v1/checkout", {
      email: "ads@fluidstack.io", adLine: "Fluidstack — building 10GW of compute. Join us.",
      url: "https://fluidstack.io/", brand: "Fluidstack", pricePerBlock: 110, blocks: 2,
    });
    campFluid = r.body.campaignId;
    await payWebhook(campFluid);
    await approve(campFluid);
    const ads = await api("GET", "/v1/ads");
    assert.strictEqual(ads.body.ads[0].brand, "Fluidstack");
    assert.strictEqual((await api("GET", "/v1/leaderboard")).body.leaderboard[0].brand, "Fluidstack");
  });

  // ---------- devices & ledger ----------
  let device;
  await check("device registers and earns exactly 90% on impressions (events never bill self-reported clicks)", async () => {
    device = (await api("POST", "/v1/devices/register")).body;
    assert.ok(device.deviceId && device.deviceKey);
    // 100 impressions on campA ($5 block): 100*500/1000 = 50c -> 45c. The clicks
    // field is IGNORED for billing — genuine clicks go through the token path —
    // so a forged clicks count mints nothing.
    const r = await api("POST", "/v1/events", { ...device, batchKey: "b1", events: [{ campaignId: campA, impressions: 100, clicks: 9999 }] });
    assert.strictEqual(r.body.creditedMillicents, 45000);
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body.earnedUsd, 0.45);

    // a clicks-only batch credits nothing at all (and can't bypass the daily cap)
    const clicksOnly = await api("POST", "/v1/events", { ...device, batchKey: "b1-clicks", events: [{ campaignId: campA, impressions: 0, clicks: 100000 }] });
    assert.strictEqual(clicksOnly.body.creditedMillicents, 0);
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body.earnedUsd, 0.45);
  });

  await check("replayed batch never double-pays; bad creds 401; cap 429", async () => {
    assert.strictEqual((await api("POST", "/v1/events", { ...device, batchKey: "b1", events: [{ campaignId: campA, impressions: 100, clicks: 1 }] })).body.duplicate, true);
    assert.strictEqual((await api("POST", "/v1/events", { deviceId: device.deviceId, deviceKey: "wrong", batchKey: "z", events: [] })).status, 401);
    assert.strictEqual((await api("POST", "/v1/events", { ...device, batchKey: "bcap", events: [{ campaignId: campA, impressions: 6000, clicks: 0 }] })).status, 429);
  });

  // ---------- server-side clicks ----------
  let clickDevice;
  await check("click intent + /go redirect records a free click (no earnings, no budget draw)", async () => {
    clickDevice = (await api("POST", "/v1/devices/register")).body;
    const intent = await api("POST", "/v1/clicks/intent", { ...clickDevice, campaignId: campFluid });
    assert.strictEqual(intent.status, 200);
    assert.ok(intent.body.trackingUrl.includes("/v1/go/"));
    const token = intent.body.trackingUrl.split("/v1/go/")[1];
    const remaining = async () => (await poolNs.query("select impressions_remaining from campaigns where id = $1", [campFluid])).rows[0].impressions_remaining;
    const clickEvents = async () => (await poolNs.query("select count(*)::int n from ledger where device_id = $1 and entry_type = 'click_event'", [clickDevice.deviceId])).rows[0].n;
    const before = await remaining();
    const go = await api("GET", `/v1/go/${token}`);
    assert.strictEqual(go.status, 302);
    assert.strictEqual(go.headers.get("location"), "https://fluidstack.io/");
    // clicks are free now: the device earns nothing and the campaign budget is untouched
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${clickDevice.deviceId}&deviceKey=${clickDevice.deviceKey}`)).body.earnedUsd, 0);
    assert.strictEqual(await remaining(), before, "a click must not draw campaign budget");
    assert.strictEqual(await clickEvents(), 1, "the click is recorded as one zero-value click_event");
    // single-use: replay still redirects but records nothing more
    await api("GET", `/v1/go/${token}`);
    assert.strictEqual(await clickEvents(), 1, "replay records no new click_event");
  });

  await check("click intent for an inactive campaign is 404", async () => {
    assert.strictEqual((await api("POST", "/v1/clicks/intent", { ...clickDevice, campaignId: campA && "00000000-0000-0000-0000-000000000000" })).status, 404);
  });

  await check("verified clicks are free but still recorded, and capped per device per day", async () => {
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@clickcap.co", adLine: "click cap regression campaign", url: "https://clickcap.example/",
      brand: "ClickCap", pricePerBlock: 2, blocks: 5,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const capDev = (await api("POST", "/v1/devices/register")).body;
    const before = (await poolNs.query("select impressions_remaining from campaigns where id = $1", [camp.body.campaignId])).rows[0].impressions_remaining;

    // fire 7 clicks; dailyClickCap is 5, so only 5 are recorded (the rest still redirect)
    for (let i = 0; i < 7; i++) {
      const intent = await api("POST", "/v1/clicks/intent", { ...capDev, campaignId: camp.body.campaignId });
      const go = await api("GET", `/v1/go/${intent.body.trackingUrl.split("/v1/go/")[1]}`);
      assert.strictEqual(go.status, 302); // over-cap clicks still redirect cleanly
      assert.strictEqual(go.headers.get("location"), "https://clickcap.example/");
    }
    // clicks are free: the device earns nothing and the budget is untouched
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${capDev.deviceId}&deviceKey=${capDev.deviceKey}`)).body.earnedUsd, 0);
    assert.strictEqual(
      (await poolNs.query("select impressions_remaining from campaigns where id = $1", [camp.body.campaignId])).rows[0].impressions_remaining,
      before, "clicks must not draw budget");
    // exactly 5 click_events recorded — the daily cap bounds what we record
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from ledger where device_id = $1 and entry_type = 'click_event'", [capDev.deviceId])).rows[0].n,
      5, "daily cap bounds recorded clicks");
  });

  // ---------- server-authoritative impressions (single-use tokens) ----------
  let impCampaign;
  await check("impression serve mints a token; redeem bills exactly one (90%) and is single-use / device-scoped", async () => {
    // Highest bid among active campaigns → this one wins the serve auction, so we
    // know which campaign was served and can assert its budget + the credit.
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@imp.co", adLine: "Impression token campaign", url: "https://imp.example/",
      brand: "ImpTok", pricePerBlock: 999, blocks: 2,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    impCampaign = camp.body.campaignId;
    const remainingOf = async (id) => (await poolNs.query("select impressions_remaining from campaigns where id = $1", [id])).rows[0].impressions_remaining;

    const dev = (await api("POST", "/v1/devices/register")).body;
    const serve = await api("POST", "/v1/impressions/serve", { ...dev });
    assert.strictEqual(serve.status, 200);
    assert.ok(serve.body.token, "serve returns a single-use token");
    assert.strictEqual(serve.body.ad.id, impCampaign, "top bid wins the serve auction");
    const price = (await poolNs.query("select price_per_block_cents from campaigns where id = $1", [impCampaign])).rows[0].price_per_block_cents;
    const expectDev = Number((BigInt(price) * 900n) / 1000n); // revenueShare 0.9, billed 1
    const before = await remainingOf(impCampaign);

    // base config dwell = 0, so an immediate redeem is billable. Use a
    // device-scoped source (terminal); the "chrome" source additionally requires
    // a linked account, which is exercised in the auto-link test below.
    const redeem = await api("POST", "/v1/impressions/redeem", { ...dev, token: serve.body.token, source: "claude_code" });
    assert.strictEqual(redeem.status, 200);
    assert.strictEqual(redeem.body.ok, true);
    assert.strictEqual(redeem.body.creditedMillicents, expectDev, "device earns exactly its share of one impression");
    assert.strictEqual(await remainingOf(impCampaign), before - 1, "exactly one impression billed against the campaign");
    assert.strictEqual((await api("GET", `/v1/me/earnings?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body.earnedUsd, expectDev / 100000);

    // single-use: a replay is refused and never double-bills
    const replay = await api("POST", "/v1/impressions/redeem", { ...dev, token: serve.body.token });
    assert.strictEqual(replay.status, 409);
    assert.strictEqual(replay.body.reason, "used");
    assert.strictEqual(await remainingOf(impCampaign), before - 1, "a replay must not draw budget");

    // unknown token → 404; another device can't redeem your token → 404 (device-scoped)
    assert.strictEqual((await api("POST", "/v1/impressions/redeem", { ...dev, token: "not-a-real-token" })).status, 404);
    const serve2 = await api("POST", "/v1/impressions/serve", { ...dev });
    const other = (await api("POST", "/v1/devices/register")).body;
    assert.strictEqual((await api("POST", "/v1/impressions/redeem", { ...other, token: serve2.body.token })).status, 404, "device-scoped");
  });

  await check("impression redeem enforces the qualifying dwell (too_soon, non-consuming so an honest client retries)", async () => {
    const cfgDwell = { ...config, impressionMinDwellMs: 60000 };
    const { server: sD } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgDwell });
    await new Promise((r) => sD.listen(0, r));
    const bD = `http://127.0.0.1:${sD.address().port}`;
    const postD = (p, b) => fetch(bD + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const dev = (await api("POST", "/v1/devices/register")).body;
    const serve = await postD("/v1/impressions/serve", { ...dev });
    assert.ok(serve.body.token);
    // redeem before the dwell elapses is refused …
    const early = await postD("/v1/impressions/redeem", { ...dev, token: serve.body.token });
    assert.strictEqual(early.status, 409);
    assert.strictEqual(early.body.reason, "too_soon");
    // … and did NOT consume the token: it still redeems on the dwell-0 main app
    const later = await api("POST", "/v1/impressions/redeem", { ...dev, token: serve.body.token });
    assert.strictEqual(later.status, 200);
    assert.strictEqual(later.body.ok, true);
    sD.close();
  });

  await check("impression serve enforces the per-device daily cap (billed <= served <= cap)", async () => {
    const cfgCap = { ...config, dailyImpressionCap: 2 };
    const { server: sC } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgCap });
    await new Promise((r) => sC.listen(0, r));
    const bC = `http://127.0.0.1:${sC.address().port}`;
    const postC = (p, b) => fetch(bC + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const dev = (await api("POST", "/v1/devices/register")).body; // fresh device → today's count starts at 0
    assert.ok((await postC("/v1/impressions/serve", { ...dev })).body.token, "1st serve ok");
    assert.ok((await postC("/v1/impressions/serve", { ...dev })).body.token, "2nd serve ok");
    const third = await postC("/v1/impressions/serve", { ...dev });
    assert.strictEqual(third.body.ad, null);
    assert.strictEqual(third.body.capped, true, "past the daily cap, serve returns no ad");
    sC.close();
  });

  await check("a token-capable client's legacy /v1/events batch is refused (no double-credit during transition)", async () => {
    const dev = (await api("POST", "/v1/devices/register")).body;
    const r = await api("POST", "/v1/events", { ...dev, capabilities: ["impression_tokens"], batchKey: "capguard", events: [{ campaignId: campA, impressions: 100, clicks: 0 }] });
    assert.strictEqual(r.status, 409, "migrated client must not also post self-reported batches");
  });

  await check("an unpaid 'active' campaign never serves and never mints credits", async () => {
    // A campaign forced straight to 'active' without payment (paid_at null) —
    // e.g. a bad seed row — must be invisible to the auction and worthless to
    // bill against: every user credit is a real payout liability, so credits
    // may only ever be minted against money an advertiser actually paid.
    const adv = (await poolNs.query("insert into advertisers (email) values ('unpaid@x.io') returning id")).rows[0].id;
    const unpaid = (await poolNs.query(
      `insert into campaigns (advertiser_id, brand, ad_line, url, category, price_per_block_cents,
                              blocks, impressions_total, impressions_remaining, status, paid_at, activated_at)
       values ($1, 'Unpaid', 'unpaid placeholder ad', 'https://unpaid.example/', 'other', 99999,
               1, 1000, 1000, 'active', null, now()) returning id`,
      [adv])).rows[0].id;
    // not listed publicly
    const ads = await api("GET", "/v1/ads");
    assert.ok(!ads.body.ads.some((a) => a.id === unpaid), "unpaid campaign listed in /v1/ads");
    // never wins the serve auction, even as the highest bid on the book
    const serveDev = (await api("POST", "/v1/devices/register")).body;
    const serve = await api("POST", "/v1/impressions/serve", { ...serveDev });
    assert.ok(!serve.body.ad || serve.body.ad.id !== unpaid, "auction served an unpaid campaign");
    // a batch claiming impressions against it credits nothing and draws no budget
    const batchDev = (await api("POST", "/v1/devices/register")).body;
    const r = await api("POST", "/v1/events", { ...batchDev, batchKey: "unpaid1", events: [{ campaignId: unpaid, impressions: 100, clicks: 0 }] });
    assert.strictEqual(r.body.creditedMillicents, 0, "unpaid campaign minted credits");
    assert.strictEqual(
      (await poolNs.query("select impressions_remaining from campaigns where id = $1", [unpaid])).rows[0].impressions_remaining,
      1000, "unpaid campaign budget was drawn");
    await poolNs.query("update campaigns set status = 'cancelled' where id = $1", [unpaid]);
  });

  await check("concurrent gift redemptions can't double-spend the same balance", async () => {
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@race.co", adLine: "double spend regression campaign", url: "https://race.example/",
      brand: "Race", pricePerBlock: 110, blocks: 1,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);

    // earn $24.75 — enough for exactly one $22 Pro month ($20 face + 10% fee),
    // not two — then link the device to an email and open a web session
    // (redemption is web-only).
    const raceDev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...raceDev, batchKey: "brace", events: [{ campaignId: camp.body.campaignId, impressions: 250, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...raceDev, email: "race@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));
    await api("POST", "/v1/web/login", { email: "race@example.com" });
    const session = (await api("GET", mailbox.at(-1).link.replace(base, ""))).headers.get("location").match(/session=([^&]+)/)[1];
    const auth = { Authorization: `Bearer ${session}` };
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.balanceUsd, 24.75);

    // fire two identical redemptions at once: exactly one settles, the ledger never overdraws
    const [a, b] = await Promise.all([
      api("POST", "/v1/web/redemptions", { plan: "pro", months: 1, recipientEmail: "race@example.com" }, auth),
      api("POST", "/v1/web/redemptions", { plan: "pro", months: 1, recipientEmail: "race@example.com" }, auth),
    ]);
    // exactly one settles; the loser is rejected for insufficient credits —
    // at the pre-check (403) or the in-transaction recheck (409) depending on
    // scheduling. The invariant that matters: the balance is charged only once.
    const ok = [a, b].filter((r) => r.status === 200);
    const failed = [a, b].filter((r) => r.status !== 200);
    assert.strictEqual(ok.length, 1, "exactly one redemption should succeed");
    assert.ok([403, 409].includes(failed[0].status), "the loser is rejected for insufficient credits");
    const after = (await api("GET", "/v1/web/me", undefined, auth)).body;
    assert.strictEqual(after.balanceUsd, 2.75, "only one $20 gift (+ $2 fee) was charged");
    assert.ok(after.balanceUsd >= 0, "balance never goes negative");
  });

  await check("per-IP daily impression cap bounds farming across many anonymous devices", async () => {
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@ipcap.co", adLine: "ip cap regression campaign", url: "https://ipcap.example/",
      brand: "IPCap", pricePerBlock: 5, blocks: 50,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);

    // second app instance with a low per-IP cap; all test traffic shares 127.0.0.1
    const cfgIp = { ...config, ipDailyImpressionCap: 1500 };
    const { server: s3 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgIp });
    await new Promise((r) => s3.listen(0, r));
    const b3 = `http://127.0.0.1:${s3.address().port}`;
    const post = (p, b) => fetch(b3 + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const d1 = (await post("/v1/devices/register", {})).body;
    const d2 = (await post("/v1/devices/register", {})).body;
    // d1 is under both caps and credits normally
    const r1 = await post("/v1/events", { ...d1, batchKey: "ip-a", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    assert.strictEqual(r1.status, 200);
    // d2 is well under ITS OWN device cap (5000) but tips the shared IP past 1500 → 429
    const r2 = await post("/v1/events", { ...d2, batchKey: "ip-b", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    assert.strictEqual(r2.status, 429);
    s3.close();
  });

  // ---------- email-gated payouts ----------
  await check("onboarding is blocked until email is verified", async () => {
    const blocked = await api("POST", "/v1/connect/onboard", device);
    assert.strictEqual(blocked.status, 403);

    const req = await api("POST", "/v1/auth/request-link", { ...device, email: "dev@example.com" });
    assert.strictEqual(req.status, 200);
    const link = mailbox.at(-1).link;
    const token = new URL(link).searchParams.get("token");
    const verify = await api("GET", `/v1/auth/verify?token=${token}`);
    assert.strictEqual(verify.status, 302);
    assert.strictEqual(verify.headers.get("location"), "https://dwellprotocol.com/?verified=1");

    const ok = await api("POST", "/v1/connect/onboard", device);
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.onboardingUrl.includes("connect.stripe.com"));
    const acct = stripeCalls.find((c) => c.path === "/v1/accounts");
    assert.strictEqual(acct.params.type, "express");
  });

  await check("account.updated enables payouts; sweep debits gross, transfers net of the 10% fee", async () => {
    const accountId = (await poolNs.query("select stripe_account_id from users where email = 'dev@example.com'")).rows[0].stripe_account_id;
    const payload = JSON.stringify({ id: "evt_acct_1", type: "account.updated", data: { object: { id: accountId, charges_enabled: true, payouts_enabled: true } } });
    await api("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET) });

    // top device up well over $10: 1000 imps on the $110 campaign = $99
    await api("POST", "/v1/events", { ...device, batchKey: "bbig", events: [{ campaignId: campFluid, impressions: 1000, clicks: 0 }] });
    const before = (await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body;
    const grossCents = Math.floor((before.balanceUsd * 100000) / 1000);
    const feeCents = Math.ceil((grossCents * config.payoutFeeBps) / 10000);
    const netCents = grossCents - feeCents;

    const r = await api("POST", "/v1/admin/payouts", { adminKey: "test-admin" });
    assert.strictEqual(r.body.paid, 1);
    const transfer = stripeCalls.find((c) => c.path === "/v1/transfers");
    assert.strictEqual(transfer.params.amount, String(netCents), "Stripe receives the net after the protocol fee");
    // the user's balance is debited the GROSS; the fee lands platform-side
    const after = (await api("GET", `/v1/me/earnings?deviceId=${device.deviceId}&deviceKey=${device.deviceKey}`)).body;
    assert.strictEqual(Math.round(after.paidOutUsd * 100), grossCents);
    const feeRow = await poolNs.query(
      "select amount_millicents from ledger where entry_type = 'platform_fee' and meta->>'source' = 'payout_fee'");
    assert.strictEqual(feeRow.rows.length, 1, "one payout fee row");
    assert.strictEqual(Number(feeRow.rows[0].amount_millicents), feeCents * 1000);
    assert.strictEqual((await api("POST", "/v1/admin/payouts", { adminKey: "nope" })).status, 401);
  });

  await check("admin balance adjustments move the spendable balance, not lifetime earned", async () => {
    // admin_debit is how unbacked credits get wiped (and admin_credit how a
    // cancelled redemption is refunded) — both must flow into balanceUsd or the
    // wipe/refund is cosmetic and redemptions/payouts still see the old number.
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@adjust.co", adLine: "admin adjust regression campaign", url: "https://adjust.example/",
      brand: "Adjust", pricePerBlock: 10, blocks: 1,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...dev, batchKey: "adj1", events: [{ campaignId: camp.body.campaignId, impressions: 100, clicks: 0 }] });
    const before = (await api("GET", `/v1/me/earnings?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body;
    assert.ok(before.balanceUsd > 0, "device earned nothing to adjust");
    // wipe the balance the way the admin console does — an offsetting admin_debit
    await poolNs.query(
      `insert into ledger (entry_type, amount_millicents, device_id, meta)
       values ('admin_debit', $1, $2, '{"reason":"test wipe"}')`,
      [String(-Math.round(before.balanceUsd * 100000)), dev.deviceId]
    );
    const after = (await api("GET", `/v1/me/earnings?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body;
    assert.strictEqual(after.balanceUsd, 0, "admin_debit did not reduce the spendable balance");
    assert.strictEqual(after.earnedUsd, before.earnedUsd, "admin_debit must not rewrite lifetime earned");
  });

  // ---------- gift card catalog + retired device redemption ----------
  await check("giftcards catalog lists plans; device-credential redemption is retired", async () => {
    const catalog = await api("GET", "/v1/giftcards");
    assert.strictEqual(catalog.body.plans.find((p) => p.id === "pro").monthlyUsd, 20);
    assert.deepStrictEqual(catalog.body.months, [1, 3, 6, 12]);
    assert.strictEqual(catalog.body.redemptionFeeBps, 1000, "catalog advertises the protocol fee");

    // Redemption is a website-only, logged-in flow. The old device-credential
    // path is retired: even a valid deviceKey with a redeemable balance must not
    // be able to cash out — it gets a 410 and the balance is left untouched.
    const giftDevice = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...giftDevice, batchKey: "bgift", events: [{ campaignId: campFluid, impressions: 250, clicks: 0 }] });
    const before = (await api("GET", `/v1/me/earnings?deviceId=${giftDevice.deviceId}&deviceKey=${giftDevice.deviceKey}`)).body;
    assert.strictEqual(before.balanceUsd, 24.75);

    const r = await api("POST", "/v1/redemptions", { ...giftDevice, plan: "pro", months: 1, recipientEmail: "dev@example.com" });
    assert.strictEqual(r.status, 410, "device-credential redemption is retired");
    assert.match(r.body.redeemUrl, /\/portal\.html$/);

    const after = (await api("GET", `/v1/me/earnings?deviceId=${giftDevice.deviceId}&deviceKey=${giftDevice.deviceKey}`)).body;
    assert.strictEqual(after.balanceUsd, 24.75, "balance untouched — no debit");
    assert.strictEqual(after.redeemedUsd, 0, "nothing redeemed via the retired path");
  });

  // ---------- website login + user-scoped redemption ----------
  await check("website login lets a user redeem their linked balance for a gift card", async () => {
    // dedicated campaign so this test's earnings are independent of others
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@web.co", adLine: "web test campaign line", url: "https://example.com/",
      brand: "WebTest", pricePerBlock: 110, blocks: 2,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);

    // device earns, then links its credits to an email via the magic link
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...dev, batchKey: "bweb", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...dev, email: "web@example.com" });
    const verifyLink = mailbox.at(-1).link;
    await api("GET", verifyLink.replace(base, ""));

    // web login: email a sign-in link, follow it to get a session
    const login = await api("POST", "/v1/web/login", { email: "web@example.com" });
    assert.strictEqual(login.status, 200);
    const loginLink = mailbox.at(-1).link;
    const sess = await api("GET", loginLink.replace(base, ""));
    assert.strictEqual(sess.status, 302);
    const session = sess.headers.get("location").match(/session=([^&]+)/)[1];

    // balance is visible and matches the device's earnings (1000 imp @ $110 block, 90%)
    const me = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.email, "web@example.com");
    assert.strictEqual(me.body.balanceUsd, 99);

    // redeem Claude Pro, 3 months = $60 face + $6 protocol fee = $66, leaving
    // $33. A client-supplied recipientEmail is IGNORED — the gift always goes
    // to the account email, so a stolen session can't redirect a cash-out to
    // an attacker inbox.
    const r = await api("POST", "/v1/web/redemptions",
      { plan: "pro", months: 3, recipientEmail: "attacker@evil.com" },
      { Authorization: `Bearer ${session}` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.amountUsd, 60);
    assert.strictEqual(r.body.feeUsd, 6);
    assert.strictEqual(r.body.totalUsd, 66);
    assert.strictEqual(r.body.balanceUsd, 33);

    // the fee is booked platform-side, closing the ledger
    const feeRow = await poolNs.query(
      "select amount_millicents from ledger where entry_type = 'platform_fee' and meta->>'source' = 'redemption_fee' and meta->>'redemptionId' = $1",
      [r.body.redemptionId]);
    assert.strictEqual(feeRow.rows.length, 1, "one redemption fee row");
    assert.strictEqual(Number(feeRow.rows[0].amount_millicents), 600 * 1000, "$6 fee in millicents");

    // The fulfillment inbox is notified; the redeeming user now also gets their
    // own confirmation, so find the fulfillment mail rather than the last one.
    const mail = [...mailbox].reverse().find((m) => m.to === "hello@dwellprotocol.com");
    assert.ok(mail, "fulfillment inbox is notified of the redemption");
    assert.strictEqual(mail.planName, "Claude Pro");
    assert.strictEqual(mail.months, 3);
    assert.strictEqual(mail.recipientEmail, "web@example.com", "recipient is forced to the account email");
    assert.ok([...mailbox].reverse().find((m) => m.to === "web@example.com" && m.planName),
      "the redeeming user also gets a confirmation email");

    const after = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` });
    assert.strictEqual(after.body.balanceUsd, 33);

    // can't redeem beyond balance (the 403 spells out face vs fee), and no session = 401
    const broke = await api("POST", "/v1/web/redemptions",
      { plan: "max5x", months: 1 }, { Authorization: `Bearer ${session}` });
    assert.strictEqual(broke.status, 403);
    assert.strictEqual(broke.body.requiredUsd, 110, "$100 face + $10 fee");
    assert.strictEqual(broke.body.feeUsd, 10);
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "pro", months: 1 })).status, 401);

    // validation on the logged-in path: bad plan / months
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "ultra", months: 1 }, { Authorization: `Bearer ${session}` })).status, 400);
    assert.strictEqual((await api("POST", "/v1/web/redemptions", { plan: "pro", months: 2 }, { Authorization: `Bearer ${session}` })).status, 400);

    // sign out revokes the session server-side: the same bearer token is dead
    const logout = await api("POST", "/v1/web/logout", {}, { Authorization: `Bearer ${session}` });
    assert.strictEqual(logout.status, 200);
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${session}` })).status, 401);
  });

  // Earn → link → login helper for the money-out tests below. Returns a web
  // session header for a fresh user whose linked device earned `impressions`
  // on a fresh $110-block campaign (9.9¢ per impression at the 90% share).
  const linkedSession = async (email, impressions) => {
    const camp = await api("POST", "/v1/checkout", {
      email: `adv+${crypto.randomBytes(3).toString("hex")}@payout.co`, adLine: "payout fixture campaign line",
      url: "https://payout.example/", brand: "PayFix", pricePerBlock: 110, blocks: 5,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...dev, batchKey: "bk" + crypto.randomBytes(3).toString("hex"), events: [{ campaignId: camp.body.campaignId, impressions, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...dev, email });
    await api("GET", mailbox.at(-1).link.replace(base, ""));
    await api("POST", "/v1/web/login", { email });
    const session = (await api("GET", mailbox.at(-1).link.replace(base, ""))).headers.get("location").match(/session=([^&]+)/)[1];
    return { auth: { Authorization: `Bearer ${session}` }, email };
  };

  await check("a balance covering face value but not face + fee is refused", async () => {
    // 210 imps × 9.9¢ = $20.79 — at least the $20 Pro face, under the $22 total
    const { auth } = await linkedSession("betwixt@example.com", 210);
    const r = await api("POST", "/v1/web/redemptions", { plan: "pro", months: 1 }, auth);
    assert.strictEqual(r.status, 403, "fee is not optional");
    assert.strictEqual(r.body.requiredUsd, 22);
    assert.strictEqual(r.body.amountUsd, 20);
    assert.strictEqual(r.body.feeUsd, 2);
    assert.strictEqual(r.body.balanceUsd, 20.79);
  });

  await check("web payout: request queues (held, no transfer); admin approves → net transfer + 10% fee; history", async () => {
    // $99 balance (1000 imps), linked + logged in
    const { auth, email } = await linkedSession("payout-web@example.com", 1000);

    // no session → 401; with session → Stripe Express onboarding link
    assert.strictEqual((await api("POST", "/v1/web/connect/onboard", {})).status, 401);
    const ob = await api("POST", "/v1/web/connect/onboard", {}, auth);
    assert.strictEqual(ob.status, 200);
    assert.ok(ob.body.onboardingUrl.includes("connect.stripe.com"));

    // payouts not yet enabled (webhook hasn't fired) → status shows it, request refused
    const st = await api("GET", "/v1/web/payouts", undefined, auth);
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.body.hasStripeAccount, true);
    assert.strictEqual(st.body.payoutsEnabled, false);
    assert.strictEqual(st.body.payoutFeeBps, 1000);
    assert.strictEqual(st.body.thresholdUsd, 10);
    assert.strictEqual((await api("POST", "/v1/web/payouts/request", {}, auth)).status, 403);

    // Stripe finishes onboarding → account.updated flips payouts_enabled
    const accountId = (await poolNs.query("select stripe_account_id from users where email = $1", [email])).rows[0].stripe_account_id;
    const payload = JSON.stringify({ id: "evt_acct_web", type: "account.updated", data: { object: { id: accountId, charges_enabled: true, payouts_enabled: true } } });
    await api("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET) });

    const transfersBefore = stripeCalls.filter((c) => c.path === "/v1/transfers").length;

    // two simultaneous requests: exactly one queues (the other is stopped by the
    // per-user throttle or the in-transaction balance recheck)
    const [a, b] = await Promise.all([
      api("POST", "/v1/web/payouts/request", {}, auth),
      api("POST", "/v1/web/payouts/request", {}, auth),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    assert.strictEqual(ok.length, 1, "exactly one request queues");
    assert.ok([409, 429].includes([a, b].find((r) => r.status !== 200).status));

    // the request is queued — funds held ($99 gross → $89.10 net), NOTHING transferred
    const reqd = ok[0].body;
    assert.strictEqual(reqd.requested, true, "queued, not paid");
    assert.strictEqual(reqd.grossUsd, 99);
    assert.strictEqual(reqd.feeUsd, 9.9);
    assert.strictEqual(reqd.netUsd, 89.1);
    assert.strictEqual(reqd.balanceUsd, 0, "funds are held immediately");
    assert.strictEqual(stripeCalls.filter((c) => c.path === "/v1/transfers").length, transfersBefore,
      "queuing a request never transfers — money is manual");

    // the user sees it as 'requested' in their history
    const hist1 = await api("GET", "/v1/web/payouts", undefined, auth);
    assert.strictEqual(hist1.body.payouts[0].status, "requested");
    assert.strictEqual(hist1.body.payouts[0].amountUsd, 89.1);
    assert.strictEqual(hist1.body.balanceUsd, 0);

    // admin review: the request is listed with gross/fee. This user signed in by
    // email (no X account), so the onboarding-post check reads "no_x_account".
    const list = await api("GET", "/v1/admin/payouts/requests?adminKey=test-admin");
    assert.strictEqual(list.status, 200);
    const mine = list.body.requests.find((r) => r.email === email);
    assert.ok(mine, "the request shows up for admin review");
    assert.strictEqual(mine.grossUsd, 99);
    assert.strictEqual(mine.netUsd, 89.1);
    assert.strictEqual(mine.postStatus, "no_x_account", "email-only user can't be X-verified");
    assert.strictEqual(mine.stripeReady, true);

    // a bad admin key can't approve
    assert.strictEqual((await api("POST", "/v1/admin/payouts/requests/approve", { payoutId: mine.payoutId, adminKey: "nope" })).status, 401);

    // admin approves → the net transfer fires now, and only now
    const appr = await api("POST", "/v1/admin/payouts/requests/approve", { payoutId: mine.payoutId, adminKey: "test-admin" });
    assert.strictEqual(appr.status, 200);
    assert.strictEqual(appr.body.netUsd, 89.1);
    const transfer = [...stripeCalls].reverse().find((c) => c.path === "/v1/transfers");
    assert.strictEqual(transfer.params.amount, "8910", "Stripe receives the net on approval");

    // fee row platform-side; payouts history flips to 'paid'
    const feeRow = await poolNs.query(
      "select amount_millicents from ledger where entry_type = 'platform_fee' and meta->>'source' = 'payout_fee' and meta->>'userId' is not null and meta->>'payoutId' is not null");
    assert.strictEqual(feeRow.rows.length, 1);
    assert.strictEqual(Number(feeRow.rows[0].amount_millicents), 990 * 1000);
    const hist = await api("GET", "/v1/web/payouts", undefined, auth);
    assert.strictEqual(hist.body.payouts[0].status, "paid");
    assert.strictEqual(hist.body.payouts[0].amountUsd, 89.1);
    assert.strictEqual(hist.body.balanceUsd, 0);

    // the approved request is no longer in the review queue, and double-approve 409s
    const list2 = await api("GET", "/v1/admin/payouts/requests?adminKey=test-admin");
    assert.ok(!list2.body.requests.find((r) => r.payoutId === mine.payoutId), "approved request leaves the queue");
    assert.strictEqual((await api("POST", "/v1/admin/payouts/requests/approve", { payoutId: mine.payoutId, adminKey: "test-admin" })).status, 409);

    // drained: another request is refused for being under the threshold
    const again = await api("POST", "/v1/web/payouts/request", {}, auth);
    assert.ok([403, 429].includes(again.status), "no second request from an empty balance");
  });

  await check("payout reject returns the held balance; the request leaves the queue", async () => {
    const { auth, email } = await linkedSession("payout-reject@example.com", 1000);
    await api("POST", "/v1/web/connect/onboard", {}, auth); // create the Stripe account
    const accountId = (await poolNs.query("select stripe_account_id from users where email = $1", [email])).rows[0].stripe_account_id;
    // enable payouts
    const pl = JSON.stringify({ id: "evt_acct_rej", type: "account.updated", data: { object: { id: accountId, charges_enabled: true, payouts_enabled: true } } });
    await api("POST", "/v1/webhooks/stripe", pl, { "stripe-signature": signWebhookPayload(pl, WEBHOOK_SECRET) });

    const req = await api("POST", "/v1/web/payouts/request", {}, auth);
    assert.strictEqual(req.status, 200);
    assert.strictEqual(req.body.balanceUsd, 0, "held on request");

    const list = await api("GET", "/v1/admin/payouts/requests?adminKey=test-admin");
    const mine = list.body.requests.find((r) => r.email === email);
    const transfersBefore = stripeCalls.filter((c) => c.path === "/v1/transfers").length;

    const rej = await api("POST", "/v1/admin/payouts/requests/reject", { payoutId: mine.payoutId, adminKey: "test-admin" });
    assert.strictEqual(rej.status, 200);
    assert.strictEqual(rej.body.restoredUsd, 99);

    // no transfer, balance restored to the full $99, request gone from the queue
    assert.strictEqual(stripeCalls.filter((c) => c.path === "/v1/transfers").length, transfersBefore, "reject never transfers");
    const bal = await api("GET", "/v1/web/payouts", undefined, auth);
    assert.strictEqual(bal.body.balanceUsd, 99, "rejecting returns the held balance");
    assert.strictEqual(bal.body.payouts[0].status, "rejected");
    const list2 = await api("GET", "/v1/admin/payouts/requests?adminKey=test-admin");
    assert.ok(!list2.body.requests.find((r) => r.payoutId === mine.payoutId), "rejected request leaves the queue");
    // double-reject 409s
    assert.strictEqual((await api("POST", "/v1/admin/payouts/requests/reject", { payoutId: mine.payoutId, adminKey: "test-admin" })).status, 409);
  });

  await check("onboarding-post verification: X timeline check flips no_x_account → verified, surfaced to admin only", async () => {
    // an X-authed earner with a payable balance
    const { sessionToken } = await repo.upsertUserByOAuth({ twitterId: "x_payout_9", emailVerified: false }, config.webSessionTtlMs);
    const uid = (await poolNs.query("select id from users where twitter_id = 'x_payout_9'")).rows[0].id;
    await poolNs.query("insert into ledger (entry_type, amount_millicents, user_id) values ('admin_credit', 9900000, $1)", [uid]); // $99
    await poolNs.query("update users set onboarding_posted_at = now(), stripe_account_id = 'acct_x9', payouts_enabled = true where id = $1", [uid]);
    const auth = { Authorization: `Bearer ${sessionToken}` };

    const req = await api("POST", "/v1/web/payouts/request", {}, auth);
    assert.strictEqual(req.status, 200, "X user can request a payout");

    // before checking, the timeline has no matching post → verify reports not_found
    twitterTweets = [{ id: "1", text: "gm" }];
    const uidBody = { userId: uid, adminKey: "test-admin" };
    let v = await api("POST", "/v1/admin/payouts/verify-post", uidBody);
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.status, "not_found");

    // the earner posts the prebuilt note → the next check finds it and verifies
    twitterTweets = [{ id: "42", text: "earning with @dwellprotocol — get paid at https://dwellprotocol.com" }];
    v = await api("POST", "/v1/admin/payouts/verify-post", uidBody);
    assert.strictEqual(v.body.status, "verified");
    assert.ok(v.body.url.includes("42"));

    // the admin review now shows verified + the post URL; the earner UI never does
    const list = await api("GET", "/v1/admin/payouts/requests?adminKey=test-admin");
    const mine = list.body.requests.find((r) => r.userId === uid);
    assert.strictEqual(mine.postStatus, "verified");
    assert.ok(mine.postUrl && mine.postUrl.includes("42"));
    // the earner's own /v1/web/me carries no verification fields
    const me = await api("GET", "/v1/web/me", undefined, auth);
    assert.ok(!("postStatus" in me.body) && !("onboardingPostUrl" in me.body), "verification never leaks to the earner");

    twitterTweets = [];
  });

  await check("magic-link sends are rate-limited per email (anti-bomb / anti-enumeration)", async () => {
    // second app instance with a real cooldown; the main suite runs with it off
    const cfgCd = { ...config, emailCooldownMs: 60000 };
    const { server: s4 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgCd });
    await new Promise((r) => s4.listen(0, r));
    const b4 = `http://127.0.0.1:${s4.address().port}`;
    const post = (p, b) => fetch(b4 + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const before = mailbox.length;
    const r1 = await post("/v1/web/login", { email: "flood@example.com" });
    const r2 = await post("/v1/web/login", { email: "flood@example.com" });
    // both responses look identical to the caller — no enumeration signal …
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.ok(r2.body.sent, "throttled response shape is unchanged");
    // … but only one email actually went out within the cooldown window
    assert.strictEqual(mailbox.length - before, 1, "second rapid send is suppressed");
    s4.close();
  });

  await check("magic-link sends are capped per source IP per day (anti spam-cannon; other IPs unaffected)", async () => {
    // The per-email cooldown above only guards one address; this bounds a single
    // IP blasting magic links to many DISTINCT addresses. Fresh app instance with
    // a small cap; a unique X-Forwarded-For isolates the count from other tests.
    const cfgIpEmail = { ...config, emailIpDailyCap: 3, emailCooldownMs: 0 };
    const { server: s5 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgIpEmail });
    await new Promise((r) => s5.listen(0, r));
    const b5 = `http://127.0.0.1:${s5.address().port}`;
    const login = (email, ip) => fetch(b5 + "/v1/web/login", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ email }),
    }).then((r) => r.status);
    const attacker = "203.0.113.7";
    // three distinct addresses from one IP get through, the fourth is capped
    assert.strictEqual(await login("v1@spam.example", attacker), 200);
    assert.strictEqual(await login("v2@spam.example", attacker), 200);
    assert.strictEqual(await login("v3@spam.example", attacker), 200);
    assert.strictEqual(await login("v4@spam.example", attacker), 429);
    // a different source IP is unaffected
    assert.strictEqual(await login("real@user.example", "198.51.100.22"), 200);
    // request-link (device-authed) shares the same per-IP budget → also capped
    const dev = (await api("POST", "/v1/devices/register")).body;
    const reqLink = await fetch(b5 + "/v1/auth/request-link", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": attacker },
      body: JSON.stringify({ ...dev, email: "v5@spam.example" }),
    });
    assert.strictEqual(reqLink.status, 429);
    s5.close();
  });

  // ---------- referrals ----------
  // follow a magic-link from the mailbox and return the web session token
  const loginVia = async (email, referralCode) => {
    await api("POST", "/v1/web/login", referralCode ? { email, referralCode } : { email });
    const link = mailbox.at(-1).link;
    const sess = await api("GET", link.replace(base, ""));
    return sess.headers.get("location").match(/session=([^&]+)/)[1];
  };
  const userId = async (email) =>
    (await poolNs.query("select id from users where email = $1", [email])).rows[0].id;

  await check("the $20 referral program is retired: signup no longer attributes, redemption pays no referrer", async () => {
    // referrer signs up and reads their (still-minted) shareable code
    const refSess = await loginVia("ref-er@example.com");
    const refDash = await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refDash.status, 200);
    const code = refDash.body.code;
    assert.ok(/^[A-Z0-9]{8}$/.test(code), "code is 8 chars");

    // friend signs up WITH the code → NO referral attribution (program retired):
    // no referrals row and no referred_by on the user.
    const friendSess = await loginVia("ref-ee@example.com", code);
    const friendId = await userId("ref-ee@example.com");
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from referrals where referred_user_id = $1", [friendId])).rows[0].n, 0,
      "no referral row is created at signup");
    assert.strictEqual(
      (await poolNs.query("select referred_by from users where id = $1", [friendId])).rows[0].referred_by, null,
      "referred_by is not set at signup");

    // friend earns >$20 on a linked device, then redeems their first gift card
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@ref.co", adLine: "referral funded campaign", url: "https://example.com/",
      brand: "RefCo", pricePerBlock: 110, blocks: 1,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...dev, batchKey: "bref", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    await api("POST", "/v1/auth/request-link", { ...dev, email: "ref-ee@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));

    const red = await api("POST", "/v1/web/redemptions",
      { plan: "pro", months: 1, recipientEmail: "ref-ee@example.com" },
      { Authorization: `Bearer ${friendSess}` });
    assert.strictEqual(red.status, 200);

    // the referrer earns NOTHING — no referral_credit, balance unchanged
    const refMe = await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${refSess}` });
    assert.strictEqual(refMe.body.balanceUsd, 0, "referrer is not paid — the $20 program is retired");
    assert.strictEqual(
      (await poolNs.query(
        "select count(*)::int n from ledger where entry_type = 'referral_credit' and user_id = $1",
        [await userId("ref-er@example.com")])).rows[0].n, 0,
      "no referral_credit ledger entry is ever posted");
  });

  await check("email invites: send + self-refer guard (retired program: no joined/rewarded transitions)", async () => {
    const inviterSess = await loginVia("inviter@example.com");

    // can't invite your own email
    const self = await api("POST", "/v1/web/affiliate/invite", { email: "inviter@example.com" },
      { Authorization: `Bearer ${inviterSess}` });
    assert.strictEqual(self.status, 400);

    // a malformed address is rejected too
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate/invite", { email: "nope" }, { Authorization: `Bearer ${inviterSess}` })).status,
      400);

    // invite a friend to your crew → email goes out and the invite is recorded as 'sent'
    const inv = await api("POST", "/v1/web/affiliate/invite", { email: "invitee@example.com" },
      { Authorization: `Bearer ${inviterSess}` });
    assert.strictEqual(inv.status, 200);
    assert.strictEqual(inv.body.sent, true, "crew invite reports sent:true");
    assert.strictEqual(inv.body.invite.status, "sent");

    // the crew invite went out via the crew-invite mailer (rewardPct, not $20)
    const invMail = mailbox.at(-1);
    assert.strictEqual(invMail.to, "invitee@example.com");
    assert.ok(invMail.rewardPct !== undefined, "crew invite uses sendCrewInviteEmail");
    // the invite link carries the inviter's affiliate code so the friend is
    // attributed to their crew
    const inviterCode = (await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${inviterSess}` })).body.code;
    assert.ok(invMail.link.includes(`ref=${inviterCode}`), "invite link carries the inviter's affiliate code");

    // dashboard now shows the invite under the 'invited' stage, with the email
    // masked so the page never leaks the full address
    let dash = await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${inviterSess}` });
    assert.strictEqual(dash.body.invitedCount, 1);
    const invitedItem = dash.body.referrals.find((r) => r.email === "i•••@example.com");
    assert.ok(invitedItem && invitedItem.status === "invited", "invitee listed as invited (masked)");
    assert.ok(!JSON.stringify(dash.body.referrals).includes("invitee@example.com"), "full email never leaves the server");

    // the $20 referral program is retired: signing up with the code no longer
    // attributes the friend, so the invite stays 'sent' (no 'joined' transition)
    // and no referrals row is created.
    await loginVia("invitee@example.com", inviterCode);
    assert.strictEqual(
      (await poolNs.query("select status from referral_invites where lower(email) = 'invitee@example.com'")).rows[0].status,
      "sent", "retired program: signup does not flip the invite to 'joined'");
    assert.strictEqual(
      (await poolNs.query("select referred_by from users where id = $1", [await userId("invitee@example.com")])).rows[0].referred_by,
      null, "retired program: signup does not attribute the friend");

    // and redeeming never advances the invite to 'rewarded' nor pays the inviter
    const inviteeId = await userId("invitee@example.com");
    await poolNs.query("insert into ledger (entry_type, amount_millicents, user_id) values ('impression_credit', 2200000, $1)", [inviteeId]); // $22: $20 face + 10% fee
    const inviteeSess = await loginVia("invitee@example.com");
    assert.strictEqual(
      (await api("POST", "/v1/web/redemptions", { plan: "pro", months: 1, recipientEmail: "invitee@example.com" },
        { Authorization: `Bearer ${inviteeSess}` })).status, 200);
    assert.strictEqual(
      (await poolNs.query("select status from referral_invites where lower(email) = 'invitee@example.com'")).rows[0].status,
      "sent", "retired program: redemption does not reward the inviter");
    assert.strictEqual(
      (await poolNs.query(
        "select count(*)::int n from ledger where entry_type = 'referral_credit' and user_id = $1",
        [await userId("inviter@example.com")])).rows[0].n, 0,
      "no referral_credit is posted");
    // the redeemer still gets the branded redemption confirmation; the retired
    // referrer is never emailed a bonus.
    assert.ok(mailbox.some((m) => m.to === "invitee@example.com" && m.planName),
      "redeemer receives a gift-card redemption confirmation");
    assert.ok(!mailbox.some((m) => m.to === "inviter@example.com" && m.rewardUsd > 0),
      "retired program: the inviter is not emailed any referral bonus");
  });

  // ---------- first-login onboarding: post-to-X gate ----------
  await check("onboarding post gate: new user needsPost until they confirm the X post; idempotent", async () => {
    const sess = await loginVia("poster@example.com");

    // a brand-new user must post the prebuilt note to X before the dashboard
    // unlocks, so /v1/web/me reports needsPost=true (and no longer needsReferral)
    let me = (await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${sess}` })).body;
    assert.strictEqual(me.needsPost, true, "new user needs to post to X first");
    assert.strictEqual(me.needsReferral, undefined, "needsReferral gate is retired from /v1/web/me");

    // confirming the post clears the gate
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/post", {}, { Authorization: `Bearer ${sess}` })).status, 200);
    assert.strictEqual(
      (await api("GET", "/v1/web/me", undefined, { Authorization: `Bearer ${sess}` })).body.needsPost,
      false, "confirming the post unlocks the dashboard");

    // the confirmation is stamped once and idempotent — re-confirming keeps the
    // original timestamp
    const uid = await userId("poster@example.com");
    const t1 = (await poolNs.query("select onboarding_posted_at from users where id = $1", [uid])).rows[0].onboarding_posted_at;
    assert.ok(t1, "onboarding_posted_at is set");
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/post", {}, { Authorization: `Bearer ${sess}` })).status, 200);
    const t2 = (await poolNs.query("select onboarding_posted_at from users where id = $1", [uid])).rows[0].onboarding_posted_at;
    assert.strictEqual(t2.getTime(), t1.getTime(), "re-confirming preserves the original timestamp");

    // the endpoint requires a session
    assert.strictEqual((await api("POST", "/v1/web/onboarding/post", {})).status, 401);
  });

  // ---------- X (Twitter) OAuth account keying ----------
  await check("twitter oauth: keyed on twitter_id, no email; merges into an email account via verified email only", async () => {
    // X returns no email — a fresh X sign-in creates an emailless account keyed
    // on the numeric X id, and re-signing in returns the same account.
    const a = await repo.upsertUserByOAuth({ twitterId: "x_1001", emailVerified: false }, config.webSessionTtlMs);
    assert.ok(a.sessionToken, "first X sign-in opens a session");
    const uid1 = (await poolNs.query("select id, email from users where twitter_id = 'x_1001'")).rows[0];
    assert.ok(uid1, "account is keyed on twitter_id");
    assert.strictEqual(uid1.email, null, "X account carries no email");

    const b = await repo.upsertUserByOAuth({ twitterId: "x_1001", emailVerified: false }, config.webSessionTtlMs);
    assert.ok(b.sessionToken);
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from users where twitter_id = 'x_1001'")).rows[0].n, 1,
      "re-signing in reuses the same X account (no duplicate)");

    // a Google sign-in with a verified email creates an account; later linking
    // the same verified email via X merges onto it rather than forking a new row
    await repo.upsertUserByOAuth({ googleId: "g_2002", email: "linkme@example.com", emailVerified: true }, config.webSessionTtlMs);
    await repo.upsertUserByOAuth({ twitterId: "x_3003", email: "linkme@example.com", emailVerified: true }, config.webSessionTtlMs);
    const merged = (await poolNs.query("select google_id, twitter_id from users where email = 'linkme@example.com'")).rows;
    assert.strictEqual(merged.length, 1, "verified email merges the X identity onto the existing account");
    assert.strictEqual(merged[0].google_id, "g_2002");
    assert.strictEqual(merged[0].twitter_id, "x_3003", "twitter_id is attached to the merged account");
  });

  // ---------- affiliates ----------
  await check("affiliate: self-serve 10% of an affiliated user's earnings (people cap, uncapped $); upgrade request attaches socials", async () => {
    const affSess = await loginVia("affiliate@example.com");

    // self-serve: every signed-in user is auto-enrolled with a code at the base 10%
    let dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${affSess}` });
    assert.strictEqual(dash.body.enrolled, true);
    const code = dash.body.code;
    assert.ok(/^[A-Z0-9]{8}$/.test(code), "affiliate code is 8 chars");
    assert.strictEqual(dash.body.link, `https://dwellprotocol.com/portal.html?ref=${code}`);
    assert.strictEqual(dash.body.rewardPct, 10);
    assert.strictEqual(dash.body.upgraded, false);
    assert.strictEqual(dash.body.upgradeRequested, false);

    // influencer upgrade form validation: at least one handle, a follower count per handle
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate/apply", {}, { Authorization: `Bearer ${affSess}` })).status,
      400, "no handles rejected");
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate/apply", { instagram: "creator" }, { Authorization: `Bearer ${affSess}` })).status,
      400, "handle without a follower count rejected");

    // submitting socials requests the upgrade without disturbing the active base 10%
    const applied = await api("POST", "/v1/web/affiliate/apply",
      { instagram: "@creator", instagramFollowers: "120,000", twitter: "creator", twitterFollowers: 8000 },
      { Authorization: `Bearer ${affSess}` });
    assert.strictEqual(applied.status, 200);
    assert.strictEqual(applied.body.ok, true);

    dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${affSess}` });
    assert.strictEqual(dash.body.upgradeRequested, true, "socials attached → upgrade requested");
    assert.strictEqual(dash.body.upgraded, false, "still base 10% until an admin grants more");
    assert.strictEqual(dash.body.code, code, "code is unchanged by the upgrade request");

    // admin sees the affiliate with parsed socials
    const list = await api("GET", "/v1/admin/affiliates", undefined, { "X-Admin-Key": "test-admin" });
    const appRow = list.body.affiliates.find((a) => a.email === "affiliate@example.com");
    assert.ok(appRow && appRow.status === "approved");
    assert.strictEqual(appRow.instagram_followers, 120000, "comma-formatted follower count parsed");
    const affId = appRow.id;

    // a new user signs up WITH the affiliate code → attributed to the affiliate,
    // and that attribution is mutually exclusive with referrals (no referred_by)
    const userSess = await loginVia("affuser@example.com", code);
    const affUserId = await userId("affuser@example.com");
    const urow = (await poolNs.query("select affiliate_id, referred_by from users where id = $1", [affUserId])).rows[0];
    assert.strictEqual(urow.affiliate_id, affId);
    assert.strictEqual(urow.referred_by, null, "affiliate and referral attribution are mutually exclusive");
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from affiliate_attributions where affiliated_user_id = $1", [affUserId])).rows[0].n,
      1);

    // the affiliated user earns on a linked device → the affiliate accrues 10%.
    // The device must be linked before earning, since accrual happens at ingest.
    const camp = await api("POST", "/v1/checkout", {
      email: "adv@aff.co", adLine: "affiliate funded campaign", url: "https://example.com/",
      brand: "AffCo", pricePerBlock: 5, blocks: 5,
    });
    await payWebhook(camp.body.campaignId);
    await approve(camp.body.campaignId);
    const dev = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/auth/request-link", { ...dev, email: "affuser@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));
    await api("POST", "/v1/events", { ...dev, batchKey: "baff", events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });

    // dev keeps 90% ($4.50); affiliate earns 10% of that dev credit ($0.45)
    assert.strictEqual((await repo.balanceForUser(affUserId)).balanceMillicents, 450000, "affiliated user keeps 100% of their earnings");
    assert.strictEqual(
      (await repo.balanceForUser(await userId("affiliate@example.com"))).balanceMillicents, 45000,
      "affiliate earns 10% as a platform-funded bonus");

    // people cap: lower this affiliate's cap to 1 (they already have 1 attributed
    // friend). A second distinct user signing up with the code is NOT attributed.
    await poolNs.query("update affiliates set cap_people = 1 where id = $1", [affId]);
    await loginVia("affuser2@example.com", code);
    const affUser2Id = await userId("affuser2@example.com");
    assert.strictEqual(
      (await poolNs.query("select affiliate_id from users where id = $1", [affUser2Id])).rows[0].affiliate_id, null,
      "second user past the people cap is not attributed");
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from affiliate_attributions where affiliate_id = $1", [affId])).rows[0].n, 1,
      "no new attribution row past the people cap");

    // dollar earnings are UNCAPPED: set the affiliate's legacy dollar cap to a low
    // value (the old code would have clamped affiliate credits here) and prove the
    // affiliate now keeps accruing 10% straight past it with no ceiling.
    await poolNs.query("update affiliates set cap_millicents = 50000 where id = $1", [affId]);
    // 3 more batches of 1000 impressions → affiliate +45000 millicents each.
    for (let i = 0; i < 3; i++) {
      await api("POST", "/v1/events", { ...dev, batchKey: `bafflong${i}`, events: [{ campaignId: camp.body.campaignId, impressions: 1000, clicks: 0 }] });
    }
    // started at 45000 millicents; +45000 per batch × 3 = 180000 total.
    const affBal = (await repo.balanceForUser(await userId("affiliate@example.com"))).balanceMillicents;
    assert.strictEqual(affBal, 45000 + 45000 * 3, "affiliate keeps accruing 10% with no dollar ceiling");
    assert.ok(affBal > 50000, "affiliate balance grows past the legacy dollar cap that used to clamp it");
  });

  await check("admin grants an influencer upgrade: custom rate, uncapped people cap, vanity code", async () => {
    const sess = await loginVia("creator@example.com");
    // starts on the self-serve base tier
    let dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(dash.body.rewardPct, 10);
    assert.strictEqual(dash.body.upgraded, false);

    const adminList = (await api("GET", "/v1/admin/affiliates", undefined, { "X-Admin-Key": "test-admin" })).body.affiliates;
    const row = adminList.find((a) => a.email === "creator@example.com");
    const takenCode = adminList.find((a) => a.email === "affiliate@example.com")?.code;

    // validation: rate out of range, and a code another affiliate already owns
    assert.strictEqual(
      (await api("POST", "/v1/admin/affiliates/grant", { affiliateId: row.id, rewardBps: 0, capPeople: 0 }, { "X-Admin-Key": "test-admin" })).status,
      400, "rewardBps must be ≥ 1");
    if (takenCode) assert.strictEqual(
      (await api("POST", "/v1/admin/affiliates/grant", { affiliateId: row.id, rewardBps: 2500, capPeople: 1000000000, code: takenCode }, { "X-Admin-Key": "test-admin" })).status,
      400, "can't take a code another affiliate already owns");

    // grant 25%, uncapped (huge people cap), with a vanity code (case-normalised)
    const granted = await api("POST", "/v1/admin/affiliates/grant",
      { affiliateId: row.id, rewardBps: 2500, capPeople: 1000000000, code: "creator1" },
      { "X-Admin-Key": "test-admin" });
    assert.strictEqual(granted.status, 200);
    assert.strictEqual(granted.body.affiliate.code, "CREATOR1", "vanity code is upper-cased");

    dash = await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(dash.body.rewardPct, 25, "custom rate is live");
    assert.strictEqual(dash.body.upgraded, true);
    assert.strictEqual(dash.body.code, "CREATOR1", "vanity code is the affiliate's link");
    assert.ok(dash.body.capPeople >= 100000, "people cap is effectively unlimited");
  });

  await check("extension auto-links a device to the signed-in web account (no magic link)", async () => {
    const dev = (await api("POST", "/v1/devices/register")).body;
    // Before linking, a "chrome" redeem earns nothing — enforced server-side so a
    // tampered extension can't bank credits the account portal could never show.
    const preServe = await api("POST", "/v1/impressions/serve", { ...dev });
    if (preServe.body.token) {
      const refused = await api("POST", "/v1/impressions/redeem", { ...dev, token: preServe.body.token, source: "chrome" });
      assert.strictEqual(refused.status, 403, "unlinked chrome device is refused");
      assert.strictEqual(refused.body.reason, "unlinked");
    }
    const sess = await loginVia("linkme@example.com");
    // bad device creds and bad session are both rejected
    assert.strictEqual(
      (await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: "wrong", session: sess })).status,
      401, "bad device creds rejected");
    assert.strictEqual(
      (await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, session: "bogus" })).status,
      401, "bad web session rejected");
    // valid creds + session links the device to the user
    assert.strictEqual(
      (await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, session: sess })).status,
      200);
    const uid = await userId("linkme@example.com");
    assert.strictEqual(
      (await poolNs.query("select user_id from devices where id = $1", [dev.deviceId])).rows[0].user_id, uid,
      "device now belongs to the web user");
    // now that it's linked, a "chrome" redeem is accepted and credits the account
    const linkedServe = await api("POST", "/v1/impressions/serve", { ...dev });
    if (linkedServe.body.token) {
      const earned = await api("POST", "/v1/impressions/redeem", { ...dev, token: linkedServe.body.token, source: "chrome" });
      assert.strictEqual(earned.status, 200, "linked chrome device earns");
      assert.strictEqual(earned.body.ok, true);
    }
    // and the device-scoped crew endpoint now reports linked, with a code
    const aff = await api("GET", `/v1/me/affiliate?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`);
    assert.strictEqual(aff.body.linked, true);
    assert.ok(/^[A-Z0-9]{8}$/.test(aff.body.code), "linked device is auto-enrolled with an affiliate code");
    assert.strictEqual(aff.body.crewSize, 10, "crew exposes its 10-slot size");
    assert.deepStrictEqual(aff.body.invited, [], "no pending invites yet");
  });

  await check("crew invite: device-scoped, emails the affiliate link, fills a slot, guards bad input", async () => {
    const dev = (await api("POST", "/v1/devices/register")).body;
    const sess = await loginVia("crewboss@example.com");
    await api("POST", "/v1/devices/link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, session: sess });
    const code = (await api("GET", `/v1/me/affiliate?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body.code;

    // bad device creds are rejected; an unlinked device can't invite
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: "wrong", email: "f@x.com" })).status,
      401, "bad device creds rejected");
    const stranger = (await api("POST", "/v1/devices/register")).body;
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: stranger.deviceId, deviceKey: stranger.deviceKey, email: "f@x.com" })).status,
      401, "unlinked device can't invite");

    // a malformed email and inviting yourself are both rejected
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: "nope" })).status,
      400, "malformed email rejected");
    assert.strictEqual(
      (await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: "crewboss@example.com" })).status,
      400, "can't invite your own email");

    // a valid invite sends the affiliate-link email and records the invite
    mailbox.length = 0;
    const inv = await api("POST", "/v1/me/affiliate/invite", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: "crewmate@example.com" });
    assert.strictEqual(inv.status, 200);
    assert.strictEqual(inv.body.invite.status, "sent");
    const mail = mailbox.find((m) => m.to === "crewmate@example.com");
    assert.ok(mail && mail.link.includes(`ref=${code}`), "invite email carries the affiliate code link");

    // the pending invite now fills a crew slot (masked), still open slots remain
    const crew = (await api("GET", `/v1/me/affiliate?deviceId=${dev.deviceId}&deviceKey=${dev.deviceKey}`)).body;
    assert.strictEqual(crew.invited.length, 1, "pending invite occupies a slot");
    assert.strictEqual(crew.invited[0].email, "c•••@example.com", "invited email is masked");
    assert.ok(!JSON.stringify(crew.invited).includes("crewmate@example.com"), "full email never leaves the server");
  });

  await check("affiliate codes apply retroactively; self/unknown codes rejected (referral program retired)", async () => {
    const affSess = await loginVia("aff2@example.com");
    // self-serve enrollment mints the code straight away (no application/approval)
    const code = (await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${affSess}` })).body.code;
    const row = (await api("GET", "/v1/admin/affiliates", undefined, { "X-Admin-Key": "test-admin" }))
      .body.affiliates.find((a) => a.email === "aff2@example.com");

    // an existing user with no attribution attaches the code retroactively
    const lateSess = await loginVia("late@example.com");
    assert.strictEqual((await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${lateSess}` })).status, 200);
    assert.strictEqual(
      (await poolNs.query("select affiliate_id from users where id = $1", [await userId("late@example.com")])).rows[0].affiliate_id,
      row.id);
    // re-applying once attributed is rejected
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${lateSess}` })).body.reason,
      "already_affiliated");

    // the $20 referral program is retired: signing up with a (referral) code no
    // longer sets referred_by, so such a user is NOT blocked — they can attach an
    // affiliate code like any other unattributed user.
    const refSess = await loginVia("refholder@example.com");
    const refCode = (await api("GET", "/v1/web/referrals", undefined, { Authorization: `Bearer ${refSess}` })).body.code;
    const referredSess = await loginVia("referred-then-aff@example.com", refCode);
    assert.strictEqual(
      (await poolNs.query("select referred_by from users where id = $1", [await userId("referred-then-aff@example.com")])).rows[0].referred_by,
      null, "retired program: no referrer is set at signup");
    const applied = await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${referredSess}` });
    assert.strictEqual(applied.status, 200, "an unattributed user can attach an affiliate code");

    // an affiliate can't self-apply their own code, and unknown codes are rejected
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate-code", { code }, { Authorization: `Bearer ${affSess}` })).body.reason,
      "invalid_code", "can't self-apply your own affiliate code");
    const freshSess = await loginVia("fresh-aff@example.com");
    assert.strictEqual(
      (await api("POST", "/v1/web/affiliate-code", { code: "ZZZZZZZZ" }, { Authorization: `Bearer ${freshSess}` })).body.reason,
      "invalid_code");
  });

  await check("first-login survey: gates the dashboard, validates input, persists answers", async () => {
    const sess = await loginVia("survey@example.com");
    const auth = { Authorization: `Bearer ${sess}` };

    // a brand-new user must complete the survey before anything else
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.needsSurvey, true);

    // empty / unknown-only selections are rejected, and the gate stays up
    assert.strictEqual((await api("POST", "/v1/web/onboarding/survey", {}, auth)).status, 400);
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/survey", { models: ["bogus"], surfaces: ["nope"] }, auth)).status, 400);
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/survey", { models: ["claude"], surfaces: [] }, auth)).status, 400);
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.needsSurvey, true);

    // a valid multi-select submission clears the gate and stores the answers,
    // filtering unknown values and keeping the free-text "other" surface
    const ok = await api("POST", "/v1/web/onboarding/survey",
      { models: ["claude", "chatgpt", "bogus"], surfaces: ["browser_chrome", "other"], surfaceOther: "Raycast" }, auth);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await api("GET", "/v1/web/me", undefined, auth)).body.needsSurvey, false);

    const uid = await userId("survey@example.com");
    const row = (await poolNs.query("select models, surfaces, surface_other from onboarding_surveys where user_id = $1", [uid])).rows[0];
    assert.deepStrictEqual(row.models, ["claude", "chatgpt"], "unknown model filtered out");
    assert.deepStrictEqual(row.surfaces, ["browser_chrome", "other"]);
    assert.strictEqual(row.surface_other, "Raycast");

    // re-answering overwrites (idempotent upsert) and drops the now-irrelevant
    // free text when "other" is no longer selected
    assert.strictEqual(
      (await api("POST", "/v1/web/onboarding/survey", { models: ["gemini"], surfaces: ["terminal"], surfaceOther: "ignored" }, auth)).status, 200);
    const row2 = (await poolNs.query("select models, surfaces, surface_other from onboarding_surveys where user_id = $1", [uid])).rows[0];
    assert.deepStrictEqual(row2.models, ["gemini"]);
    assert.deepStrictEqual(row2.surfaces, ["terminal"]);
    assert.strictEqual(row2.surface_other, null, "surface_other cleared when 'other' not selected");
  });

  // ---------- earnings dashboard + activity ledger ----------
  await check("web earnings endpoint reports today / month / lifetime and a chart series", async () => {
    const sess = await loginVia("earn@example.com");
    const uid = await userId("earn@example.com");

    // seed credits at known times: today, earlier this month, and last month.
    // last-month must be in this user's *month* window only if same month — pick
    // a date guaranteed to be a prior month via interval math so the test is
    // stable regardless of when it runs.
    await poolNs.query(
      `insert into ledger (entry_type, amount_millicents, user_id, created_at) values
         ('impression_credit', 1000000, $1, now()),
         ('click_credit',       500000, $1, date_trunc('month', now())),
         ('referral_credit',   2000000, $1, date_trunc('month', now()) - interval '5 days')`,
      [uid]);

    const e = await api("GET", "/v1/web/earnings?window=30d", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(e.status, 200);
    // today = the now() impression only ($10.00)
    assert.strictEqual(e.body.todayUsd, 10);
    // month-to-date = impression (now) + click (start of month) = $15.00
    assert.strictEqual(e.body.monthUsd, 15);
    // lifetime = all three credits = $35.00
    assert.strictEqual(e.body.lifetimeUsd, 35);
    assert.strictEqual(e.body.window, "30d");
    assert.ok(Array.isArray(e.body.series));
    // at least the now() bucket carries credit within the 30d window
    assert.ok(e.body.series.some((b) => b.usd > 0), "series has a non-zero bucket");

    // window defaults to 7d and switches bucket granularity
    const def = await api("GET", "/v1/web/earnings", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(def.body.window, "7d");
    assert.strictEqual((await api("GET", "/v1/web/earnings")).status, 401);
  });

  await check("web activity ledger lists credited events newest-first, excluding debits", async () => {
    const sess = await loginVia("act@example.com");
    const uid = await userId("act@example.com");
    await poolNs.query(
      `insert into ledger (entry_type, amount_millicents, user_id, created_at) values
         ('impression_credit', 1000000, $1, now() - interval '2 hours'),
         ('referral_credit',   2000000, $1, now() - interval '1 hour'),
         ('gift_redemption_debit', -500000, $1, now())`,
      [uid]);

    const act = await api("GET", "/v1/web/activity", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(act.status, 200);
    assert.strictEqual(act.body.count, 2, "only the two credits, not the debit");
    assert.strictEqual(act.body.rows[0].type, "referral_credit", "newest first");
    assert.strictEqual(act.body.rows[0].amountUsd, 20);
    assert.strictEqual(act.body.rows[1].type, "impression_credit");
    assert.ok(act.body.rows.every((r) => r.type !== "gift_redemption_debit"));
    assert.strictEqual((await api("GET", "/v1/web/activity")).status, 401);
  });

  // ---------- ad-surface waitlists ----------
  await check("web waitlist lets a signed-in user join ad-surface waitlists (idempotent, per-surface)", async () => {
    const sess = await loginVia("wait@example.com");
    const uid = await userId("wait@example.com");

    // catalog lists the four seeded surfaces, none joined yet
    const cat = await api("GET", "/v1/web/waitlist", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(cat.status, 200);
    assert.strictEqual(cat.body.surfaces.length, 4);
    assert.ok(cat.body.surfaces.every((s) => s.joined === false));
    assert.strictEqual(cat.body.surfaces[0].surface, "desktop", "sorted by sort_order");

    // join two surfaces
    const j1 = await api("POST", "/v1/web/waitlist", { surface: "desktop" }, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(j1.status, 200);
    assert.strictEqual(j1.body.joined, true);
    assert.strictEqual(j1.body.alreadyJoined, false);
    await api("POST", "/v1/web/waitlist", { surface: "vscode_extension" }, { Authorization: `Bearer ${sess}` });

    // re-joining a surface is a no-op (no duplicate row)
    const dup = await api("POST", "/v1/web/waitlist", { surface: "desktop" }, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(dup.body.alreadyJoined, true);
    const rows = (await poolNs.query("select surface from waitlist_signups where user_id = $1 order by surface", [uid])).rows;
    assert.deepStrictEqual(rows.map((r) => r.surface), ["desktop", "vscode_extension"]);

    // catalog now reflects the joined state
    const cat2 = await api("GET", "/v1/web/waitlist", undefined, { Authorization: `Bearer ${sess}` });
    assert.strictEqual(cat2.body.surfaces.filter((s) => s.joined).length, 2);

    // unknown surface is rejected; missing session is 401
    assert.strictEqual((await api("POST", "/v1/web/waitlist", { surface: "smoke-signals" }, { Authorization: `Bearer ${sess}` })).status, 400);
    assert.strictEqual((await api("GET", "/v1/web/waitlist")).status, 401);
    assert.strictEqual((await api("POST", "/v1/web/waitlist", { surface: "desktop" })).status, 401);
  });

  // ---------- pre-account email capture (launch waitlist) ----------
  await check("public /v1/waitlist captures a bare email — no auth, normalized, idempotent, validated", async () => {
    // no auth required; a valid email is accepted and recorded as a new lead
    const r1 = await api("POST", "/v1/waitlist", { email: "Lead@Example.com", source: "index" });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.joined, true);
    assert.strictEqual(r1.body.alreadyJoined, false);

    // stored normalized (lowercased/trimmed), kind 'earn', with the source slug
    const rows = (await poolNs.query("select email, kind, source from email_leads where email = $1", ["lead@example.com"])).rows;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, "earn");
    assert.strictEqual(rows[0].source, "index");

    // a new lead also queues a confirmation email (best-effort, created-only)
    assert.strictEqual(
      mailbox.filter((m) => m.kind === "waitlist" && m.to === "lead@example.com").length,
      1, "confirmation email queued once for a new lead"
    );

    // re-submitting the same address (any case) is a clean no-op — no duplicate row
    const dup = await api("POST", "/v1/waitlist", { email: "lead@example.com" });
    assert.strictEqual(dup.status, 200);
    assert.strictEqual(dup.body.alreadyJoined, true);
    assert.strictEqual(
      (await poolNs.query("select count(*)::int n from email_leads where email = $1", ["lead@example.com"])).rows[0].n,
      1
    );
    // the idempotent re-submit must NOT send a second confirmation
    assert.strictEqual(
      mailbox.filter((m) => m.kind === "waitlist" && m.to === "lead@example.com").length,
      1, "re-submit does not send another confirmation"
    );

    // malformed emails are rejected before any insert
    for (const bad of ["", "nope", "a@b", "x@y.", "@example.com"]) {
      assert.strictEqual((await api("POST", "/v1/waitlist", { email: bad })).status, 400, `rejects ${JSON.stringify(bad)}`);
    }
  });

  // ---------- rejection + refund ----------
  await check("rejecting a reviewed campaign refunds via Stripe and posts a refund entry", async () => {
    const r = await api("POST", "/v1/checkout", { email: "spam@x.io", adLine: "questionable ad copy here", url: "https://x.io/", brand: "X", pricePerBlock: 3, blocks: 1 });
    await payWebhook(r.body.campaignId, "pi_reject_1");
    const rej = await api("POST", "/v1/admin/campaigns/reject", { adminKey: "test-admin", campaignId: r.body.campaignId, note: "off-policy" });
    assert.strictEqual(rej.body.refunded, true);
    assert.ok(stripeCalls.find((c) => c.path === "/v1/refunds" && c.params.payment_intent === "pi_reject_1"));
    const st = (await poolNs.query("select status from campaigns where id = $1", [r.body.campaignId])).rows[0].status;
    assert.strictEqual(st, "rejected");
    const refundEntry = await poolNs.query("select count(*)::int n from ledger where campaign_id = $1 and entry_type = 'campaign_refund'", [r.body.campaignId]);
    assert.strictEqual(refundEntry.rows[0].n, 1);
    // the advertiser is emailed about the rejection + refund, with the note
    const rejMail = mailbox.find((m) => m.campaignId === r.body.campaignId && m.note === "off-policy");
    assert.ok(rejMail, "no rejection email sent");
    assert.strictEqual(rejMail.to, "spam@x.io");
  });

  // ---------- XSS escaping on the admin page ----------
  await check("admin moderation page escapes untrusted text", async () => {
    // brand isn't charset-validated at intake, so prove the render path escapes it
    const adv = (await poolNs.query("insert into advertisers (email) values ('x@x.io') returning id")).rows[0].id;
    await poolNs.query(
      `insert into campaigns (advertiser_id, brand, ad_line, url, category, price_per_block_cents, blocks, impressions_total, impressions_remaining, status, paid_at)
       values ($1, $2, 'clean ad line', 'https://x.io/', 'other', 100, 1, 1000, 1000, 'pending_review', now())`,
      [adv, '<img src=x onerror=alert(1)>']);
    const page = await api("GET", "/admin?adminKey=test-admin");
    assert.ok(page.text.includes("&lt;img src=x onerror=alert(1)&gt;"), "brand not escaped");
    assert.ok(!page.text.includes("<img src=x onerror=alert(1)>"), "raw payload present");
    assert.strictEqual((await api("GET", "/admin?adminKey=wrong")).status, 401);
  });

  // ---------- killswitch ----------
  await check("killswitch stops ad serving and flips /v1/config", async () => {
    assert.strictEqual((await api("GET", "/v1/config")).body.serving, true);
    assert.ok((await api("GET", "/v1/ads")).body.ads.length > 0);
    assert.strictEqual((await api("POST", "/v1/admin/killswitch", { adminKey: "nope", serving: false })).status, 401);
    await api("POST", "/v1/admin/killswitch", { adminKey: "test-admin", serving: false });
    assert.strictEqual((await api("GET", "/v1/config")).body.serving, false);
    assert.strictEqual((await api("GET", "/v1/ads")).body.ads.length, 0, "ads served while killed");
    await api("POST", "/v1/admin/killswitch", { adminKey: "test-admin", serving: true });
    assert.ok((await api("GET", "/v1/ads")).body.ads.length > 0, "serving did not resume");
  });

  // ---------- ops guards: body cap + rate limit ----------
  await check("oversized request body returns 413", async () => {
    const huge = JSON.stringify({ blob: "x".repeat(70000) });
    const r = await api("POST", "/v1/checkout", huge);
    assert.strictEqual(r.status, 413);
  });

  await check("rate limiter returns 429 past capacity", async () => {
    const small = createRateLimiter({ capacity: 3, refillPerSec: 0 });
    const { server: s2 } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: small, config });
    await new Promise((r) => s2.listen(0, r));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(b2 + "/healthz")).status);
    s2.close();
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
  });

  // ---------- advertiser metrics, receipts, auto-send (rebuild) ----------
  let metricCamp;
  await check("two checkouts with one email unify under a single advertiser", async () => {
    const mk = (line) => api("POST", "/v1/checkout", {
      email: "metrics@adv.test", adLine: line, url: "https://adv.test/",
      brand: "AdvCo", pricePerBlock: 2, blocks: 1,
    });
    metricCamp = (await mk("metrics campaign one")).body.campaignId;
    await mk("metrics campaign two");
    const { body } = await api("GET", "/v1/admin/advertisers", undefined, { "X-Admin-Key": "test-admin" });
    const rows = body.advertisers.filter((a) => a.email === "metrics@adv.test");
    assert.strictEqual(rows.length, 1, "one advertiser row per email");
    assert.strictEqual(rows[0].campaigns, 2, "both campaigns hang off it");
  });

  await check("per-campaign metrics: clicks, impressions-shown, CPC, eCPM from the ledger", async () => {
    await payWebhook(metricCamp); await approve(metricCamp);
    const d = (await api("POST", "/v1/devices/register")).body;
    // a free verified click is recorded (clicks metric) but draws no budget…
    const intent = await api("POST", "/v1/clicks/intent", { ...d, campaignId: metricCamp });
    await api("GET", `/v1/go/${intent.body.trackingUrl.split("/v1/go/")[1]}`);
    // …then 1000 impressions exhaust the $2 budget on their own (clicks no longer draw it).
    await api("POST", "/v1/events", { ...d, batchKey: "bmetric", events: [{ campaignId: metricCamp, impressions: 1000, clicks: 0 }] });

    const { body } = await api("GET", "/v1/admin/campaigns/all?status=exhausted", undefined, { "X-Admin-Key": "test-admin" });
    const c = body.campaigns.find((x) => x.id === metricCamp);
    assert.ok(c, "exhausted campaign present in the metrics list");
    assert.strictEqual(c.clicks, 1);                      // the free click is still counted
    assert.strictEqual(c.impressionsShown, 1000, "shown = impression_credit.billed, not budget units");
    assert.strictEqual(c.spendUsd, 2);                    // full $2 budget billed out (impressions only)
    assert.strictEqual(c.cpcUsd, 2);                      // spend / clicks
    assert.ok(Math.abs(c.ecpmUsd - 2) < 1e-9);            // spend / shown * 1000 = 2/1000*1000
    // the rollup aggregates the same realized numbers for the advertiser
    const adv = (await api("GET", "/v1/admin/advertisers", undefined, { "X-Admin-Key": "test-admin" })).body
      .advertisers.find((a) => a.email === "metrics@adv.test");
    assert.strictEqual(adv.clicks, 1);
    assert.strictEqual(adv.impressionsShown, 1000);
    assert.strictEqual(adv.spendUsd, 2);
  });

  await check("completion-email builder escapes advertiser-controlled fields", async () => {
    const rm = require("../src/mailer").createMailer({ siteUrl: "https://dwellprotocol.com" });
    const { subject, html } = rm.buildCampaignCompletedEmail({
      adLine: "safe line", brand: "<b>x</b>", campaignId: "id", impressionsShown: 950,
      clicks: 1, ctr: 1 / 950, cpcUsd: 2, ecpmUsd: 2.1, totalPaidUsd: 2,
    });
    assert.ok(subject.includes("wrapped up"));
    assert.ok(html.includes("950"));
    assert.ok(!html.includes("<b>x</b>") && html.includes("&lt;b&gt;"), "brand HTML-escaped");
  });

  await check("receipt preview doesn't stamp; first send stamps once; force resends", async () => {
    const prev = await api("GET", `/v1/admin/campaigns/receipt-preview?campaignId=${metricCamp}`, undefined, { "X-Admin-Key": "test-admin" });
    assert.strictEqual(prev.status, 200);
    assert.strictEqual(prev.body.alreadySent, false);
    assert.strictEqual(prev.body.stats.clicks, 1);
    assert.strictEqual(prev.body.stats.impressionsShown, 1000);
    assert.ok(prev.body.subject.includes("wrapped up"));

    // a still-active campaign can't be sent a completion receipt
    assert.strictEqual((await api("POST", "/v1/admin/campaigns/send-receipt", { adminKey: "test-admin", campaignId: campA })).status, 400);

    const sent = () => mailbox.filter((m) => m.campaignId === metricCamp && m.kind === "campaign_completed").length;
    const s1 = await api("POST", "/v1/admin/campaigns/send-receipt", { adminKey: "test-admin", campaignId: metricCamp });
    assert.strictEqual(s1.status, 200); assert.ok(s1.body.sentAt);
    assert.strictEqual(sent(), 1);
    const mail = mailbox.find((m) => m.campaignId === metricCamp && m.kind === "campaign_completed");
    assert.strictEqual(mail.to, "metrics@adv.test");
    assert.strictEqual(mail.cpcUsd, 2);

    // second send is once-only
    assert.strictEqual((await api("POST", "/v1/admin/campaigns/send-receipt", { adminKey: "test-admin", campaignId: metricCamp })).body.alreadySent, true);
    assert.strictEqual(sent(), 1, "not resent");

    // force resends
    const s3 = await api("POST", "/v1/admin/campaigns/send-receipt", { adminKey: "test-admin", campaignId: metricCamp, force: true });
    assert.ok(s3.body.sentAt);
    assert.strictEqual(sent(), 2);
  });

  await check("receipt auto-send: toggle defaults off + gates the sweep; force + once-only", async () => {
    const ADMIN = { "X-Admin-Key": "test-admin" };
    assert.strictEqual((await api("GET", "/v1/admin/campaigns/receipts-auto", undefined, ADMIN)).body.enabled, false);

    // a fresh exhausted, un-sent campaign
    const cid = (await api("POST", "/v1/checkout", {
      email: "sweep@adv.test", adLine: "sweep regression campaign", url: "https://sweep.example/",
      brand: "Sweep", pricePerBlock: 2, blocks: 1,
    })).body.campaignId;
    await payWebhook(cid); await approve(cid);
    const d = (await api("POST", "/v1/devices/register")).body;
    await api("POST", "/v1/events", { ...d, batchKey: "bsweep", events: [{ campaignId: cid, impressions: 1000, clicks: 0 }] });
    const got = () => mailbox.filter((m) => m.campaignId === cid && m.kind === "campaign_completed").length;

    // off + no force → no-op
    const off = await api("POST", "/v1/admin/campaigns/receipts-sweep", { adminKey: "test-admin" });
    assert.strictEqual(off.body.enabled, false);
    assert.strictEqual(off.body.sent, 0);
    assert.strictEqual(got(), 0, "swept while disabled");

    // force overrides the toggle (the admin "Send now") → sends exactly one
    const forced = await api("POST", "/v1/admin/campaigns/receipts-sweep", { adminKey: "test-admin", force: true });
    assert.ok(forced.body.sent >= 1);
    assert.strictEqual(got(), 1);

    // re-sweep (forced) → already stamped, not resent
    await api("POST", "/v1/admin/campaigns/receipts-sweep", { adminKey: "test-admin", force: true });
    assert.strictEqual(got(), 1, "swept twice");

    // toggle persists (so a scheduled sweep would auto-send), then restore to off
    assert.strictEqual((await api("POST", "/v1/admin/campaigns/receipts-auto", { adminKey: "test-admin", enabled: true })).body.enabled, true);
    assert.strictEqual((await api("GET", "/v1/admin/campaigns/receipts-auto", undefined, ADMIN)).body.enabled, true);
    await api("POST", "/v1/admin/campaigns/receipts-auto", { adminKey: "test-admin", enabled: false });
  });

  // ---------- DWELL token mode (dwell/docs/04) ----------
  // A second app over the SAME database with TOKEN_MODE=points — the DWELL
  // deployment shape. The legacy app above already proved the default path is
  // untouched; these checks prove the split math, the ledger closure, the
  // reserve earmark, and the token routes.
  const cfgToken = {
    ...config,
    tokenMode: "points",
    viewerShareBps: 6000, referrerShareBps: 1000, reserveTrancheBps: 9000,
  };
  const { server: sT } = createApp({ repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgToken });
  await new Promise((r) => sT.listen(0, r));
  const baseT = `http://127.0.0.1:${sT.address().port}`;
  const apiT = async (method, p, body, headers = {}) => {
    const res = await fetch(baseT + p, {
      method, redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };
  const payWebhookT = async (campaignId) => {
    const payload = JSON.stringify({
      id: "evt_" + crypto.randomBytes(6).toString("hex"), type: "checkout.session.completed",
      data: { object: { metadata: { campaign_id: campaignId }, payment_intent: "pi_t_" + crypto.randomBytes(4).toString("hex") } },
    });
    return apiT("POST", "/v1/webhooks/stripe", payload, { "stripe-signature": signWebhookPayload(payload, WEBHOOK_SECRET) });
  };
  // Ledger sums for one campaign, keyed by entry type.
  const campLedger = async (campaignId) => {
    const { rows } = await poolNs.query(
      "select entry_type, coalesce(sum(amount_millicents),0)::bigint as sum, count(*)::int as n from ledger where campaign_id = $1 group by entry_type",
      [campaignId]
    );
    return Object.fromEntries(rows.map((r) => [r.entry_type, { sum: Number(r.sum), n: r.n }]));
  };

  // $1,000 CPM so this campaign outbids everything the earlier checks created
  // (ImpTok bids $999). gross/impression = 100,000 mc → pool 90,000 · viewer
  // 54,000 · referrer 9,000 · protocol 27,000 (referred) / 36,000 (unreferred)
  // · business fee 10,000.
  let campT;
  await check("token mode: funding a campaign earmarks the 90% reserve tranche at payment", async () => {
    const r = await apiT("POST", "/v1/checkout", {
      email: "ads@dwellprotocol.com", adLine: "DWELL funded campaign", url: "https://example.com/",
      brand: "DwellCo", pricePerBlock: 1000, blocks: 5,
    });
    campT = r.body.campaignId;
    await payWebhookT(campT);
    await approve(campT);
    const led = await campLedger(campT);
    assert.strictEqual(led.campaign_credit.sum, 500_000_000, "funded $5,000");
    assert.strictEqual(led.reserve_allocation.sum, 450_000_000, "earmarked exactly 90% of gross");
    assert.strictEqual(led.reserve_allocation.n, 1, "earmarked once (webhook dedupe holds)");
  });

  await check("token mode: unreferred impression splits 60/–/40 of the tranche with ledger closure", async () => {
    const dev = (await apiT("POST", "/v1/devices/register")).body;
    const before = await campLedger(campT);
    const serve = await apiT("POST", "/v1/impressions/serve", { ...dev });
    assert.strictEqual(serve.body.ad.brand, "DwellCo", "token campaign wins the auction");
    const redeem = await apiT("POST", "/v1/impressions/redeem", { ...dev, token: serve.body.token, source: "claude_code" });
    assert.strictEqual(redeem.status, 200);
    assert.strictEqual(redeem.body.creditedMillicents, 54_000, "viewer earns 60% of the 90% pool");
    const led = await campLedger(campT);
    assert.strictEqual(led.points_credit.sum, 54_000);
    assert.strictEqual(led.protocol_points_credit.sum, 36_000, "unreferred: the referrer leg falls to the protocol");
    assert.strictEqual(led.referral_points_credit, undefined, "no referrer row when unattributed");
    assert.strictEqual((led.platform_fee?.sum || 0) - (before.platform_fee?.sum || 0), 10_000, "business 10% keeps the ledger closed");
    assert.strictEqual(led.impression_credit, undefined, "legacy credit type never written in token mode");
    // closure: the four legs sum to the billed gross
    assert.strictEqual(54_000 + 36_000 + 10_000, 100_000);
  });

  await check("token mode: referred viewer routes 10% to the referrer inside the split (no platform-funded bonus)", async () => {
    // referrer signs up, viewer signs up with their code, viewer's device links
    const refSess = await loginVia("dwell-ref@example.com");
    const code = (await api("GET", "/v1/web/affiliate", undefined, { Authorization: `Bearer ${refSess}` })).body.code;
    await loginVia("dwell-viewer@example.com", code);
    const dev = (await apiT("POST", "/v1/devices/register")).body;
    await apiT("POST", "/v1/auth/request-link", { ...dev, email: "dwell-viewer@example.com" });
    await api("GET", mailbox.at(-1).link.replace(base, ""));

    const before = await campLedger(campT);
    const serve = await apiT("POST", "/v1/impressions/serve", { ...dev });
    const redeem = await apiT("POST", "/v1/impressions/redeem", { ...dev, token: serve.body.token, source: "claude_code" });
    assert.strictEqual(redeem.body.creditedMillicents, 54_000, "viewer's share is unchanged by attribution");
    const led = await campLedger(campT);
    assert.strictEqual(led.referral_points_credit.sum, 9_000, "referrer's 10% is carved from the pool");
    assert.strictEqual(led.protocol_points_credit.sum - before.protocol_points_credit.sum, 27_000, "protocol takes 30% when referred");
    assert.strictEqual(led.affiliate_credit, undefined, "the legacy platform-funded bonus is retired in token mode");
    assert.strictEqual(
      (await repo.balanceForUser(await userId("dwell-ref@example.com"))).balanceMillicents, 9_000,
      "referrer's balance sees the points leg");

    // the legacy batch path splits identically (10 impressions in one batch)
    await apiT("POST", "/v1/events", { ...dev, batchKey: "bT", events: [{ campaignId: campT, impressions: 10, clicks: 0 }] });
    const led2 = await campLedger(campT);
    assert.strictEqual(led2.points_credit.sum - led.points_credit.sum, 540_000);
    assert.strictEqual(led2.referral_points_credit.sum - led.referral_points_credit.sum, 90_000);
    assert.strictEqual(led2.protocol_points_credit.sum - led.protocol_points_credit.sum, 270_000);

    // viewer balance = their points (device-scoped credits roll up to the account)
    assert.strictEqual(
      (await repo.balanceForUser(await userId("dwell-viewer@example.com"))).balanceMillicents, 594_000,
      "viewer keeps 54,000 + 540,000 points");
  });

  await check("token mode: reserve invariant holds and /v1/reserve + points summary report it", async () => {
    // per-campaign invariant (dwell/docs/04 §A): accrued legs never exceed the earmark
    const led = await campLedger(campT);
    const accrued = led.points_credit.sum + led.referral_points_credit.sum + led.protocol_points_credit.sum;
    assert.ok(accrued <= led.reserve_allocation.sum, "accrued points ≤ reserve_allocation");

    const r = await apiT("GET", "/v1/reserve");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.mode, "points");
    assert.strictEqual(r.body.allocatedMillicents, 450_000_000);
    assert.strictEqual(r.body.accruedPointsMillicents, accrued);
    assert.strictEqual(r.body.outstandingPointsMillicents, accrued, "nothing claimed yet");
    assert.strictEqual(r.body.escrowedMicroUsdc, 0, "keeper hasn't escrowed anything in tests");

    // the millicent balance IS the points number (1,000 points = $1.00)
    const viewerSess = await loginVia("dwell-viewer@example.com");
    const sum = await apiT("GET", "/v1/web/points/summary", undefined, { Authorization: `Bearer ${viewerSess}` });
    assert.strictEqual(sum.body.points, 594_000);
    assert.strictEqual(sum.body.usdEquivalent, 5.94);
  });

  await check("token routes 404 on the legacy deployment; live-only surfaces answer 409 in points mode", async () => {
    assert.strictEqual((await api("GET", "/v1/reserve")).status, 404, "DWELL deployment exposes no token surface");
    assert.strictEqual((await api("GET", "/v1/token/pools")).status, 404);
    assert.strictEqual((await api("GET", "/v1/web/points/summary")).status, 404);
    assert.strictEqual((await apiT("GET", "/v1/token/pools")).body.pools.length, 0, "pools empty during the points phase");
    const viewerSess = await loginVia("dwell-viewer@example.com");
    assert.strictEqual((await apiT("POST", "/v1/web/wallet", {}, { Authorization: `Bearer ${viewerSess}` })).status, 409, "wallet linking is live-mode only");
    assert.strictEqual((await apiT("GET", "/v1/web/token/claim-proof", undefined, { Authorization: `Bearer ${viewerSess}` })).status, 409);
    assert.strictEqual((await apiT("POST", "/v1/admin/epochs/publish-root", { adminKey: "test-admin" })).status, 409);
    assert.strictEqual((await apiT("POST", "/v1/admin/epochs/publish-root", { adminKey: "wrong" })).status, 401);
  });

  // ---------- USDC advertiser checkout (dwell/docs/08) ----------
  // A third app with the launch gate open (DWELL_MINT set) over the same
  // database, with Solana RPC + Jupiter faked at the fetch layer. The chain
  // object is the test's "blockchain": checks mutate it, then poll.
  const { createSolana, base58Encode, WSOL_MINT, SYSTEM_PROGRAM } = require("../src/solana");
  const pk = () => base58Encode(crypto.randomBytes(32));
  const DWELL_MINT = pk(), USDC_MINT = pk(), TREASURY_ATA = pk(), TREASURY_SOL = pk(), DIST_ATA = pk(), PAYER = pk(), PAYER_USDC = pk();
  const BLOCKHASH = base58Encode(crypto.randomBytes(32));

  const chain = {
    payerUsdc: "100000000000",     // $100k — plenty
    payerSol: "2000000000",        // 2 SOL — plenty
    signatures: [],                // what getSignaturesForAddress returns
    tx: null,                      // what getTransaction returns
    quoteOut: "45000000000",       // Jupiter outAmount for the $90 tranche
    quoteMin: "44550000000",       // otherAmountThreshold (slippage floor)
    solPriceLamports: "500000000", // USDC->wSOL pricing: $100 ≈ 0.5 SOL ($200/SOL)
  };
  const paidTx = ({ reference, fee, dwellOut }) => ({
    slot: 1234, blockTime: 1700000000,
    transaction: { message: { accountKeys: [
      { pubkey: PAYER }, { pubkey: TREASURY_ATA }, { pubkey: DIST_ATA }, { pubkey: reference },
    ] } },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 2, mint: DWELL_MINT, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, uiTokenAmount: { amount: fee } },
        { accountIndex: 2, mint: DWELL_MINT, uiTokenAmount: { amount: dwellOut } },
      ],
    },
  });

  const fakeSolanaFetch = async (url, opts) => {
    const u = String(url);
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.startsWith("http://jup.test/quote")) {
      const q = new URL(u).searchParams;
      // USDC -> wSOL is the SOL rail's pricing quote; everything else is the
      // tranche swap into DWELL.
      const pricingSol = q.get("outputMint") === WSOL_MINT;
      return reply({
        inputMint: q.get("inputMint"), outputMint: q.get("outputMint"),
        inAmount: q.get("amount"),
        outAmount: pricingSol ? chain.solPriceLamports : chain.quoteOut,
        otherAmountThreshold: pricingSol ? chain.solPriceLamports : chain.quoteMin,
        swapMode: "ExactIn",
      });
    }
    if (u.startsWith("http://jup.test/swap-instructions")) {
      const req = JSON.parse(opts.body);
      return reply({
        computeBudgetInstructions: [],
        setupInstructions: [],
        swapInstruction: {
          programId: base58Encode(Buffer.alloc(32, 7)), // stand-in router program
          accounts: [
            { pubkey: req.userPublicKey, isSigner: true, isWritable: true },
            { pubkey: PAYER_USDC, isSigner: false, isWritable: true },
            { pubkey: req.destinationTokenAccount, isSigner: false, isWritable: true },
          ],
          data: Buffer.from("swap").toString("base64"),
        },
        cleanupInstruction: null,
        addressLookupTableAddresses: [],
      });
    }
    // Solana JSON-RPC
    const { method, params } = JSON.parse(opts.body);
    const rpcReply = (result) => reply({ jsonrpc: "2.0", id: 1, result });
    if (method === "getTokenAccountsByOwner") {
      return rpcReply({ value: [{ pubkey: PAYER_USDC, account: { data: { parsed: { info: { tokenAmount: { amount: chain.payerUsdc } } } } } }] });
    }
    if (method === "getLatestBlockhash") return rpcReply({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } });
    if (method === "getBalance") return rpcReply({ value: Number(chain.payerSol) });
    if (method === "getSignaturesForAddress") return rpcReply(chain.signatures.map((signature) => ({ signature })));
    if (method === "getTransaction") return rpcReply(chain.tx);
    throw new Error("unexpected rpc method " + method);
  };

  const cfgUsdc = {
    ...cfgToken, tokenMode: "live",
    dwellMint: DWELL_MINT, usdcMint: USDC_MINT,
    treasuryUsdcAta: TREASURY_ATA, treasurySolAccount: TREASURY_SOL, distributorDwellAta: DIST_ATA,
    solanaRpcUrl: "http://solana.test", jupiterBaseUrl: "http://jup.test",
    maxSlippageBps: 100, usdcOrderTtlMinutes: 30, brandName: "DWELL",
  };
  const { server: sU } = createApp({
    repo, stripe, mailer: fakeMailer, rateLimiter: bigLimiter, config: cfgUsdc,
    solana: createSolana({ config: cfgUsdc, fetchImpl: fakeSolanaFetch }),
  });
  await new Promise((r) => sU.listen(0, r));
  const baseU = `http://127.0.0.1:${sU.address().port}`;
  cfgUsdc.apiBaseUrl = baseU;
  const apiU = async (method, p, body, headers = {}) => {
    const res = await fetch(baseU + p, {
      method, redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };
  const usdcAd = {
    email: "crypto-ads@example.com", adLine: "Jupiter — the swap that routes everything",
    url: "https://jup.ag", budget: 100, cpm: 15, showOnLeaderboard: true,
  };

  await check("usdc checkout: gated off everywhere the mint isn't configured", async () => {
    assert.strictEqual((await api("POST", "/v1/checkout" /* legacy app sanity */, {})).status, 400);
    assert.strictEqual((await api("POST", "/v1/ads/usdc/orders", usdcAd)).status, 404, "legacy deployment: no surface");
    assert.strictEqual((await apiT("POST", "/v1/ads/usdc/orders", usdcAd)).status, 404, "points app without DWELL_MINT: no surface");
    assert.strictEqual((await apiT("GET", "/v1/ads/usdc/orders/x")).status, 404);
  });

  let orderU;
  await check("usdc checkout: order prices the exact 90/10 split and quotes the swap", async () => {
    const bad = await apiU("POST", "/v1/ads/usdc/orders", { ...usdcAd, email: "nope" });
    assert.strictEqual(bad.status, 400);
    const tiny = await apiU("POST", "/v1/ads/usdc/orders", { ...usdcAd, budget: 1 });
    assert.strictEqual(tiny.status, 400, "budget floor enforced");

    const r = await apiU("POST", "/v1/ads/usdc/orders", usdcAd);
    assert.strictEqual(r.status, 200);
    orderU = r.body;
    assert.strictEqual(orderU.priceUsdc, 100, "$100 gross");
    assert.strictEqual(orderU.feeUsdc, 10, "the protocol's 10%, same cut as the card path");
    assert.strictEqual(orderU.trancheUsdc, 90, "90% is the DWELL buy");
    assert.strictEqual(orderU.estDwellOut, "45000000000");
    assert.strictEqual(orderU.minDwellOut, "44550000000", "slippage floor rides the order");
    assert.ok(orderU.solanaPayUrl.startsWith("solana:"), "Solana Pay transaction-request link");
    assert.ok(orderU.orderId && orderU.campaignId && orderU.expiresAt);
  });

  await check("usdc checkout: build returns one atomic unsigned legacy transaction", async () => {
    const meta = await apiU("GET", `/v1/ads/usdc/orders/${orderU.orderId}/transaction`);
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(meta.body.label, "DWELL ad campaign");

    const noAcct = await apiU("POST", `/v1/ads/usdc/orders/${orderU.orderId}/transaction`, { account: "not-a-key" });
    assert.strictEqual(noAcct.status, 400);

    const r = await apiU("POST", `/v1/ads/usdc/orders/${orderU.orderId}/transaction`, { account: PAYER });
    assert.strictEqual(r.status, 200);
    assert.ok(/protocol fee/.test(r.body.message), "wallet-facing message states the mechanics");
    const tx = Buffer.from(r.body.transaction, "base64");
    assert.strictEqual(tx[0], 1, "exactly one required signature — the advertiser");
    assert.ok(tx.subarray(1, 65).every((b) => b === 0), "signature slot unsigned — the backend never signs");
    const { body: ord } = await apiU("GET", `/v1/ads/usdc/orders/${orderU.orderId}`);
    const msg = tx.subarray(65);
    const has = (b58) => msg.includes(require("../src/solana").base58Decode(b58));
    assert.ok(has(PAYER), "payer is fee payer");
    assert.ok(has(TREASURY_ATA), "fee leg targets the treasury vault");
    assert.ok(has(DIST_ATA), "swap output targets the distributor vault");
    assert.ok(has(ord.reference), "Solana Pay reference key rides the transaction");
    assert.ok(msg.includes(Buffer.from(`dwell-usdc-order:${orderU.orderId}`)), "order-id memo");
  });

  await check("usdc checkout: unpaid order stays awaiting; verified payment funds the campaign", async () => {
    let r = await apiU("GET", `/v1/ads/usdc/orders/${orderU.orderId}`);
    assert.strictEqual(r.body.status, "awaiting_signature", "nothing on-chain yet");

    // The advertiser signs; the transaction lands with the right amounts.
    const sig = "sig_" + crypto.randomBytes(8).toString("hex");
    chain.signatures = [sig];
    chain.tx = paidTx({ reference: r.body.reference, fee: "10000000", dwellOut: "45000000000" });

    r = await apiU("GET", `/v1/ads/usdc/orders/${orderU.orderId}`);
    assert.strictEqual(r.body.status, "confirmed");
    assert.strictEqual(r.body.txSignature, sig);
    assert.strictEqual(r.body.campaignStatus, "pending_review", "paid -> human review, same as the card path");
    assert.strictEqual(mailbox.at(-1).to, "crypto-ads@example.com", "advertiser receipt sent");

    // Ledger closure: campaign_credit = the exact $100; reserve_allocation = the 90% tranche.
    const led = await campLedger(orderU.campaignId);
    assert.strictEqual(led.campaign_credit.sum, 10_000_000, "$100 in millicents");
    assert.strictEqual(led.reserve_allocation.sum, 9_000_000, "the 90% earmark");

    // Locked rate (docs/01): dwellOut × 60% ÷ impressions; $100 @ $15 CPM = 6,666 impressions.
    const pools = await apiU("GET", "/v1/token/pools");
    const pool_ = pools.body.pools.find((p) => p.campaignId === orderU.campaignId);
    assert.ok(pool_, "token_campaign_pools row written");
    assert.strictEqual(pool_.usdcInMicro, 90_000_000, "the swap leg in micro-USDC");
    assert.strictEqual(pool_.dwellOutWei, "45000000000");
    assert.strictEqual(pool_.toDistributorWei, "45000000000", "all bought DWELL to the distributor; treasury settles via the shortfall leaf");
    assert.strictEqual(pool_.lockedRateWei, String((45000000000n * 6000n) / 10000n / 6666n));
    assert.strictEqual(pool_.txHash, sig);

    // Idempotent: polling again changes nothing.
    const again = await apiU("GET", `/v1/ads/usdc/orders/${orderU.orderId}`);
    assert.strictEqual(again.body.status, "confirmed");
    assert.strictEqual((await campLedger(orderU.campaignId)).campaign_credit.n, 1, "one funding entry, ever");

    // A confirmed order can't be rebuilt.
    assert.strictEqual((await apiU("POST", `/v1/ads/usdc/orders/${orderU.orderId}/transaction`, { account: PAYER })).status, 409);
  });

  await check("usdc checkout: a landed transaction that shorts the fee fails the order", async () => {
    chain.signatures = []; chain.tx = null;
    const r = await apiU("POST", "/v1/ads/usdc/orders", usdcAd);
    const sig = "sig_" + crypto.randomBytes(8).toString("hex");
    chain.signatures = [sig];
    const { body: ord } = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    // (first poll saw an empty chain in the race above — set the bad tx now)
    chain.tx = paidTx({ reference: ord.reference, fee: "9000000", dwellOut: "45000000000" }); // $9 < $10
    const after = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    assert.strictEqual(after.body.status, "failed");
    assert.strictEqual(after.body.failReason, "fee_short");
    assert.strictEqual((await campLedger(r.body.campaignId)).campaign_credit, undefined, "no funding on a bad payment");
    chain.signatures = []; chain.tx = null;
  });

  await check("usdc checkout: orders expire; expired orders can't build", async () => {
    const r = await apiU("POST", "/v1/ads/usdc/orders", usdcAd);
    await poolNs.query("update usdc_orders set expires_at = now() - interval '1 minute' where id = $1", [r.body.orderId]);
    const got = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    assert.strictEqual(got.body.status, "expired", "lazy expiry on read — nothing on-chain, nothing to clean up");
    assert.strictEqual((await apiU("POST", `/v1/ads/usdc/orders/${r.body.orderId}/transaction`, { account: PAYER })).status, 410);
  });

  // A landed SOL payment: native lamport deltas on the treasury (fee leg) +
  // the DWELL token delta on the distributor (swap leg).
  const paidSolTx = ({ reference, feeLamports, dwellOut }) => ({
    slot: 1235, blockTime: 1700000100,
    transaction: { message: { accountKeys: [
      { pubkey: PAYER }, { pubkey: TREASURY_SOL }, { pubkey: DIST_ATA }, { pubkey: reference },
    ] } },
    meta: {
      err: null,
      preBalances: [2000000000, 0, 0, 0],
      postBalances: [2000000000 - Number(feeLamports), Number(feeLamports), 0, 0],
      preTokenBalances: [{ accountIndex: 2, mint: DWELL_MINT, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: DWELL_MINT, uiTokenAmount: { amount: dwellOut } }],
    },
  });

  await check("sol rail: USD-priced order pays a native fee leg in one atomic transaction", async () => {
    // Gate: without a treasury SOL account, SOL orders are refused (configs are
    // read at request time, so flip the knob in place).
    cfgUsdc.treasurySolAccount = "";
    assert.strictEqual((await apiU("POST", "/v1/ads/usdc/orders", { ...usdcAd, currency: "sol" })).status, 400);
    cfgUsdc.treasurySolAccount = TREASURY_SOL;

    chain.signatures = []; chain.tx = null;
    const r = await apiU("POST", "/v1/ads/usdc/orders", { ...usdcAd, currency: "sol" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.payCurrency, "sol");
    assert.strictEqual(r.body.priceUsdc, 100, "pricing stays USD on every rail");
    assert.strictEqual(r.body.feeUsdc, 10, "same 10% cut");
    assert.strictEqual(r.body.estPayTotalSol, 0.5, "$100 ≈ 0.5 SOL at the pricing quote");

    const built = await apiU("POST", `/v1/ads/usdc/orders/${r.body.orderId}/transaction`, { account: PAYER });
    assert.strictEqual(built.status, 200);
    assert.ok(/≈ 0\.5000 SOL/.test(built.body.message), "wallet message shows the SOL estimate");
    const tx = Buffer.from(built.body.transaction, "base64");
    assert.strictEqual(tx[0], 1, "still exactly one signer — the advertiser");
    const msg = tx.subarray(65);
    const has = (b58) => msg.includes(require("../src/solana").base58Decode(b58));
    assert.ok(has(SYSTEM_PROGRAM), "native transfer instruction present");
    assert.ok(has(TREASURY_SOL), "fee leg targets the treasury's SOL account");
    assert.ok(has(DIST_ATA), "swap output still targets the distributor vault");

    // The advertiser signs; the transaction lands with the right amounts.
    const { body: ord } = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    assert.strictEqual(ord.payFeeUnits, "50000000", "10% of 0.5 SOL in lamports");
    const sig = "sig_" + crypto.randomBytes(8).toString("hex");
    chain.signatures = [sig];
    chain.tx = paidSolTx({ reference: ord.reference, feeLamports: "50000000", dwellOut: "45000000000" });
    const after = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    assert.strictEqual(after.body.status, "confirmed");
    assert.strictEqual(after.body.campaignStatus, "pending_review");

    // Ledger + pool identical to the USDC rail: USD-exact funding, locked rate.
    const led = await campLedger(r.body.campaignId);
    assert.strictEqual(led.campaign_credit.sum, 10_000_000, "$100 in millicents");
    assert.strictEqual(led.reserve_allocation.sum, 9_000_000, "the 90% earmark");
    const pools = await apiU("GET", "/v1/token/pools");
    const pool_ = pools.body.pools.find((p) => p.campaignId === r.body.campaignId);
    assert.strictEqual(pool_.usdcInMicro, 90_000_000, "swap leg recorded at its USD value");
    assert.strictEqual(pool_.dwellOutWei, "45000000000");
    chain.signatures = []; chain.tx = null;
  });

  await check("sol rail: a landed transaction that shorts the native fee fails the order", async () => {
    const r = await apiU("POST", "/v1/ads/usdc/orders", { ...usdcAd, currency: "sol" });
    const { body: ord } = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    const sig = "sig_" + crypto.randomBytes(8).toString("hex");
    chain.signatures = [sig];
    chain.tx = paidSolTx({ reference: ord.reference, feeLamports: "40000000", dwellOut: "45000000000" }); // 0.04 < 0.05 SOL
    const after = await apiU("GET", `/v1/ads/usdc/orders/${r.body.orderId}`);
    assert.strictEqual(after.body.status, "failed");
    assert.strictEqual(after.body.failReason, "fee_short");
    assert.strictEqual((await campLedger(r.body.campaignId)).campaign_credit, undefined, "no funding on a short fee");
    chain.signatures = []; chain.tx = null;
  });

  sU.close();
  sT.close();

  // ---------- cleanup ----------
  server.close();
  await poolNs.end();
  await pool.query(`drop schema ${ns} cascade`);
  await pool.end();
  console.log(`\nall ${pass} checks passed — paid, moderated, deduped, escaped, and 90% to the dev. 🤑`);
})().catch((err) => {
  console.error("\n✗ FAILED:", err.stack || err.message);
  process.exit(1);
});
