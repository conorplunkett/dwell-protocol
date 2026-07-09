// DWELL API — plain node:http, no framework.
// Dependency-injected ({ repo, stripe, mailer, rateLimiter, config }) so the test
// harness runs the real routes against a real database with fake Stripe/mail.

const http = require("node:http");
const crypto = require("node:crypto");
const { verifyWebhookSignature } = require("./stripe");
const { GIFT_PLANS, GIFT_MONTHS, giftPriceCents } = require("./giftcards");
const { runPayouts } = require("./payouts");
const { escapeHtml, isCleanAdLine, normalizeHexColor } = require("./util");
const { WSOL_MINT } = require("./solana");

// Crew = the affiliate "earn with your friends" panel in the extension popup.
// Ten slots: each is a joined friend, a pending invite, or an open invite form.
const CREW_SIZE = 10;

// Validate + normalize an affiliate application's socials. At least one of
// Instagram / LinkedIn / Twitter is required, and every handle provided must
// carry a non-negative follower count. Handles are trimmed, '@'-stripped, and
// length-bounded. Returns { socials } or { error }.
function parseAffiliateSocials(body) {
  const b = body || {};
  const handle = (v) => {
    const s = String(v ?? "").trim().replace(/^@+/, "").slice(0, 60);
    return s || null;
  };
  const platforms = [
    ["instagram", "instagramFollowers", "Instagram"],
    ["linkedin", "linkedinFollowers", "LinkedIn"],
    ["twitter", "twitterFollowers", "Twitter"],
  ];
  const socials = {};
  let any = false;
  for (const [hKey, fKey, label] of platforms) {
    const h = handle(b[hKey]);
    socials[hKey] = h;
    socials[fKey] = null;
    if (!h) continue;
    any = true;
    const raw = b[fKey];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? "").replace(/[,\s]/g, ""), 10);
    if (!Number.isFinite(n) || n < 0) return { error: `${label} follower count is required` };
    socials[fKey] = Math.floor(n);
  }
  if (!any) return { error: "add at least one social handle (Instagram, LinkedIn, or Twitter)" };
  return { socials };
}

// Millicents -> USD (all ledger money is millicents, 1/1000 cent).
const mcUsd = (v) => Number(v || 0) / 100000;
// Realized per-campaign/advertiser metrics from raw ledger sums. eCPM and CTR use
// impressions *shown* (impression_credit.meta.billed), never budget units — a
// clicks no longer bill (recorded as a zero-value click_event); spend is impression
// money, and clicks are counted separately for CTR/CPC.
function adMetrics(spendMc, impressionsShown, clicks) {
  const spendUsd = mcUsd(spendMc), imp = Number(impressionsShown || 0), clk = Number(clicks || 0);
  return {
    spendUsd, impressionsShown: imp, clicks: clk,
    ctr: imp > 0 ? clk / imp : null,
    cpcUsd: clk > 0 ? spendUsd / clk : null,
    ecpmUsd: imp > 0 ? (spendUsd / imp) * 1000 : null,
  };
}

// Shape one campaignReceiptData row into the advertiser-facing receipt stats used
// by both the preview and the sent email. Total spent = budget_cents when present
// (budget+CPM campaigns), else the legacy price_per_block_cents * blocks.
function receiptStats(row) {
  const m = adMetrics(row.recognized_millicents, row.impressions_shown, row.clicks);
  const totalPaidUsd = row.budget_cents != null
    ? Number(row.budget_cents) / 100
    : (Number(row.price_per_block_cents) * Number(row.blocks)) / 100;
  return {
    campaignId: row.id, brand: row.brand, adLine: row.ad_line, url: row.url, status: row.status,
    impressionsShown: m.impressionsShown, clicks: m.clicks, ctr: m.ctr,
    cpcUsd: m.cpcUsd, ecpmUsd: m.ecpmUsd, spendUsd: m.spendUsd, totalPaidUsd,
    impressionsTotal: Number(row.impressions_total),
    advertiserEmail: row.advertiser_email, completionEmailSentAt: row.completion_email_sent_at,
    createdAt: row.created_at, activatedAt: row.activated_at,
  };
}

function createApp({ repo, stripe, mailer, rateLimiter, config, solana }) {
  // USDC checkout helpers (dwell/docs/08). Lazily created so legacy callers
  // (and tests that don't exercise the surface) need not pass one in.
  if (!solana) solana = require("./solana").createSolana({ config });
  // Killswitch: when off, /v1/config tells extensions to stop serving and
  // /v1/ads returns an empty list (covers older extensions that never check
  // config). Toggled at runtime by an admin; resets to the env default
  // (KILLSWITCH) on restart.
  let serving = !config.killswitch;

  const exact = new Map();
  const params = []; // { method, regex, keys, handler }

  function route(method, path, handler) {
    if (path.includes(":")) {
      const keys = [];
      const regex = new RegExp(
        "^" + path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$"
      );
      params.push({ method, regex, keys, handler });
    } else {
      exact.set(`${method} ${path}`, handler);
    }
  }

  const CORS = {
    "Access-Control-Allow-Origin": config.corsOrigin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key,X-Device-Id,X-Device-Key,Authorization",
    "Access-Control-Max-Age": "86400",
  };
  const json = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { ...CORS, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  };
  const redirect = (res, url) => { res.writeHead(302, { ...CORS, Location: url }); res.end(); };
  const html = (res, status, body) => {
    res.writeHead(status, { ...CORS, "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  };

  async function authDeviceFrom(body, query, headers) {
    // Header creds preferred, so the deviceKey bearer secret can stay out of the
    // URL query string (which leaks into access logs). Body/query kept for compat.
    const deviceId = headers?.["x-device-id"] || body?.deviceId || query?.get("deviceId");
    const deviceKey = headers?.["x-device-key"] || body?.deviceKey || query?.get("deviceKey");
    return repo.authDevice(deviceId, deviceKey);
  }
  // Constant-time compare so the admin key can't be recovered byte-by-byte via
  // response timing. Length-guarded (timingSafeEqual throws on unequal lengths).
  function adminKeyEqual(key) {
    if (!config.adminKey || !key) return false;
    const a = Buffer.from(String(key), "utf8");
    const b = Buffer.from(String(config.adminKey), "utf8");
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  }
  function adminOk(req, body, query) {
    const key = req.headers["x-admin-key"] || body?.adminKey || query?.get("adminKey");
    return adminKeyEqual(key);
  }
  // Client IP from the proxy header (Fly/CDN) or the socket. Used for rate
  // limiting and — hashed, never stored raw — for the per-IP fraud cap.
  function clientIp(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  }
  function hashIp(req) {
    const ip = clientIp(req);
    return ip ? crypto.createHmac("sha256", config.adminKey || "ip-salt").update(ip).digest("hex") : null;
  }

  // DWELL token mode (dwell/docs/04): when TOKEN_MODE is set (the DWELL
  // deployment), impressions split three ways into points entries instead of
  // the legacy two-way credit, and the token routes below come alive. Absent
  // (the DWELL deployment, and legacy test configs) everything is unchanged.
  const tokenSplit = config.tokenMode
    ? {
        reserveTrancheBps: config.reserveTrancheBps ?? 9000,
        viewerShareBps: config.viewerShareBps ?? 6000,
        referrerShareBps: config.referrerShareBps ?? 1000,
      }
    : null;
  // What clients should read as "my cut" for their own estimate math. In token
  // mode the legacy two-way config.revenueShare (0.5) is never what's actually
  // credited — creditTokenSplit() ignores it entirely — so exposing it here
  // would understate the real viewer share (reserveTranche × viewerShare).
  const displayRevenueShare = tokenSplit
    ? (tokenSplit.reserveTrancheBps / 10000) * (tokenSplit.viewerShareBps / 10000)
    : config.revenueShare;

  // ---------- health & catalog ----------
  route("GET", "/healthz", async (req, res) => json(res, 200, { ok: true }));

  route("GET", "/v1/config", async (req, res) => {
    let leaderboardPublic = false, liveTopCpm = false, adNoticeVisible = false;
    try { leaderboardPublic = (await repo.getSetting("leaderboard_public")) === true; } catch { /* settings table absent */ }
    try { liveTopCpm = (await repo.getSetting("live_top_cpm")) === true; } catch { /* settings table absent */ }
    try { adNoticeVisible = (await repo.getSetting("ad_notice_visible")) === true; } catch { /* settings table absent */ }
    json(res, 200, { serving, revenueShare: displayRevenueShare, leaderboardPublic, liveTopCpm, adNoticeVisible, ...(config.tokenMode ? { tokenMode: config.tokenMode } : {}) });
  });

  route("GET", "/v1/ads", async (req, res) => {
    const ads = serving ? await repo.activeAds() : [];
    json(res, 200, {
      revenueShare: displayRevenueShare,
      ads: ads.map((a) => ({ id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined })),
    });
  });

  route("GET", "/v1/leaderboard", async (req, res) => {
    const rows = await repo.leaderboard();
    json(res, 200, { leaderboard: rows.map((r, i) => ({ rank: i + 1, brand: r.brand, line: r.ad_line })) });
  });

  // ---------- devices & events ----------
  route("POST", "/v1/devices/register", async (req, res) => {
    json(res, 200, await repo.registerDevice());
  });

  // Self-serve device→account link: the extension's dwellprotocol.com bridge posts the
  // device creds + the site's web session; attach the device to that user and
  // enroll them as an affiliate so the popup's crew lights up. No magic link.
  route("POST", "/v1/devices/link", async (req, res, body, rawBody, query) => {
    const device = await authDeviceFrom(body, query);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    await repo.linkDeviceToUser(device.id, user.id);
    await repo.getOrCreateAffiliate(user.id);
    json(res, 200, { ok: true });
  });

  route("POST", "/v1/events", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    // A client on the server-authoritative impression-token path must NOT also
    // post self-reported batches (that would double-credit the same views). It
    // advertises the capability, so we refuse its legacy batches outright.
    if (Array.isArray(body.capabilities) && body.capabilities.includes("impression_tokens")) {
      return json(res, 409, { error: "migrated client must use /v1/impressions/serve+redeem" });
    }
    if (!body.batchKey || !Array.isArray(body.events)) {
      return json(res, 400, { error: "batchKey and events[] required" });
    }
    try {
      const result = await repo.ingestBatch({
        deviceId: device.id, batchKey: body.batchKey, events: body.events,
        // Which product reported this batch (chrome / claude_code / desktop), so a
        // credit can be attributed to its surface; ignored unless allow-listed.
        source: ["chrome", "claude_code", "desktop"].includes(body.source) ? body.source : null,
        revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
        ipHash: hashIp(req), ipDailyCap: config.ipDailyImpressionCap,
        tokenSplit,
      });
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err.code === "CAP_EXCEEDED") return json(res, 429, { error: "daily impression cap exceeded" });
      throw err;
    }
  });

  // ---------- server-side clicks ----------
  // The extension asks for a single-use token (authenticated), then points the
  // ad link at /v1/go/:token. Clicks can't be forged by editing the URL.
  route("POST", "/v1/clicks/intent", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.campaignId) return json(res, 400, { error: "campaignId required" });
    const token = await repo.createClickToken(body.campaignId, device.id, config.clickTokenTtlMs);
    if (!token) return json(res, 404, { error: "campaign not active" });
    json(res, 200, { trackingUrl: `${config.apiBaseUrl}/v1/go/${token}` });
  });

  route("GET", "/v1/go/:token", async (req, res, body, rawBody, query, p) => {
    const result = await repo.redeemClickToken(p.token, config.dailyClickCap);
    redirect(res, result?.url || config.siteUrl);
  });

  // ---------- server-authoritative impressions ----------
  // serve: the server picks the auction winner and mints a single-use token for
  // THIS device; redeem: after the qualifying dwell, bill that impression once.
  // Forged/inflated counts are impossible — every billed impression maps to a
  // server serve. Runs alongside /v1/events until every client has migrated.
  route("POST", "/v1/impressions/serve", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!serving) return json(res, 200, { ad: null, serving: false });
    const result = await repo.serveImpression({
      deviceId: device.id, ipHash: hashIp(req), ttlMs: config.impressionTokenTtlMs,
      dailyCap: config.dailyImpressionCap, ipDailyCap: config.ipDailyImpressionCap,
    });
    if (result.capped) return json(res, 200, { ad: null, capped: true });
    if (!result.ad) return json(res, 200, { ad: null });
    const a = result.ad;
    json(res, 200, {
      token: result.token,
      ad: { id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined },
      revenueShare: displayRevenueShare,
    });
  });

  route("POST", "/v1/impressions/redeem", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.token) return json(res, 400, { error: "token required" });
    const source = ["chrome", "claude_code", "desktop"].includes(body.source) ? body.source : null;
    // The browser extension earns nothing until its device is linked to an
    // account. Enforced here (not just client-side) so a tampered extension
    // can't accrue credits the account-scoped web portal could never show —
    // the mismatch behind "popup says $0.20, portal says $0". Other clients
    // (terminal, desktop) keep the device-scoped model and are unaffected.
    if (source === "chrome" && !(await repo.userForDevice(device.id))) {
      return json(res, 403, { ok: false, reason: "unlinked" });
    }
    const result = await repo.redeemImpression({
      token: body.token, deviceId: device.id, revenueShare: config.revenueShare,
      minDwellMs: config.impressionMinDwellMs,
      source, tokenSplit,
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409; // used / expired / too_soon
      return json(res, status, { ok: false, reason: result.reason });
    }
    json(res, 200, { ok: true, creditedMillicents: result.creditedMillicents });
  });

  // ---------- DWELL token mode (dwell/docs/04 §D) ----------
  // Every route here 404s when TOKEN_MODE is unset, so the DWELL deployment
  // exposes no token surface at all. Wallet linking and claims are live-mode
  // only; in points mode they answer 409 so clients can show "at launch".
  const tokenModeOff = (res) => json(res, 404, { error: "not found" });
  const liveOnly = (res) =>
    config.tokenMode === "live"
      ? json(res, 501, { error: "not implemented — ships with the TGE tooling" })
      : json(res, 409, { error: "live mode only — points phase is accrual-only" });

  // Public reserve attestation: escrowed USDC vs. outstanding points.
  route("GET", "/v1/reserve", async (req, res) => {
    if (!config.tokenMode) return tokenModeOff(res);
    const r = await repo.reserveStatus();
    json(res, 200, { mode: config.tokenMode, ...r, updatedAt: new Date().toISOString() });
  });

  // Public: funded campaign pools + locked rates (live mode fills this via the
  // indexer; empty during the points phase).
  route("GET", "/v1/token/pools", async (req, res, body, rawBody, query) => {
    if (!config.tokenMode) return tokenModeOff(res);
    json(res, 200, { pools: await repo.tokenCampaignPools(query.get("limit")) });
  });

  // Points balance for the signed-in user — the portal balance card. The
  // millicent balance IS the points number (1,000 points = $1.00).
  route("GET", "/v1/web/points/summary", async (req, res, body, rawBody, query) => {
    if (!config.tokenMode) return tokenModeOff(res);
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const e = await repo.earningsForUser(user.id);
    json(res, 200, {
      mode: config.tokenMode,
      points: e.balanceMillicents,
      usdEquivalent: e.balanceMillicents / 100000,
      todayPoints: e.todayMillicents,
      monthPoints: e.monthMillicents,
      lifetimePoints: e.lifetimeMillicents,
    });
  });

  // Live-mode surfaces, staged: linking a wallet, fetching a claim proof, and
  // triggering the root publisher all arrive with the TGE keeper tooling.
  route("POST", "/v1/web/wallet", async (req, res, body, rawBody, query) => {
    if (!config.tokenMode) return tokenModeOff(res);
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    return liveOnly(res);
  });
  route("GET", "/v1/web/token/claim-proof", async (req, res, body, rawBody, query) => {
    if (!config.tokenMode) return tokenModeOff(res);
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    return liveOnly(res);
  });
  route("POST", "/v1/admin/epochs/publish-root", async (req, res, body, rawBody, query) => {
    if (!config.tokenMode) return tokenModeOff(res);
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    return liveOnly(res);
  });

  // ---------- USDC advertiser checkout (dwell/docs/08) ----------
  // Non-custodial pay-and-swap: POST /orders prices the campaign and quotes the
  // swap; POST /orders/:id/transaction builds ONE atomic unsigned transaction
  // (10% USDC fee -> treasury, 90% Jupiter-swapped into DWELL -> distributor
  // vault) that the advertiser signs from their own wallet; GET /orders/:id
  // polls, discovers the payment by its Solana Pay reference key, verifies the
  // finalized transaction read-only, and activates the campaign. The backend
  // holds no keys and no funds at any point. The whole surface 404s until the
  // $DWELL mint exists (DWELL_MINT unset — the launch gate).
  const usdcCheckoutOff = () =>
    !config.tokenMode || !config.dwellMint || !config.treasuryUsdcAta || !config.distributorDwellAta;
  // The reference server has no admin pricing surface (the edge function reads
  // the settings-backed repo.getPricing()); these mirror its defaults.
  const USDC_PRICING = { minCpmCents: 500, maxCpmCents: 10000, minBudgetCents: 10000, maxBudgetCents: 10000000 };
  const microUsd = (micro) => Number(micro) / 1e6;
  const shapeUsdcOrder = (o) => ({
    orderId: o.id,
    campaignId: o.campaign_id,
    status: o.status,
    campaignStatus: o.campaign_status,
    priceUsdc: microUsd(o.price_micro_usdc),
    feeUsdc: microUsd(o.fee_micro_usdc),
    trancheUsdc: microUsd(o.tranche_micro_usdc),
    payCurrency: o.pay_currency,
    // Pay-currency base units (micro-USDC / lamports / raw DWELL); SOL and DWELL
    // re-price per build.
    payTotalUnits: String(o.pay_total_units),
    payFeeUnits: String(o.pay_fee_units),
    ...(o.pay_currency === "sol" ? { estPayTotalSol: Number(o.pay_total_units) / 1e9 } : {}),
    ...(o.pay_currency === "dwell" ? {
      estPayTotalDwell: Number(o.pay_total_units) / 10 ** config.dwellDecimals,
      boostBps: config.dwellPayBoostBps,
    } : {}),
    minDwellOut: String(o.min_dwell_out),
    reference: o.reference_pubkey,
    txSignature: o.tx_signature || null,
    failReason: o.fail_reason || null,
    expiresAt: o.expires_at,
  });

  route("POST", "/v1/ads/usdc/orders", async (req, res, body) => {
    if (usdcCheckoutOff()) return json(res, 404, { error: "not found" });
    // Same budget+CPM campaign shape as the card checkout — only the rail
    // differs. currency picks what the wallet pays with: 'usdc' (default) or
    // 'sol' (native transfer fee leg + wSOL->DWELL swap; needs the treasury's
    // SOL account configured).
    const { email, adLine, url, brand, category, color, budget, cpm, showOnLeaderboard, currency } = body || {};
    const payCurrency = ["sol", "dwell"].includes(currency) ? currency : "usdc";
    if (payCurrency === "sol" && !config.treasurySolAccount) {
      return json(res, 400, { error: "SOL payments aren't enabled — pay with USDC" });
    }
    if (payCurrency === "dwell" && !config.treasuryDwellAta) {
      return json(res, 400, { error: "$DWELL payments aren't enabled — pay with USDC" });
    }
    const budgetCents = Math.round(Number(budget) * 100);
    const cpmCents = Math.round(Number(cpm) * 100);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });
    if (!isCleanAdLine(adLine)) return json(res, 400, { error: "ad line must be 3-60 printable chars, no < >" });
    if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(res, 400, { error: "https url required" });
    const P = USDC_PRICING;
    if (!(cpmCents >= P.minCpmCents && cpmCents <= P.maxCpmCents)) {
      return json(res, 400, { error: `CPM must be $${(P.minCpmCents / 100).toFixed(2)}–$${(P.maxCpmCents / 100).toFixed(2)}` });
    }
    if (!(budgetCents >= P.minBudgetCents && budgetCents <= P.maxBudgetCents)) {
      return json(res, 400, { error: `budget must be $${(P.minBudgetCents / 100).toFixed(0)}–$${(P.maxBudgetCents / 100).toLocaleString("en-US")}` });
    }
    // Paying in $DWELL boosts the campaign's impressions (docs/08) — same spend,
    // +DWELL_PAY_BOOST_BPS more reach. Applied to impressions only; the 90%
    // rewards pool stays sized to the actual $DWELL paid, so the boost is pure
    // extra reach, not a subsidy of the viewer pool.
    const boostBps = payCurrency === "dwell" ? config.dwellPayBoostBps : 0;
    const baseImpressions = Math.floor((budgetCents * 1000) / cpmCents);
    const impressions = Math.floor(baseImpressions * (10000 + boostBps) / 10000);
    if (!(baseImpressions >= 1)) return json(res, 400, { error: "budget too small for this CPM" });

    // 90/10 in micro-USDC, exact: the fee is the 10000-RESERVE_TRANCHE_BPS
    // remainder, the tranche keeps every leftover micro unit. The USD split is
    // the pricing truth on every rail; SOL amounts derive from it per quote.
    const priceMicro = BigInt(budgetCents) * 10000n;
    const feeMicro = (priceMicro * BigInt(10000 - config.reserveTrancheBps)) / 10000n;
    const trancheMicro = priceMicro - feeMicro;

    let quote, payTotalUnits, payFeeUnits, minDwellOut;
    try {
      if (payCurrency === "sol") {
        const sol = await solana.priceOrderInSol(priceMicro.toString(), 10000 - config.reserveTrancheBps);
        payTotalUnits = sol.totalLamports.toString();
        payFeeUnits = sol.feeLamports.toString();
        quote = await solana.jupiterQuote({ inputMint: WSOL_MINT, outputMint: config.dwellMint, amount: sol.trancheLamports.toString() });
        minDwellOut = String(quote.otherAmountThreshold || quote.outAmount);
      } else if (payCurrency === "dwell") {
        // No swap: the advertiser sends $DWELL directly. Price the budget into
        // $DWELL; 90% to the distributor is the min_dwell_out (exact transfer).
        const d = await solana.priceOrderInDwell(priceMicro.toString(), 10000 - config.reserveTrancheBps);
        payTotalUnits = d.totalDwell.toString();
        payFeeUnits = d.feeDwell.toString();
        quote = d.quote;
        minDwellOut = d.trancheDwell.toString();
      } else {
        payTotalUnits = priceMicro.toString();
        payFeeUnits = feeMicro.toString();
        quote = await solana.jupiterQuote({ inputMint: config.usdcMint, outputMint: config.dwellMint, amount: trancheMicro.toString() });
        minDwellOut = String(quote.otherAmountThreshold || quote.outAmount);
      }
    } catch (err) {
      console.error("[dwell] usdc order quote failed:", err?.message);
      return json(res, 502, { error: "couldn't quote the swap — try again" });
    }

    const blocks = Math.max(1, Math.round(impressions / 1000));
    const campaignId = await repo.createPendingCampaign({
      email, brand, adLine, url, category, color: normalizeHexColor(color),
      pricePerBlockCents: cpmCents, blocks, impressionsTotal: impressions, budgetCents, showOnLeaderboard,
    });
    const order = await repo.createUsdcOrder({
      campaignId,
      priceMicroUsdc: priceMicro.toString(),
      feeMicroUsdc: feeMicro.toString(),
      trancheMicroUsdc: trancheMicro.toString(),
      payCurrency,
      payTotalUnits,
      payFeeUnits,
      quote,
      minDwellOut,
      referencePubkey: solana.newReferencePubkey(),
      ttlMinutes: config.usdcOrderTtlMinutes,
    });
    json(res, 200, {
      orderId: order.id,
      campaignId,
      priceUsdc: microUsd(priceMicro),
      feeUsdc: microUsd(feeMicro),
      trancheUsdc: microUsd(trancheMicro),
      payCurrency,
      ...(payCurrency === "sol" ? { estPayTotalSol: Number(payTotalUnits) / 1e9 } : {}),
      ...(payCurrency === "dwell" ? {
        estPayTotalDwell: Number(payTotalUnits) / 10 ** config.dwellDecimals,
        boostBps: config.dwellPayBoostBps,
        boostImpressions: impressions - baseImpressions,
      } : {}),
      estDwellOut: String(quote.outAmount),
      minDwellOut,
      expiresAt: order.expires_at,
      // Solana Pay transaction request: wallets GET label/icon then POST
      // {account} to this link and receive the unsigned transaction.
      solanaPayUrl: `solana:${encodeURIComponent(`${config.apiBaseUrl}/v1/ads/usdc/orders/${order.id}/transaction`)}`,
    });
  });

  // Order status — the checkout page poller. Discovery + verification ride the
  // poll (Solana Pay findReference), so no webhook is needed for the scaffold;
  // a Helius webhook can shortcut this later without changing the contract.
  route("GET", "/v1/ads/usdc/orders/:id", async (req, res, body, rawBody, query, pathParams) => {
    if (usdcCheckoutOff()) return json(res, 404, { error: "not found" });
    const order = await repo.getUsdcOrder(pathParams.id);
    if (!order) return json(res, 404, { error: "order not found" });
    if (order.status !== "awaiting_signature") return json(res, 200, shapeUsdcOrder(order));

    // Optional hint from the paying client; otherwise look up by reference.
    let signatures = [];
    const hinted = query.get("signature");
    try {
      signatures = hinted ? [hinted] : await solana.findReferenceSignatures(order.reference_pubkey);
    } catch (err) {
      console.error("[dwell] usdc order signature lookup failed:", err?.message);
      return json(res, 200, shapeUsdcOrder(order)); // RPC hiccup — stay awaiting, client re-polls
    }
    for (const signature of signatures) {
      let v;
      try {
        v = await solana.verifyOrderTransaction({ signature, order });
      } catch (err) {
        console.error("[dwell] usdc order verify failed:", err?.message);
        continue;
      }
      if (!v.ok) {
        // A landed-but-wrong transaction (fee short, slippage floor breached)
        // permanently fails the order; not-yet-final ones keep the order open.
        if (["tx_failed", "fee_short", "no_dwell_out", "slippage_floor", "reference_missing"].includes(v.reason) && !hinted) {
          await repo.failUsdcOrder(order.id, v.reason, signature);
        }
        continue;
      }
      try {
        const paid = await repo.confirmUsdcOrder({
          orderId: order.id,
          txSignature: signature,
          dwellOut: v.dwellOut.toString(),
          tokenSplit,
          viewerShareBps: config.viewerShareBps,
        });
        if (paid) {
          try {
            await mailer.sendAdvertiserReceiptEmail(paid.email, {
              campaignId: order.campaign_id,
              brand: paid.brand,
              adLine: paid.adLine,
              pricePerBlockCents: paid.pricePerBlockCents,
              blocks: paid.blocks,
            });
          } catch (err) {
            console.error("[dwell] usdc advertiser receipt email failed", err);
          }
        }
      } catch (err) {
        if (err.code === "CAMPAIGN_NOT_FUNDABLE") {
          await repo.failUsdcOrder(order.id, "campaign_not_fundable", signature);
        } else {
          throw err;
        }
      }
      break;
    }
    const fresh = await repo.getUsdcOrder(order.id);
    json(res, 200, shapeUsdcOrder(fresh));
  });

  // Solana Pay transaction request (GET half): wallet-facing metadata.
  route("GET", "/v1/ads/usdc/orders/:id/transaction", async (req, res) => {
    if (usdcCheckoutOff()) return json(res, 404, { error: "not found" });
    json(res, 200, { label: `${config.brandName} ad campaign`, icon: `${config.siteUrl}/og.png` });
  });

  // Solana Pay transaction request (POST half): build the atomic unsigned
  // transaction for the paying wallet. Re-quotes on every build — a built
  // transaction is only ~60s of blockhash validity — and pins the refreshed
  // slippage floor to the order so the verifier enforces what the wallet saw.
  route("POST", "/v1/ads/usdc/orders/:id/transaction", async (req, res, body, rawBody, query, pathParams) => {
    if (usdcCheckoutOff()) return json(res, 404, { error: "not found" });
    const order = await repo.getUsdcOrder(pathParams.id);
    if (!order) return json(res, 404, { error: "order not found" });
    if (order.status === "expired") return json(res, 410, { error: "order expired — start a new one" });
    if (order.status !== "awaiting_signature") return json(res, 409, { error: `order is ${order.status}` });
    const payer = String(body?.account || "");
    if (!solana.isPubkey(payer)) return json(res, 400, { error: "account must be a Solana pubkey" });
    try {
      let built = { ...order };
      let transaction, tail = "";

      if (order.pay_currency === "dwell") {
        // $DWELL rail: no swap. Re-price the $DWELL legs (its price floats), pin
        // them + the 90% floor to the order, then build the two-transfer tx.
        const d = await solana.priceOrderInDwell(String(order.price_micro_usdc), 10000 - config.reserveTrancheBps);
        built.pay_total_units = d.totalDwell.toString();
        built.pay_fee_units = d.feeDwell.toString();
        const minOut = d.trancheDwell.toString();
        await repo.refreshUsdcOrderQuote(order.id, d.quote, minOut, {
          payTotalUnits: built.pay_total_units, payFeeUnits: built.pay_fee_units,
        });
        transaction = await solana.buildOrderTransaction({ order: { ...built, min_dwell_out: minOut }, payer });
        tail = ` (≈ ${(Number(built.pay_total_units) / 10 ** config.dwellDecimals).toLocaleString("en-US", { maximumFractionDigits: 2 })} $DWELL, +${config.dwellPayBoostBps / 100}% impressions)`;
      } else {
        // SOL rail: re-price the lamport legs first (the USD split is fixed;
        // what that costs in SOL floats), then quote the swap of the tranche.
        if (order.pay_currency === "sol") {
          const sol = await solana.priceOrderInSol(String(order.price_micro_usdc), 10000 - config.reserveTrancheBps);
          built.pay_total_units = sol.totalLamports.toString();
          built.pay_fee_units = sol.feeLamports.toString();
        }
        const quote = await solana.jupiterQuote(solana.tranchQuoteParams(built));
        const minOut = String(quote.otherAmountThreshold || quote.outAmount);
        await repo.refreshUsdcOrderQuote(order.id, quote, minOut, order.pay_currency === "sol"
          ? { payTotalUnits: built.pay_total_units, payFeeUnits: built.pay_fee_units }
          : {});
        transaction = await solana.buildOrderTransaction({ order: { ...built, min_dwell_out: minOut }, payer, quoteResponse: quote });
        if (order.pay_currency === "sol") tail = ` (≈ ${(Number(built.pay_total_units) / 1e9).toFixed(4)} SOL)`;
      }

      json(res, 200, {
        transaction,
        message: `${config.brandName}: $${microUsd(order.price_micro_usdc).toFixed(2)} ad campaign — $${microUsd(order.fee_micro_usdc).toFixed(2)} protocol fee + $${microUsd(order.tranche_micro_usdc).toFixed(2)} ${order.pay_currency === "dwell" ? "to the rewards pool" : "DWELL buy to the rewards pool"}${tail}`,
      });
    } catch (err) {
      if (err.code === "NO_FUNDS" || err.code === "BAD_ACCOUNT") return json(res, 400, { error: err.message });
      console.error("[dwell] usdc order build failed:", err?.message);
      json(res, 502, { error: "couldn't build the transaction — try again" });
    }
  });

  // ---------- pre-account email capture (launch waitlist) ----------
  // Public, no-auth: someone types their email under the hero on dwellprotocol.com (or a
  // lander) to be told when they can install and start earning. Store the bare
  // email (no account, no magic link), then best-effort send a confirmation. (In
  // production the edge function additionally mirrors the contact into Resend.)
  route("POST", "/v1/waitlist", async (req, res, body) => {
    const email = String(body?.email || "").trim().toLowerCase();
    const source = typeof body?.source === "string" ? body.source.slice(0, 80) : null;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });
    try {
      const { created } = await repo.addEmailLead({ email, kind: "earn", source, ipHash: hashIp(req), ipDailyCap: config.leadDailyCap });
      if (created) {
        mailer.sendWaitlistConfirmationEmail(email).catch((e) => console.error("[dwell] waitlist confirm mail failed:", e?.message));
      }
      json(res, 200, { ok: true, joined: true, alreadyJoined: !created });
    } catch (err) {
      if (err.code === "CAP_EXCEEDED") return json(res, 429, { error: "too many signups from here today — try again later" });
      throw err;
    }
  });

  // ---------- money in: advertiser checkout ----------
  route("POST", "/v1/checkout", async (req, res, body) => {
    const { email, adLine, url, brand, category, color, pricePerBlock, blocks, showOnLeaderboard } = body || {};
    const priceCents = Math.round(Number(pricePerBlock) * 100);
    const nBlocks = parseInt(blocks, 10);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "valid email required" });
    if (!isCleanAdLine(adLine)) return json(res, 400, { error: "ad line must be 3-60 printable chars, no < >" });
    if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(res, 400, { error: "https url required" });
    if (!(priceCents >= 50)) return json(res, 400, { error: "min bid is $0.50 per block" });
    if (!(nBlocks >= 1)) return json(res, 400, { error: "at least 1 block" });

    const campaignId = await repo.createPendingCampaign({
      email, brand, adLine, url, category, color: normalizeHexColor(color),
      pricePerBlockCents: priceCents, blocks: nBlocks, showOnLeaderboard,
    });
    const session = await stripe.createCheckoutSession({
      mode: "payment", customer_email: email,
      // receipt_email isn't a Checkout Session param; it lives on the PaymentIntent.
      payment_intent_data: { receipt_email: email },
      line_items: [{
        quantity: nBlocks,
        price_data: {
          currency: "usd", unit_amount: priceCents,
          // Brand-configurable so the DWELL deployment bills under its own
          // Stripe product line, even before its keys move to their own account.
          product_data: {
            name: config.stripeProductName || "DWELL spinner block — 1,000 impressions",
            description: `${brand ? brand + " — " : ""}"${adLine}" → ${url}`,
            images: [config.stripeProductImage || "https://dwellprotocol.com/og.png"],
          },
        },
      }],
      metadata: { campaign_id: campaignId },
      success_url: `${config.siteUrl}/?checkout=success`,
      cancel_url: `${config.siteUrl}/?checkout=cancelled`,
    });
    await repo.attachCheckoutSession(campaignId, session.id);
    json(res, 200, { campaignId, checkoutUrl: session.url });
  });

  // ---------- Stripe webhooks ----------
  route("POST", "/v1/webhooks/stripe", async (req, res, body, rawBody) => {
    if (!verifyWebhookSignature(rawBody, req.headers["stripe-signature"], config.stripeWebhookSecret)) {
      return json(res, 400, { error: "bad signature" });
    }
    const event = body;
    // exactly-once: Stripe retries, so dedupe on event id
    const fresh = await repo.claimWebhookEvent(event.id, event.type);
    if (!fresh) return json(res, 200, { received: true, duplicate: true });

    switch (event.type) {
      case "checkout.session.completed": {
        const obj = event.data?.object || {};
        if (obj.metadata?.campaign_id) {
          const paid = await repo.markCampaignPaid(obj.metadata.campaign_id, obj.payment_intent, { tokenSplit });
          // Only on the transitioning call (paid is the campaign details, not
          // false). Wrapped so a mail outage never rolls back the funded state —
          // the webhook event is already claimed and won't be retried.
          if (paid) {
            try {
              await mailer.sendAdvertiserReceiptEmail(paid.email, {
                campaignId: obj.metadata.campaign_id,
                brand: paid.brand,
                adLine: paid.adLine,
                pricePerBlockCents: paid.pricePerBlockCents,
                blocks: paid.blocks,
              });
            } catch (err) {
              console.error("[dwell] advertiser receipt email failed", err);
            }
          }
        }
        break;
      }
      case "account.updated": {
        const acct = event.data?.object;
        if (acct?.id) await repo.setPayoutsEnabledByAccount(acct.id, !!(acct.charges_enabled && acct.payouts_enabled));
        break;
      }
      default: break;
    }
    json(res, 200, { received: true });
  });

  // ---------- email verification (before payouts) ----------
  route("POST", "/v1/auth/request-link", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    if (!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return json(res, 400, { error: "valid email required" });
    let token;
    try {
      token = await repo.createEmailToken(body.email, device.id, config.emailTokenTtlMs, null, config.emailCooldownMs, hashIp(req), config.emailIpDailyCap);
    } catch (err) {
      if (err.code === "CAP_EXCEEDED") return json(res, 429, { error: "too many email requests from here today — try again later" });
      throw err;
    }
    if (token) await mailer.sendVerifyEmail(body.email, `${config.apiBaseUrl}/v1/auth/verify?token=${token}`);
    json(res, 200, { ok: true, sent: true });
  });

  route("GET", "/v1/auth/verify", async (req, res, body, rawBody, query) => {
    const user = await repo.verifyEmailToken(query.get("token"));
    if (!user) return redirect(res, `${config.siteUrl}/?verified=0`);
    redirect(res, `${config.siteUrl}/?verified=1`);
  });

  // ---------- money out: developer onboarding & earnings ----------
  route("POST", "/v1/connect/onboard", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    const user = await repo.userForDevice(device.id);
    if (!user || !user.email_verified) return json(res, 403, { error: "verify your email first" });

    let accountId = user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.createAccount({
        type: "express", email: user.email,
        capabilities: { transfers: { requested: true } }, business_type: "individual",
      });
      accountId = account.id;
      await repo.setStripeAccount(user.id, accountId);
    }
    const link = await stripe.createAccountLink({
      account: accountId, type: "account_onboarding",
      refresh_url: `${config.siteUrl}/?onboarding=retry`, return_url: `${config.siteUrl}/?onboarding=done`,
    });
    json(res, 200, { onboardingUrl: link.url });
  });

  route("GET", "/v1/me/earnings", async (req, res, body, rawBody, query) => {
    const device = await authDeviceFrom(null, query);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    // Linked devices report the pooled account balance (all surfaces) so the
    // desktop menu matches the web dashboard; anonymous devices see only their own.
    const user = await repo.userForDevice(device.id);
    const e = user ? await repo.balanceForUser(user.id) : await repo.earningsForDevice(device.id);
    json(res, 200, {
      revenueShare: displayRevenueShare,
      earnedUsd: e.earnedMillicents / 100000,
      paidOutUsd: e.paidOutMillicents / 100000,
      redeemedUsd: e.redeemedMillicents / 100000,
      balanceUsd: e.balanceMillicents / 100000,
      payoutThresholdUsd: config.payoutThresholdCents / 100,
    });
  });

  // Device-scoped affiliate "crew": the extension popup's earn-with-friends
  // panel. Anonymous until the device is linked to a user (via the magic link
  // from /v1/auth/request-link); once linked, the user is auto-enrolled as an
  // approved affiliate and this returns their invite link plus the per-friend 10%
  // breakdown — device credentials only, no web session.
  route("GET", "/v1/me/affiliate", async (req, res, body, rawBody, query) => {
    const device = await authDeviceFrom(null, query, req.headers);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    const rewardPct = config.affiliateRewardBps / 100;
    const user = await repo.userForDevice(device.id);
    if (!user) return json(res, 200, { linked: false, rewardPct });
    const aff = await repo.getOrCreateAffiliate(user.id);
    const crew = await repo.affiliateCrew(aff.id, user.id);
    // Pending invites you've sent that haven't joined yet — surfaced so the
    // popup's crew slots stay filled across reopens. Drop any whose masked
    // address already matches a joined friend (they show up under `friends`).
    const friendNames = new Set(crew.friends.map((f) => f.name));
    const invited = (await repo.pendingInvitesForUser(user.id)).filter((i) => !friendNames.has(i.email));
    json(res, 200, {
      linked: true,
      email: user.email,
      code: aff.code,
      link: `${config.siteUrl}/portal.html?ref=${aff.code}`,
      rewardPct,
      crewSize: CREW_SIZE,
      attributedCount: crew.count,
      creditedUsd: crew.creditedMillicents / 100000,
      friends: crew.friends,
      invited,
    });
  });

  // Invite a friend to your crew from the extension popup. Device-scoped (no web
  // session): authed by device credentials, the invite carries the user's
  // affiliate link so the friend is attributed to them — earning the affiliate's
  // cut forever. The friend keeps 100% of their own earnings.
  route("POST", "/v1/me/affiliate/invite", async (req, res, body) => {
    const device = await authDeviceFrom(body);
    if (!device) return json(res, 401, { error: "bad device credentials" });
    const user = await repo.userForDevice(device.id);
    if (!user) return json(res, 401, { error: "link this device to invite friends" });
    const email = String(body?.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { error: "valid email required" });
    }
    if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
      return json(res, 400, { error: "you can't invite your own email" });
    }
    const aff = await repo.getOrCreateAffiliate(user.id);
    const link = `${config.siteUrl}/portal.html?ref=${aff.code}`;
    const invite = await repo.createReferralInvite(user.id, email, aff.code);
    await mailer.sendCrewInviteEmail(email, {
      inviterEmail: user.email,
      link,
      rewardPct: config.affiliateRewardBps / 100,
    });
    json(res, 200, {
      ok: true,
      sent: true,
      invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at },
    });
  });

  // ---------- gift card redemptions ----------
  route("GET", "/v1/giftcards", async (req, res) => {
    json(res, 200, {
      plans: Object.values(GIFT_PLANS).map((p) => ({
        id: p.id, name: p.name, tagline: p.tagline, monthlyUsd: p.monthlyCents / 100,
      })),
      months: GIFT_MONTHS,
      redemptionFeeBps: config.redemptionFeeBps,
      deliveryWindowHours: 48,
    });
  });

  // Redemption is a website-only, logged-in flow (see AGENTS.md): credits are
  // cashed out at /v1/web/redemptions behind a web session. The old
  // device-credential path is retired — a leaked deviceKey must let someone
  // accrue credits in your name, never cash them out. Old clients get a clear,
  // safe refusal instead of a money-out they can't be trusted with.
  route("POST", "/v1/redemptions", async (req, res) => {
    json(res, 410, {
      error: "redeem on the website after signing in",
      redeemUrl: `${config.siteUrl}/portal.html`,
    });
  });

  // ---------- OAuth helpers ----------
  // The signed state carries a CSRF nonce plus (optionally) the referral code the
  // user typed on the signup form, so it survives the round-trip through the OAuth
  // provider tamper-proof. Returns null when invalid/expired, else { ref }.
  function makeOAuthState(ref) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const ts = Date.now();
    const code = String(ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    const payload = `${ts}.${nonce}.${code}`;
    const sig = crypto.createHmac("sha256", config.adminKey || "fallback").update(payload).digest("hex").slice(0, 20);
    return `${payload}.${sig}`;
  }
  function verifyOAuthState(state) {
    if (!state) return null;
    const lastDot = state.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = state.slice(0, lastDot);
    const sig = state.slice(lastDot + 1);
    const expected = crypto.createHmac("sha256", config.adminKey || "fallback").update(payload).digest("hex").slice(0, 20);
    if (sig !== expected) return null;
    const parts = payload.split(".");
    const ts = parseInt(parts[0], 10);
    if (!Number.isFinite(ts) || Date.now() - ts >= 10 * 60 * 1000) return null;
    return { ref: parts[2] || "", nonce: parts[1] || "" };
  }
  // X (Twitter) OAuth 2.0 mandates PKCE even for confidential clients. We stay
  // stateless like the rest of the OAuth flow by deriving the verifier from the
  // signed state's nonce with a server secret — it never leaves the server (only
  // its S256 hash, the challenge, travels through the browser), and the callback
  // recomputes it from the returned state.
  function pkceVerifier(nonce) {
    return crypto.createHmac("sha256", config.adminKey || "fallback").update(`pkce:${nonce}`).digest("hex");
  }
  function pkceChallenge(verifier) {
    return crypto.createHash("sha256").update(verifier).digest("base64url");
  }
  // Convert DER-encoded ECDSA signature to IEEE P1363 (JWT ES256 format).
  function derEcdsaToP1363(der) {
    let i = 2; // skip SEQUENCE (0x30) tag + 1-byte length
    i++;       // skip INTEGER (0x02) tag for r
    const rLen = der[i++];
    const r = der.slice(i, i + rLen);
    i += rLen;
    i++;       // skip INTEGER (0x02) tag for s
    const sLen = der[i++];
    const s = der.slice(i, i + sLen);
    const fit32 = (b) => { const out = Buffer.alloc(32); b.slice(b.length > 32 ? b.length - 32 : 0).copy(out, 32 - Math.min(b.length, 32)); return out; };
    return Buffer.concat([fit32(r), fit32(s)]);
  }
  function decodeJwtPayload(token) {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
    catch { return null; }
  }
  // Build the short-lived JWT Apple requires as its client_secret (ES256).
  function buildAppleClientSecret() {
    if (!config.applePrivateKey || !config.appleTeamId || !config.appleKeyId || !config.appleClientId) return null;
    const hdr = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.appleKeyId })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const pay = Buffer.from(JSON.stringify({
      iss: config.appleTeamId, iat: now, exp: now + 300,
      aud: "https://appleid.apple.com", sub: config.appleClientId,
    })).toString("base64url");
    const input = `${hdr}.${pay}`;
    const sign = crypto.createSign("SHA256");
    sign.update(input);
    const der = sign.sign(config.applePrivateKey);
    return `${input}.${derEcdsaToP1363(der).toString("base64url")}`;
  }

  // ---------- Google OAuth ----------
  route("GET", "/v1/auth/google", async (req, res, body, rawBody, query) => {
    if (!config.googleClientId) return redirect(res, `${config.siteUrl}/portal.html?login=no-google`);
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`,
      response_type: "code",
      scope: "email profile",
      state: makeOAuthState(query.get("ref")),
      access_type: "online",
      prompt: "select_account",
    });
    redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  route("GET", "/v1/auth/google/callback", async (req, res, body, rawBody, query) => {
    if (query.get("error") || !query.get("code")) {
      return redirect(res, `${config.siteUrl}/portal.html?login=cancelled`);
    }
    const oauthState = verifyOAuthState(query.get("state"));
    if (!oauthState) {
      return redirect(res, `${config.siteUrl}/portal.html?login=error`);
    }
    try {
      const tokRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.get("code"),
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`,
          grant_type: "authorization_code",
        }).toString(),
      });
      const tokens = await tokRes.json();
      if (!tokens.access_token) throw new Error("no access_token");
      const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const gu = await uiRes.json();
      if (!gu.email) throw new Error("no email from Google");
      const { sessionToken } = await repo.upsertUserByOAuth(
        { email: gu.email, googleId: gu.sub, referralCode: oauthState.ref,
          emailVerified: gu.email_verified === true || gu.email_verified === "true" },
        config.webSessionTtlMs
      );
      redirect(res, `${config.siteUrl}/portal.html#session=${sessionToken}`);
    } catch (err) {
      console.error("[dwell] google oauth:", err.message);
      redirect(res, `${config.siteUrl}/portal.html?login=error`);
    }
  });

  // ---------- Apple OAuth ----------
  route("GET", "/v1/auth/apple", async (req, res, body, rawBody, query) => {
    if (!config.appleClientId) return redirect(res, `${config.siteUrl}/portal.html?login=no-apple`);
    const params = new URLSearchParams({
      client_id: config.appleClientId,
      redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`,
      response_type: "code",
      scope: "email",
      response_mode: "query",
      state: makeOAuthState(query.get("ref")),
    });
    redirect(res, `https://appleid.apple.com/auth/authorize?${params}`);
  });

  route("GET", "/v1/auth/apple/callback", async (req, res, body, rawBody, query) => {
    if (query.get("error") || !query.get("code")) {
      return redirect(res, `${config.siteUrl}/portal.html?login=cancelled`);
    }
    const oauthState = verifyOAuthState(query.get("state"));
    if (!oauthState) {
      return redirect(res, `${config.siteUrl}/portal.html?login=error`);
    }
    try {
      const secret = buildAppleClientSecret();
      if (!secret) throw new Error("Apple credentials not configured");
      const tokRes = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.get("code"),
          client_id: config.appleClientId,
          client_secret: secret,
          redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`,
          grant_type: "authorization_code",
        }).toString(),
      });
      const tokens = await tokRes.json();
      if (!tokens.id_token) throw new Error("no id_token from Apple");
      const claims = decodeJwtPayload(tokens.id_token);
      if (!claims?.sub) throw new Error("no sub in Apple id_token");
      const { sessionToken } = await repo.upsertUserByOAuth(
        { email: claims.email || null, appleId: claims.sub, referralCode: oauthState.ref,
          emailVerified: claims.email_verified === true || claims.email_verified === "true" },
        config.webSessionTtlMs
      );
      redirect(res, `${config.siteUrl}/portal.html#session=${sessionToken}`);
    } catch (err) {
      console.error("[dwell] apple oauth:", err.message);
      redirect(res, `${config.siteUrl}/portal.html?login=error`);
    }
  });

  // ---------- X (Twitter) OAuth 2.0 (PKCE) ----------
  // X returns no email, so these accounts are keyed on the numeric X user id
  // alone. The confidential client authenticates the token exchange with HTTP
  // Basic (client_id:client_secret).
  route("GET", "/v1/auth/twitter", async (req, res, body, rawBody, query) => {
    if (!config.twitterClientId) return redirect(res, `${config.siteUrl}/portal.html?login=no-twitter`);
    const state = makeOAuthState(query.get("ref"));
    const st = verifyOAuthState(state);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.twitterClientId,
      redirect_uri: `${config.apiBaseUrl}/v1/auth/twitter/callback`,
      scope: "tweet.read users.read offline.access",
      state,
      code_challenge: pkceChallenge(pkceVerifier(st.nonce)),
      code_challenge_method: "S256",
    });
    redirect(res, `https://twitter.com/i/oauth2/authorize?${params}`);
  });

  route("GET", "/v1/auth/twitter/callback", async (req, res, body, rawBody, query) => {
    if (query.get("error") || !query.get("code")) {
      return redirect(res, `${config.siteUrl}/portal.html?login=cancelled`);
    }
    const oauthState = verifyOAuthState(query.get("state"));
    if (!oauthState) {
      return redirect(res, `${config.siteUrl}/portal.html?login=error`);
    }
    try {
      const basic = Buffer.from(`${config.twitterClientId}:${config.twitterClientSecret}`).toString("base64");
      const tokRes = await fetch("https://api.twitter.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          code: query.get("code"),
          grant_type: "authorization_code",
          client_id: config.twitterClientId,
          redirect_uri: `${config.apiBaseUrl}/v1/auth/twitter/callback`,
          code_verifier: pkceVerifier(oauthState.nonce),
        }).toString(),
      });
      const tokens = await tokRes.json();
      if (!tokens.access_token) throw new Error("no access_token from X");
      const uiRes = await fetch("https://api.twitter.com/2/users/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const tu = await uiRes.json();
      if (!tu?.data?.id) throw new Error("no user id from X");
      const { sessionToken } = await repo.upsertUserByOAuth(
        { twitterId: String(tu.data.id), referralCode: oauthState.ref, emailVerified: false },
        config.webSessionTtlMs
      );
      redirect(res, `${config.siteUrl}/portal.html#session=${sessionToken}`);
    } catch (err) {
      console.error("[dwell] twitter oauth:", err.message);
      redirect(res, `${config.siteUrl}/portal.html?login=error`);
    }
  });

  // ---------- website login + redemption (the only place users redeem) ----------
  // Email magic link → web session → read balance → redeem for a Claude gift card.
  function sessionFrom(req, body, query) {
    const h = req.headers["authorization"] || "";
    const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
    return bearer || body?.session || query?.get("session") || null;
  }

  route("POST", "/v1/web/login", async (req, res, body) => {
    if (!body?.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
      return json(res, 400, { error: "valid email required" });
    }
    let token;
    try {
      token = await repo.createEmailToken(body.email, null, config.emailTokenTtlMs, body.referralCode, config.emailCooldownMs, hashIp(req), config.emailIpDailyCap);
    } catch (err) {
      if (err.code === "CAP_EXCEEDED") return json(res, 429, { error: "too many sign-in requests from here today — try again later" });
      throw err;
    }
    if (token) await mailer.sendWebLoginEmail(body.email, `${config.apiBaseUrl}/v1/web/session?token=${token}`);
    json(res, 200, { ok: true, sent: true });
  });

  route("GET", "/v1/web/session", async (req, res, body, rawBody, query) => {
    const result = await repo.createWebSessionFromToken(query.get("token"), config.webSessionTtlMs);
    if (!result) return redirect(res, `${config.siteUrl}/portal.html?login=expired`);
    redirect(res, `${config.siteUrl}/portal.html#session=${result.sessionToken}`);
  });

  route("GET", "/v1/web/me", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const bal = await repo.balanceForUser(user.id);
    const [hasSurvey, posted, code] = await Promise.all([
      repo.hasOnboardingSurvey(user.id),
      repo.hasPostedOnboarding(user.id),
      repo.getOrCreateReferralCode(user.id),
    ]);
    json(res, 200, {
      email: user.email, balanceUsd: bal.balanceMillicents / 100000,
      needsSurvey: !hasSurvey, needsPost: !posted,
      referralLink: `${config.siteUrl}/portal.html?ref=${code}`,
    });
  });

  // Sign out: revoke the session server-side so the bearer token is dead even
  // if it lingers in a browser/localStorage or was copied elsewhere. Always 200
  // (idempotent) — clearing the client-side token is the caller's job.
  route("POST", "/v1/web/logout", async (req, res, body, rawBody, query) => {
    await repo.deleteWebSession(sessionFrom(req, body, query));
    json(res, 200, { ok: true });
  });

  // Earnings dashboard: lifetime / today / month-to-date credit totals plus a
  // time-bucketed series for the activity chart. ?window=24h|7d|30d selects the
  // chart window (24h is hourly buckets; 7d/30d are daily). Cards are
  // window-independent; the front end re-fetches only to change the chart.
  route("GET", "/v1/web/earnings", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });

    const window = ({ "24h": "24h", "7d": "7d", "30d": "30d" })[query.get("window")] || "7d";
    const bucket = window === "24h" ? "hour" : "day";
    const sinceMs = window === "24h" ? 24 * 3600e3 : (window === "7d" ? 7 : 30) * 86400e3;
    const since = new Date(Date.now() - sinceMs);

    const e = await repo.earningsForUser(user.id);
    const series = await repo.earningsSeriesForUser(user.id, { bucket, since });
    json(res, 200, {
      todayUsd: e.todayMillicents / 100000,
      monthUsd: e.monthMillicents / 100000,
      lifetimeUsd: e.lifetimeMillicents / 100000,
      balanceUsd: e.balanceMillicents / 100000,
      redeemedUsd: e.redeemedMillicents / 100000,
      window,
      series: series.map((b) => ({ t: b.t, usd: b.millicents / 100000, count: b.count })),
    });
  });

  // Activity ledger: the user's most recent credited events (impressions,
  // clicks, referral bonuses), newest first. Searching and filtering happen
  // client-side over the returned rows.
  route("GET", "/v1/web/activity", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });

    const rows = await repo.recentCreditsForUser(user.id, query.get("limit") || 200);
    json(res, 200, {
      count: rows.length,
      rows: rows.map((r) => ({
        id: String(r.id),
        createdAt: r.createdAt,
        type: r.entryType,
        amountUsd: r.amountMillicents / 100000,
        advertiser: r.advertiser,
        meta: r.meta,
      })),
    });
  });

  // Per-service activation for the Install tab: true once the account has
  // received its first credit from that surface (chrome / claude_code / desktop).
  route("GET", "/v1/web/sources", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const sources = await repo.sourcesForUser(user.id);
    json(res, 200, { sources });
  });

  // The user's referral dashboard: their shareable link/code, the reward terms,
  // and progress toward the cap. Refer a friend; when they redeem their first
  // gift card, you earn the bonus.
  route("GET", "/v1/web/referrals", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const code = await repo.getOrCreateReferralCode(user.id);
    const stats = await repo.referralStats(user.id);
    json(res, 200, {
      code,
      link: `${config.siteUrl}/portal.html?ref=${code}`,
      rewardUsd: config.referralRewardCents / 100,
      cap: config.referralCap,
      rewardedCount: stats.rewardedCount,
      pendingCount: stats.pendingCount,
      invitedCount: stats.invitedCount,
      creditsEarnedUsd: stats.creditsEarnedMillicents / 100000,
      referrals: stats.referrals,
    });
  });

  // The user's ad-surface waitlists. GET returns the catalog of surfaces (from
  // the enum table) annotated with which ones the user has already joined; POST
  // joins one. Joining is idempotent — a repeat is a no-op.
  route("GET", "/v1/web/waitlist", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const surfaces = await repo.listWaitlistSurfaces();
    const joined = new Set((await repo.waitlistsForUser(user.id)).map((w) => w.surface));
    json(res, 200, {
      surfaces: surfaces.map((s) => ({ surface: s.surface, label: s.label, joined: joined.has(s.surface) })),
    });
  });

  route("POST", "/v1/web/waitlist", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const surface = body?.surface;
    const known = await repo.listWaitlistSurfaces();
    if (!surface || !known.some((s) => s.surface === surface)) {
      return json(res, 400, { error: "unknown surface", surfaces: known.map((s) => s.surface) });
    }
    const created = await repo.joinWaitlist(user.id, surface);
    json(res, 200, { ok: true, surface, joined: true, alreadyJoined: !created });
  });

  // Invite a friend by email. Records the invite (the "sent" indicator) and
  // emails them the user's referral link. You can't refer your own address —
  // the code only ever attributes a brand-new account, so self-referral is both
  // pointless and rejected here for a clear error.
  route("POST", "/v1/web/referrals/invite", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const email = String(body?.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { error: "valid email required" });
    }
    if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
      return json(res, 400, { error: "You can't refer your own email" });
    }
    const code = await repo.getOrCreateReferralCode(user.id);
    const link = `${config.siteUrl}/portal.html?ref=${code}`;
    const invite = await repo.createReferralInvite(user.id, email, code);
    // The invite row above is the onboarding gate and the source of truth: the
    // friend never has to act for the inviter to progress. Delivering the email
    // is best-effort — if the mail provider rejects it (e.g. an unverified
    // sending domain) we log it but don't fail the request, otherwise the user
    // is stranded on onboarding behind an "internal error" for a saved invite.
    let sent = true;
    try {
      await mailer.sendReferralInviteEmail(email, {
        inviterEmail: user.email,
        link,
        rewardUsd: config.referralRewardCents / 100,
      });
    } catch (err) {
      sent = false;
      console.error("[dwell] referral invite email failed:", err.message);
    }
    json(res, 200, {
      ok: true,
      sent,
      invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at },
    });
  });

  // ---------- affiliate program ----------
  // The caller's affiliate state: their application + program terms (if any),
  // and whether they can still attach an affiliate code to their account.
  route("GET", "/v1/web/affiliate", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    // Self-serve: everyone is an affiliate. Ensure enrollment, then read details.
    await repo.getOrCreateAffiliate(user.id);
    const data = await repo.affiliateForUser(user.id);
    const app = data.application;
    // Influencer upgrade = a higher rate or a raised people cap above the base config.
    const upgraded = app.rewardBps > config.affiliateRewardBps || app.capPeople > config.affiliateCapPeople;
    // Upgrade requested = the user attached socials (auto-enrolled rows have none).
    const upgradeRequested = !!(app.socials.instagram || app.socials.linkedin || app.socials.twitter);
    json(res, 200, {
      enrolled: true,
      code: app.code,
      link: app.code ? `${config.siteUrl}/portal.html?ref=${app.code}` : null,
      socials: app.socials,
      rewardPct: app.rewardBps / 100,
      capPeople: app.capPeople,
      creditedUsd: app.creditedMillicents / 100000,
      attributedCount: app.attributedCount,
      upgraded, upgradeRequested,
      attributed: data.attributed,
      hasReferrer: data.hasReferrer,
      canApplyCode: !data.attributed && !data.hasReferrer,
    });
  });

  // Invite a friend to your crew from the website (session-authed mirror of the
  // device-scoped /v1/me/affiliate/invite). Sends the inviter's affiliate link so
  // the friend is attributed to them — earning the affiliate's cut forever. This
  // also writes the referral_invites row that satisfies the onboarding gate.
  route("POST", "/v1/web/affiliate/invite", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const email = String(body?.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json(res, 400, { error: "valid email required" });
    }
    if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
      return json(res, 400, { error: "you can't invite your own email" });
    }
    const aff = await repo.getOrCreateAffiliate(user.id);
    const link = `${config.siteUrl}/portal.html?ref=${aff.code}`;
    const invite = await repo.createReferralInvite(user.id, email, aff.code);
    await mailer.sendCrewInviteEmail(email, {
      inviterEmail: user.email,
      link,
      rewardPct: config.affiliateRewardBps / 100,
    });
    json(res, 200, {
      ok: true,
      sent: true,
      invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at },
    });
  });

  // Influencer upgrade application: attach socials to request a custom rate /
  // uncapped earnings. Keeps the user's active base 10% — no status downgrade.
  route("POST", "/v1/web/affiliate/apply", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const parsed = parseAffiliateSocials(body);
    if (parsed.error) return json(res, 400, { error: parsed.error });
    await repo.requestAffiliateUpgrade(user.id, parsed.socials);
    json(res, 200, { ok: true });
  });

  // Retroactively attach an affiliate code to your own account. Allowed only
  // when you have no existing attribution; referral codes can't be applied here.
  route("POST", "/v1/web/affiliate-code", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const code = String(body?.code || "").trim();
    if (!code) return json(res, 400, { error: "code required" });
    const result = await repo.applyAffiliateCodeForUser(user.id, code);
    if (result.ok) return json(res, 200, { ok: true });
    const msg = {
      already_affiliated: "your account already has an affiliate code",
      has_referrer: "your account was referred, so an affiliate code can't be added",
      invalid_code: "that affiliate code isn't valid",
    }[result.reason] || "couldn't apply that code";
    json(res, 400, { error: msg, reason: result.reason });
  });

  // First-login onboarding survey: which AI models the user uses and where, both
  // multi-select. Saved before the refer-a-friend step; clears the needsSurvey gate.
  route("POST", "/v1/web/onboarding/survey", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    const MODELS = ["claude", "chatgpt", "gemini", "other"];
    const SURFACES = ["browser_chrome", "browser_other", "desktop_app", "cursor", "terminal", "other"];
    const models = [...new Set((Array.isArray(body?.models) ? body.models : []).filter((m) => MODELS.includes(m)))];
    const surfaces = [...new Set((Array.isArray(body?.surfaces) ? body.surfaces : []).filter((s) => SURFACES.includes(s)))];
    if (!models.length || !surfaces.length) {
      return json(res, 400, { error: "select at least one model and one surface" });
    }
    const surfaceOther = surfaces.includes("other")
      ? (String(body?.surfaceOther || "").trim().slice(0, 200) || null)
      : null;
    await repo.saveOnboardingSurvey(user.id, { models, surfaces, surfaceOther });
    json(res, 200, { ok: true });
  });

  // First-login onboarding post: the user confirms they posted the prebuilt
  // DWELL note to their X timeline. Self-attested — clears the needsPost gate so
  // the dashboard unlocks. Idempotent. Accounts that never post may have their
  // payouts delayed or withheld (see terms.html).
  route("POST", "/v1/web/onboarding/post", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    await repo.markOnboardingPosted(user.id);
    json(res, 200, { ok: true });
  });

  route("POST", "/v1/web/redemptions", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });

    const plan = GIFT_PLANS[body.plan];
    const months = parseInt(body.months, 10);
    const amountCents = plan ? giftPriceCents(plan.id, months) : null;
    if (!amountCents) return json(res, 400, { error: "plan must be pro/max5x/max20x and months 1/3/6/12" });
    // The protocol's cut is charged on top of face value: a $60 gift card costs
    // $66 of balance, and the $6 fee lands platform-side in the ledger.
    const feeCents = Math.ceil((amountCents * config.redemptionFeeBps) / 10000);
    const totalCents = amountCents + feeCents;

    // Gift cards are delivered only to the account's own email — never an
    // address supplied in the request. This caps the blast radius of a stolen
    // session: a hijacked token can't redirect a cash-out to an attacker inbox.
    const recipientEmail = user.email;
    if (!recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
      return json(res, 400, { error: "your account needs a verified email to redeem" });
    }

    const balance = await repo.balanceForUser(user.id);
    if (balance.balanceMillicents < totalCents * 1000) {
      return json(res, 403, {
        error: "insufficient credits",
        balanceUsd: balance.balanceMillicents / 100000,
        requiredUsd: totalCents / 100,
        amountUsd: amountCents / 100,
        feeUsd: feeCents / 100,
      });
    }

    // Email the fulfillment inbox first, then deduct; the in-transaction balance
    // re-check inside recordGiftRedemptionForUser keeps concurrent redeems honest.
    const redemptionId = crypto.randomUUID();
    await mailer.sendGiftRedemptionEmail(config.giftFulfillmentEmail, {
      redemptionId, planName: plan.name, months, amountUsd: amountCents / 100, recipientEmail,
    });
    const recorded = await repo.recordGiftRedemptionForUser({
      id: redemptionId, userId: user.id, plan: plan.id, months, amountCents, feeCents, recipientEmail,
    });
    if (!recorded) return json(res, 409, { error: "insufficient credits" });

    // User-facing emails are best-effort — a mail hiccup must never fail a
    // redemption that's already committed to the ledger.
    try {
      await mailer.sendRedemptionConfirmationEmail(recipientEmail, { planName: plan.name, months, amountUsd: amountCents / 100 });
    } catch (err) { console.error("[dwell] redemption confirmation email failed:", err.message); }
    if (recorded.reward?.referrerEmail) {
      try {
        await mailer.sendReferralRewardEmail(recorded.reward.referrerEmail, { rewardUsd: recorded.reward.rewardMillicents / 100000, link: `${config.siteUrl}/portal.html` });
      } catch (err) { console.error("[dwell] referral reward email failed:", err.message); }
    }

    const after = await repo.balanceForUser(user.id);
    json(res, 200, {
      ok: true, redemptionId, plan: plan.id, months,
      amountUsd: amountCents / 100,
      feeUsd: feeCents / 100,
      totalUsd: totalCents / 100,
      balanceUsd: after.balanceMillicents / 100000,
      deliveryWindowHours: 48,
    });
  });

  // ---------- web payouts: on-demand cash out (Stripe Connect) ----------
  // Mirrors the redemption trust model: money out only behind a web session.
  // Debit-first — the balance is charged inside a transaction before the Stripe
  // transfer fires, and reversed if the transfer fails, so a crash between the
  // two can never pay twice. The protocol keeps payoutFeeBps of the gross.
  route("POST", "/v1/web/connect/onboard", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    if (!user.email_verified) return json(res, 403, { error: "verify your email first" });

    let accountId = user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.createAccount({
        type: "express", email: user.email,
        capabilities: { transfers: { requested: true } }, business_type: "individual",
      });
      accountId = account.id;
      await repo.setStripeAccount(user.id, accountId);
    }
    const link = await stripe.createAccountLink({
      account: accountId, type: "account_onboarding",
      refresh_url: `${config.siteUrl}/portal.html?onboarding=retry`,
      return_url: `${config.siteUrl}/portal.html?onboarding=done`,
    });
    json(res, 200, { onboardingUrl: link.url });
  });

  route("GET", "/v1/web/payouts", async (req, res, body, rawBody, query) => {
    const user = await repo.userForSession(sessionFrom(req, body, query));
    if (!user) return json(res, 401, { error: "not signed in" });
    const balance = await repo.balanceForUser(user.id);
    json(res, 200, {
      payoutsEnabled: !!user.payouts_enabled,
      hasStripeAccount: !!user.stripe_account_id,
      thresholdUsd: config.payoutThresholdCents / 100,
      payoutFeeBps: config.payoutFeeBps,
      balanceUsd: balance.balanceMillicents / 100000,
      payouts: await repo.payoutsForUser(user.id),
    });
  });

  // One attempt per user per minute, in-process. Belt-and-braces only — the
  // debit-first transaction in recordPayoutRequest is the real double-spend guard.
  const lastPayoutAttempt = new Map();
  route("POST", "/v1/web/payouts/request", async (req, res, body) => {
    const user = await repo.userForSession(sessionFrom(req, body));
    if (!user) return json(res, 401, { error: "not signed in" });
    if (!user.stripe_account_id || !user.payouts_enabled) {
      return json(res, 403, { error: "set up payouts with Stripe first" });
    }
    const last = lastPayoutAttempt.get(user.id) || 0;
    if (Date.now() - last < 60000) return json(res, 429, { error: "try again in a minute" });
    lastPayoutAttempt.set(user.id, Date.now());

    const balance = await repo.balanceForUser(user.id);
    const grossCents = Math.floor(balance.balanceMillicents / 1000); // pay whole cents only
    if (grossCents < config.payoutThresholdCents) {
      return json(res, 403, {
        error: "balance below payout threshold",
        thresholdUsd: config.payoutThresholdCents / 100,
        balanceUsd: balance.balanceMillicents / 100000,
      });
    }
    const feeCents = Math.ceil((grossCents * config.payoutFeeBps) / 10000);
    const netCents = grossCents - feeCents;
    if (netCents <= 0) return json(res, 403, { error: "balance too small to pay out" });

    // Manual model: queue the request (funds held via the debit) and stop. No
    // money moves until an admin approves it — so nothing here transfers, and
    // the response says nothing about how the request is reviewed.
    const requested = await repo.recordPayoutRequest({ userId: user.id, grossCents, feeCents });
    if (!requested) return json(res, 409, { error: "insufficient credits" });

    const after = await repo.balanceForUser(user.id);
    json(res, 200, {
      ok: true,
      requested: true,
      grossUsd: grossCents / 100,
      feeUsd: feeCents / 100,
      netUsd: netCents / 100,
      balanceUsd: after.balanceMillicents / 100000,
    });
  });

  // ---------- moderation ----------
  route("GET", "/v1/admin/campaigns", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    json(res, 200, { campaigns: await repo.pendingReviewCampaigns() });
  });

  // Full campaign list + realized metrics for the admin Ads view (mirrors the edge
  // function's /v1/admin/campaigns/all; clicks/CTR/CPC/eCPM derived from the ledger).
  route("GET", "/v1/admin/campaigns/all", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    const rows = await repo.adminCampaigns({
      status: query.get("status") || null,
      limit: query.get("limit"), offset: query.get("offset"),
    });
    json(res, 200, { campaigns: rows.map((c) => {
      const m = adMetrics(c.recognized_millicents, c.impressions_shown, c.clicks);
      return {
        id: c.id, brand: c.brand, adLine: c.ad_line, url: c.url, category: c.category, status: c.status,
        bidUsd: c.price_per_block_cents / 100, blocks: c.blocks,
        impressionsTotal: c.impressions_total, impressionsRemaining: c.impressions_remaining, impressionsServed: c.impressions_served,
        showOnLeaderboard: c.show_on_leaderboard, reviewNote: c.review_note,
        recognizedUsd: mcUsd(c.recognized_millicents), advertiserEmail: c.advertiser_email,
        clicks: m.clicks, impressionsShown: m.impressionsShown, ctr: m.ctr, cpcUsd: m.cpcUsd, ecpmUsd: m.ecpmUsd, spendUsd: m.spendUsd,
        completionEmailSentAt: c.completion_email_sent_at,
        createdAt: c.created_at, paidAt: c.paid_at, activatedAt: c.activated_at,
      };
    }) });
  });

  // Per-advertiser rollup (one row per advertiser; aggregates across their campaigns).
  route("GET", "/v1/admin/advertisers", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    const rows = await repo.adminAdvertisers({ limit: query.get("limit"), offset: query.get("offset") });
    json(res, 200, { advertisers: rows.map((a) => {
      const m = adMetrics(a.spend_millicents, a.impressions_shown, a.clicks);
      return {
        id: a.id, email: a.email, createdAt: a.created_at,
        campaigns: Number(a.campaigns), activeCampaigns: Number(a.active_campaigns),
        spendUsd: m.spendUsd, impressionsShown: m.impressionsShown, clicks: m.clicks,
        ctr: m.ctr, cpcUsd: m.cpcUsd, ecpmUsd: m.ecpmUsd,
      };
    }) });
  });

  // ---------- completion-receipt preview + manual send ----------
  // Preview renders the exact email the advertiser would get, plus the stats, and
  // does NOT stamp the campaign (so the admin can look before sending).
  route("GET", "/v1/admin/campaigns/receipt-preview", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    const row = await repo.campaignReceiptData(query.get("campaignId"));
    if (!row) return json(res, 404, { error: "campaign not found" });
    const stats = receiptStats(row);
    const { subject, html } = mailer.buildCampaignCompletedEmail(stats);
    json(res, 200, { subject, html, stats, alreadySent: !!row.completion_email_sent_at });
  });

  // Manually email the advertiser their campaign-finished receipt. Once-only via an
  // atomic claim; { force:true } clears any prior stamp first to deliberately resend.
  route("POST", "/v1/admin/campaigns/send-receipt", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const campaignId = body.campaignId;
    const row = await repo.campaignReceiptData(campaignId);
    if (!row) return json(res, 404, { error: "campaign not found" });
    if (row.status !== "exhausted") return json(res, 400, { error: "campaign not finished" });
    if (body.force) await repo.clearCampaignReceipt(campaignId);
    const claim = await repo.claimCampaignReceipt(campaignId);
    if (!claim) return json(res, 200, { ok: true, alreadySent: true });
    try {
      await mailer.sendCampaignCompletedEmail(row.advertiser_email, receiptStats(row));
    } catch (err) {
      await repo.clearCampaignReceipt(campaignId); // roll back so the admin can retry
      return json(res, 502, { error: "send failed" });
    }
    json(res, 200, { ok: true, sentAt: claim.sentAt });
  });

  // ---------- public "Live bid market" leaderboard visibility (off by default) ----------
  route("GET", "/v1/admin/leaderboard-visibility", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    let isPublic = false;
    try { isPublic = (await repo.getSetting("leaderboard_public")) === true; } catch { /* settings table absent */ }
    json(res, 200, { public: isPublic });
  });
  route("POST", "/v1/admin/leaderboard-visibility", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    if (typeof body.public !== "boolean") return json(res, 400, { error: "public (boolean) required" });
    await repo.setSetting("leaderboard_public", body.public);
    json(res, 200, { ok: true, public: body.public });
  });

  // ---------- CPM slider "live top CPM" ghost toggle (off by default) ----------
  route("GET", "/v1/admin/live-top-cpm", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    let enabled = false;
    try { enabled = (await repo.getSetting("live_top_cpm")) === true; } catch { /* settings table absent */ }
    json(res, 200, { enabled });
  });
  route("POST", "/v1/admin/live-top-cpm", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled (boolean) required" });
    await repo.setSetting("live_top_cpm", body.enabled);
    json(res, 200, { ok: true, enabled: body.enabled });
  });

  // ---------- portal "not serving ads" notice visibility (off by default) ----------
  route("GET", "/v1/admin/ad-notice", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    let visible = false;
    try { visible = (await repo.getSetting("ad_notice_visible")) === true; } catch { /* settings table absent */ }
    json(res, 200, { visible });
  });
  route("POST", "/v1/admin/ad-notice", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    if (typeof body.visible !== "boolean") return json(res, 400, { error: "visible (boolean) required" });
    await repo.setSetting("ad_notice_visible", body.visible);
    json(res, 200, { ok: true, visible: body.visible });
  });

  // ---------- completion-receipt auto-send toggle + batched sweep ----------
  route("GET", "/v1/admin/campaigns/receipts-auto", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    let enabled = false;
    try { enabled = (await repo.getSetting("receipts_auto_send")) === true; } catch { /* settings table absent */ }
    json(res, 200, { enabled });
  });
  route("POST", "/v1/admin/campaigns/receipts-auto", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled (boolean) required" });
    await repo.setSetting("receipts_auto_send", body.enabled);
    json(res, 200, { enabled: body.enabled });
  });
  // Batched sweep: emails a completion receipt to every exhausted campaign that hasn't
  // had one. A no-op while auto-send is off, unless { force:true } (the admin "Send
  // now"). Built to be poked by a scheduler; the toggle is the safety switch.
  route("POST", "/v1/admin/campaigns/receipts-sweep", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    let enabled = false;
    try { enabled = (await repo.getSetting("receipts_auto_send")) === true; } catch { /* settings table absent */ }
    if (!enabled && !(body && body.force)) return json(res, 200, { enabled: false, sent: 0, candidates: 0 });
    const ids = await repo.pendingReceiptCampaignIds(200);
    let sent = 0, failed = 0;
    for (const id of ids) {
      const claim = await repo.claimCampaignReceipt(id);
      if (!claim) continue;
      try {
        const row = await repo.campaignReceiptData(id);
        await mailer.sendCampaignCompletedEmail(row.advertiser_email, receiptStats(row));
        sent++;
      } catch (err) {
        await repo.clearCampaignReceipt(id);
        failed++;
        console.error("[dwell] receipt sweep send failed:", err.message);
      }
    }
    json(res, 200, { enabled: true, sent, failed, candidates: ids.length });
  });

  route("POST", "/v1/admin/campaigns/approve", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const ok = await repo.approveCampaign(body.campaignId);
    json(res, ok ? 200 : 404, { ok });
  });

  route("POST", "/v1/admin/campaigns/reject", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const result = await repo.rejectCampaign(body.campaignId, body.note);
    if (!result) return json(res, 404, { ok: false });
    if (result.paymentIntentId) {
      try { await stripe.createRefund({ payment_intent: result.paymentIntentId }); }
      catch (err) { console.error("[dwell] refund failed:", err.message); }
    }
    // Tell the advertiser their campaign was rejected + refunded. Wrapped so a
    // mail failure never fails the moderation action (already committed above).
    try {
      await mailer.sendCampaignRejectedEmail(result.email, {
        campaignId: body.campaignId,
        brand: result.brand,
        adLine: result.adLine,
        pricePerBlockCents: result.pricePerBlockCents,
        blocks: result.blocks,
        note: result.note,
      });
    } catch (err) {
      console.error("[dwell] rejection email failed:", err.message);
    }
    json(res, 200, { ok: true, refunded: !!result.paymentIntentId });
  });

  // ---------- affiliate review ----------
  route("GET", "/v1/admin/affiliates", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    json(res, 200, { affiliates: await repo.listAffiliateApplications() });
  });

  route("POST", "/v1/admin/affiliates/approve", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const result = await repo.approveAffiliate(body.affiliateId);
    json(res, result ? 200 : 404, result ? { ok: true, code: result.code } : { ok: false });
  });

  route("POST", "/v1/admin/affiliates/reject", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const result = await repo.rejectAffiliate(body.affiliateId, body.note);
    json(res, result ? 200 : 404, { ok: !!result });
  });

  // Grant an influencer upgrade: custom rate, raised/uncapped cap, optional code.
  route("POST", "/v1/admin/affiliates/grant", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const rewardBps = Number(body.rewardBps);
    const capPeople = Number(body.capPeople);
    if (!Number.isInteger(rewardBps) || rewardBps < 1 || rewardBps > 10000) return json(res, 400, { error: "rewardBps must be 1–10000 (0.01%–100%)" });
    if (!Number.isInteger(capPeople) || capPeople < 0) return json(res, 400, { error: "capPeople must be a whole number ≥ 0" });
    const result = await repo.grantAffiliateUpgrade(body.affiliateId, { rewardBps, capPeople, code: body.code });
    json(res, result.ok ? 200 : (result.error === "not found" ? 404 : 400), result);
  });

  // Minimal moderation UI. Admin key passed in the query; ad lines are escaped.
  route("GET", "/admin", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return html(res, 401, "<h1>401</h1><p>Append ?adminKey=…</p>");
    const key = escapeHtml(query.get("adminKey") || "");
    const list = await repo.pendingReviewCampaigns();
    const rows = list.map((c) => `
      <tr>
        <td>${escapeHtml(c.brand || "—")}</td>
        <td class="line">${escapeHtml(c.ad_line)}</td>
        <td><a href="${escapeHtml(c.url)}" rel="noopener noreferrer nofollow" target="_blank">link</a></td>
        <td>$${(c.price_per_block_cents / 100).toFixed(2)} × ${c.blocks}</td>
        <td>
          <button onclick="act('approve','${escapeHtml(c.id)}')">Approve</button>
          <button class="rej" onclick="act('reject','${escapeHtml(c.id)}')">Reject</button>
        </td>
      </tr>`).join("");
    html(res, 200, `<!doctype html><meta charset=utf-8><title>DWELL moderation</title>
<style>body{font:14px system-ui;margin:40px;max-width:900px}table{width:100%;border-collapse:collapse}
td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}.line{font-family:monospace}
button{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
button.rej{border-color:#e33;color:#e33}h1{font-size:20px}</style>
<h1>Pending review (${list.length})</h1>
<table><tr><th>Brand</th><th>Ad line</th><th>URL</th><th>Bid</th><th></th></tr>${rows || '<tr><td colspan=5>Nothing to review 🎉</td></tr>'}</table>
<script>
const KEY=${JSON.stringify(query.get("adminKey") || "")};
async function act(kind,id){
  const note = kind==='reject' ? prompt('Reason (optional):') || '' : '';
  await fetch('/v1/admin/campaigns/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminKey:KEY,campaignId:id,note})});
  location.reload();
}
</script>`);
  });

  // ---------- killswitch ----------
  route("POST", "/v1/admin/killswitch", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    if (typeof body.serving !== "boolean") return json(res, 400, { error: "serving (boolean) required" });
    serving = body.serving;
    json(res, 200, { ok: true, serving });
  });

  // ---------- payouts sweep ----------
  route("POST", "/v1/admin/payouts", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    json(res, 200, await runPayouts({ repo, stripe, config }));
  });

  // ---------- manual payout approval (admin) ----------
  // Server-side X (Twitter) check that a user's onboarding post is live on their
  // timeline. Admin payout review ONLY — never called from an earner path and
  // never surfaced in the portal. Persists the result and returns a status the
  // admin UI renders as a badge.
  function onboardingPostMatches(t) {
    const text = String(t?.text || "");
    if (/dwellprotocol\.com/i.test(text) || /@dwellprotocol/i.test(text)) return true;
    const urls = (t && t.entities && t.entities.urls) || [];
    return urls.some((u) => /dwellprotocol\.com/i.test((u && (u.expanded_url || u.url)) || ""));
  }
  async function verifyOnboardingPost(u) {
    if (!u.twitter_id) return { status: "no_x_account" };
    if (!config.twitterBearerToken) return { status: "unconfigured" };
    try {
      const url = `https://api.twitter.com/2/users/${encodeURIComponent(u.twitter_id)}/tweets` +
        `?max_results=100&exclude=retweets,replies&tweet.fields=entities`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${config.twitterBearerToken}` } });
      const data = await r.json();
      const tweets = Array.isArray(data && data.data) ? data.data : [];
      const hit = tweets.find((t) => onboardingPostMatches(t));
      if (hit) {
        const postUrl = `https://x.com/i/status/${hit.id}`;
        await repo.saveOnboardingPostVerification(u.id, { url: postUrl });
        return { status: "verified", url: postUrl };
      }
      await repo.saveOnboardingPostVerification(u.id, { url: null });
      return { status: "not_found" };
    } catch (err) {
      console.error("[dwell] onboarding post verify:", err.message);
      return { status: "error", error: err.message };
    }
  }
  // Derive the admin-facing verification status from stored fields (no network).
  function onboardingPostStatus(u) {
    if (u.onboarding_post_verified_at) return "verified";
    if (!u.twitter_id) return "no_x_account";
    if (u.onboarding_post_checked_at) return "not_found";
    return "unchecked";
  }
  function payoutRequestView(r) {
    return {
      payoutId: r.id, userId: r.user_id, email: r.email,
      twitterId: r.twitter_id || null,
      grossUsd: (r.gross_cents || 0) / 100,
      feeUsd: (r.fee_cents || 0) / 100,
      netUsd: (r.net_cents || 0) / 100,
      requestedAt: r.created_at,
      stripeReady: !!(r.stripe_account_id && r.payouts_enabled),
      postedAt: r.onboarding_posted_at,
      postStatus: onboardingPostStatus(r),
      postUrl: r.onboarding_post_url || null,
      postCheckedAt: r.onboarding_post_checked_at,
    };
  }

  route("GET", "/v1/admin/payouts/requests", async (req, res, body, rawBody, query) => {
    if (!adminOk(req, body, query)) return json(res, 401, { error: "bad admin key" });
    const rows = await repo.listPayoutRequests();
    json(res, 200, { requests: rows.map(payoutRequestView) });
  });

  // Re-run the X verification for one user and return the fresh status. Admin
  // clicks this from the payout review before approving.
  route("POST", "/v1/admin/payouts/verify-post", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const u = await repo.userForAdmin(body?.userId);
    if (!u) return json(res, 404, { error: "user not found" });
    const result = await verifyOnboardingPost(u);
    json(res, 200, result);
  });

  route("POST", "/v1/admin/payouts/requests/approve", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const claimed = await repo.claimPayoutRequest(body?.payoutId);
    if (!claimed) return json(res, 409, { error: "request not found or already handled" });
    if (!claimed.stripeAccountId || !claimed.payoutsEnabled) {
      await repo.releasePayoutClaim(claimed.id); // leave it queued, funds still held
      return json(res, 409, { error: "user has no active Stripe payouts account" });
    }
    try {
      const transfer = await stripe.createTransfer({
        amount: claimed.netCents, currency: "usd", destination: claimed.stripeAccountId,
        transfer_group: `payout_${claimed.userId}_${claimed.id}`,
      });
      await repo.finalizePayout(claimed.id, { transferId: transfer.id });
    } catch (err) {
      console.error("[dwell] payout approve transfer failed:", err.message);
      await repo.finalizePayout(claimed.id, { failed: true, userId: claimed.userId, grossCents: claimed.grossCents, feeCents: claimed.feeCents });
      return json(res, 502, { error: "transfer failed — the request was reversed and the balance restored" });
    }
    json(res, 200, { ok: true, netUsd: claimed.netCents / 100 });
  });

  route("POST", "/v1/admin/payouts/requests/reject", async (req, res, body) => {
    if (!adminOk(req, body)) return json(res, 401, { error: "bad admin key" });
    const rejected = await repo.rejectPayoutRequest(body?.payoutId);
    if (!rejected) return json(res, 409, { error: "request not found or already handled" });
    json(res, 200, { ok: true, restoredUsd: rejected.grossCents / 100 });
  });

  // ---------- server plumbing ----------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, "http://localhost");

    // CORS preflight
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

    // rate limit by client IP
    if (rateLimiter) {
      const ip = clientIp(req) || "?";
      if (!rateLimiter.take(ip)) return json(res, 429, { error: "rate limited" });
    }

    // resolve handler (exact, then param routes)
    let handler = exact.get(`${req.method} ${url.pathname}`);
    let routeParams = {};
    if (!handler) {
      for (const r of params) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.regex);
        if (m) { handler = r.handler; r.keys.forEach((k, i) => (routeParams[k] = decodeURIComponent(m[i + 1]))); break; }
      }
    }
    if (!handler) return json(res, 404, { error: "not found" });

    // read body with a size cap
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > config.maxBodyBytes) { json(res, 413, { error: "payload too large" }); req.destroy(); return; }
        chunks.push(chunk);
      }
    } catch { return; }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); }
      catch { return json(res, 400, { error: "invalid json" }); }
    }

    try {
      await handler(req, res, body, rawBody, url.searchParams, routeParams);
    } catch (err) {
      console.error(`[dwell] ${req.method} ${url.pathname} failed:`, err.message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    } finally {
      if (config.logRequests !== false) {
        console.log(`[dwell] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  return { server };
}

module.exports = { createApp };
