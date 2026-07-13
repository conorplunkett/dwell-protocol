// @ts-nocheck
// DWELL API — full port of the node:http server (server/src/*) to a single
// Supabase Edge Function (Deno). Replaces the Fly.io deployment.
//
// Faithful port: every route, the exact SQL, the millicent BigInt math, the
// transaction-scoped advisory locks, Stripe webhook verification, and the
// Google/Apple OAuth flows are preserved. The data layer uses postgres.js
// behind a node-postgres-shaped shim so server/src/repo.js transfers almost
// verbatim (same Pool/client API).
//
// Routing: this function is deployed under the slug `dwell-api`, so the public
// base is https://<ref>.supabase.co/functions/v1/dwell-api and requests arrive
// as /dwell-api/v1/...  — we strip the slug prefix and route on the original paths.
// Deployed with verify_jwt=false: the API does its own auth (web-session
// tokens, device keys, admin key, OAuth, Stripe signatures), not Supabase JWTs.
//
// Differences from the Node server (see supabase/functions/README.md):
//  - the in-memory per-IP token-bucket rate limiter is dropped (Edge Functions
//    are stateless); the DB-backed per-device/-IP fraud caps in ingestBatch and
//    redeemClickToken are unchanged and remain the real abuse controls.
//  - the runtime killswitch toggle is per-isolate only; `serving` is derived
//    from the KILLSWITCH env on each cold start.
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import postgres from "npm:postgres@3.4.4";

// Crew = the affiliate "earn with your friends" panel in the extension popup.
// Ten slots: each is a joined friend, a pending invite, or an open invite form.
const CREW_SIZE = 10;

// ───────────────────────────── config ──────────────────────────────────────
const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
function loadConfig() {
  const siteUrl = env("SITE_URL", "https://dwellprotocol.com");
  return {
    databaseUrl: env("SUPABASE_DB_URL") || env("DATABASE_URL"),
    stripeSecretKey: env("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET"),
    // Connect (connected-account) events arrive on a separate event destination
    // with its own signing secret, so we verify webhooks against either.
    stripeConnectWebhookSecret: env("STRIPE_CONNECT_WEBHOOK_SECRET"),
    siteUrl,
    // Where Stripe/OAuth/magic-link callbacks point. Defaults to this function.
    apiBaseUrl: env("API_BASE_URL") || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/dwell-api` : ""),
    corsOrigin: env("CORS_ORIGIN") || siteUrl,
    adminKey: env("ADMIN_KEY"),
    killswitch: env("KILLSWITCH") === "1",
    revenueShare: parseFloat(env("REVENUE_SHARE", "0.5")),
    grossCpmCents: parseInt(env("GROSS_CPM_CENTS", "1200"), 10),
    dailyImpressionCap: parseInt(env("DAILY_IMPRESSION_CAP", "5000"), 10),
    ipDailyImpressionCap: parseInt(env("IP_DAILY_IMPRESSION_CAP", "5000"), 10), // per source IP per UTC day; 0 disables
    // Killswitch for the legacy self-reported /v1/events credit path (the open
    // forgery surface — see FORGERY-SURFACE.md). Set LEGACY_EVENTS_CREDIT=0
    // once token-path adoption is high; forged batches then credit nothing.
    legacyEventsCredit: env("LEGACY_EVENTS_CREDIT") !== "0",
    dailyClickCap: parseInt(env("DAILY_CLICK_CAP", "100"), 10),
    leadDailyCap: parseInt(env("LEAD_IP_DAILY_CAP", "100"), 10), // bare-email waitlist captures per source IP per UTC day; 0 disables
    payoutThresholdCents: parseInt(env("PAYOUT_THRESHOLD_CENTS", "1000"), 10),
    payoutFeeBps: parseInt(env("PAYOUT_FEE_BPS", "1000"), 10), // protocol's cut of a cash payout, basis points (1000 = 10%)
    redemptionFeeBps: parseInt(env("REDEMPTION_FEE_BPS", "1000"), 10), // legacy fee-on-top for Claude-credit redemptions; superseded by redemptionBoostBps when set
    redemptionBoostBps: parseInt(env("REDEMPTION_BOOST_BPS", "1000"), 10), // tokenomics v2: dwells buy Claude credits at a boost (1000 = balance worth 110% on this path)
    stripePayoutsEnabled: env("STRIPE_PAYOUTS_ENABLED", "false") === "true", // v2: cash payouts retired in favor of USDC
    referralRewardCents: parseInt(env("REFERRAL_REWARD_CENTS", "2000"), 10),
    referralCap: parseInt(env("REFERRAL_CAP", "10"), 10),
    affiliateRewardBps: parseInt(env("AFFILIATE_REWARD_BPS", "1000"), 10), // affiliate's cut, basis points (1000 = 10%)
    affiliateCapPeople: parseInt(env("AFFILIATE_CAP_PEOPLE", "1000"), 10), // max attributed friends per affiliate (dollar earnings uncapped)
    giftFulfillmentEmail: env("GIFT_FULFILLMENT_EMAIL", "hello@dwellprotocol.com"),
    emailTokenTtlMs: parseInt(env("EMAIL_TOKEN_TTL_MS", "1800000"), 10),
    emailCooldownMs: parseInt(env("EMAIL_COOLDOWN_MS", "60000"), 10), // min gap between magic-link sends per email; 0 disables. DB-backed, so it holds even though the in-memory rate limiter is dropped here.
    emailIpDailyCap: parseInt(env("EMAIL_IP_DAILY_CAP", "50"), 10), // magic-link/login email sends per source IP per UTC day; 0 disables (shared-NAT/CGNAT). DB-backed replacement for the dropped per-IP limiter.
    webSessionTtlMs: parseInt(env("WEB_SESSION_TTL_MS", "2592000000"), 10),
    clickTokenTtlMs: parseInt(env("CLICK_TOKEN_TTL_MS", "120000"), 10),
    impressionTokenTtlMs: parseInt(env("IMPRESSION_TOKEN_TTL_MS", "120000"), 10), // 2 min: enough to dwell + redeem a served impression
    impressionMinDwellMs: parseInt(env("IMPRESSION_MIN_DWELL_MS", "2000"), 10), // server backstop: min ms between serve and a billable redeem. The client's on-screen qualifying view (~2s) is the real gate; this just rejects a too-fast redeem. 0 disables
    maxBodyBytes: parseInt(env("MAX_BODY_BYTES", "65536"), 10),
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
    appleClientId: env("APPLE_CLIENT_ID"),
    appleTeamId: env("APPLE_TEAM_ID"),
    appleKeyId: env("APPLE_KEY_ID"),
    applePrivateKey: env("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
    // X sign-in uses OAuth 2.0 Authorization Code + PKCE (the OAuth 2.0 Client
    // ID/Secret from the X developer portal, not the OAuth 1.0a API key pair).
    twitterClientId: env("TWITTER_CLIENT_ID"),
    twitterClientSecret: env("TWITTER_CLIENT_SECRET"),
    twitterBearerToken: env("TWITTER_BEARER_TOKEN"),
    mailProvider: env("MAIL_PROVIDER", "console"),
    resendApiKey: env("RESEND_API_KEY"),
    mailFrom: env("MAIL_FROM"),
    mailFromAds: env("MAIL_FROM_ADS"),
    // Resend segment that waitlist contacts are added to, so the launch-day
    // broadcast targets exactly them. Not a secret (just an id; the project ref
    // is already public) — overridable via env. Empty disables segment tagging.
    resendWaitlistSegmentId: env("RESEND_WAITLIST_SEGMENT_ID", "758789ec-3294-4ba5-90ac-765f5d6765e1"),

    // ---- DWELL token mode (dwell/docs/04) — one codebase, two deployments ----
    // '' (default) keeps the legacy DWELL behavior byte-identical: two-way
    // revenueShare split, no token machinery, token routes 404. The DWELL
    // deployment defaults to points (accrual phase); TOKEN_MODE=live post-TGE,
    // TOKEN_MODE=off for a legacy two-way-split instance (not used by DWELL).
    tokenMode: ["points", "live"].includes(env("TOKEN_MODE")) ? env("TOKEN_MODE") : (env("TOKEN_MODE") === "off" ? "" : "points"),
    // DWELL's own Postgres schema — top-level isolation inside a shared database.
    dbSchema: env("DB_SCHEMA", "dwell"),
    viewerShareBps: parseInt(env("VIEWER_SHARE_BPS", "6000"), 10), // viewer's share of the reserve tranche
    referrerShareBps: parseInt(env("REFERRER_SHARE_BPS", "1000"), 10), // referrer's share (falls to protocol when unreferred)
    reserveTrancheBps: parseInt(env("RESERVE_TRANCHE_BPS", "9000"), 10), // slice of gross routed to the token side

    // ---- Crypto advertiser checkout (dwell/docs/08, tokenomics v2) ----
    // Checkout is non-custodial: no leg of any payment buys $DWELL (docs/01),
    // the backend builds unsigned transactions and verifies finalized ones
    // read-only. USDC/SOL rails are live once the treasury + revenue accounts
    // are set — no dependency on the token existing. The $DWELL rail (a single
    // transfer to the treasury at a spot quote) opens at token launch:
    // DWELL_MINT + TREASURY_DWELL_ATA gate that one rail only.
    // SOL/$DWELL payments are HELD during review, then hedged: on admin accept
    // the treasury signer swaps them to USDC at the acceptance-time rate (the
    // realized USDC funds the campaign); on reject it refunds the payer
    // in-kind on-chain. That signer is the only key the backend holds, and it
    // is used exclusively by those two paths.
    dwellMint: env("DWELL_MINT"),
    usdcMint: env("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // canonical USDC on Solana mainnet (6 dp)
    solanaRpcUrl: env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    jupiterBaseUrl: env("JUPITER_BASE_URL", "https://lite-api.jup.ag/swap/v1"), // pricing quotes at checkout; /swap executes ONLY the acceptance-time hedge
    treasuryUsdcAta: env("TREASURY_USDC_ATA"),           // company treasury USDC account — the protocol-fee leg
    revenueUsdcAta: env("REVENUE_USDC_ATA"),             // company revenue USDC account — the rewards-pool leg (funds dwell payouts)
    treasurySolAccount: env("TREASURY_SOL_ACCOUNT"),     // treasury address for native-SOL fee legs; empty = SOL rail off
    revenueSolAccount: env("REVENUE_SOL_ACCOUNT"),       // revenue address for native-SOL rewards-pool legs
    treasuryDwellAta: env("TREASURY_DWELL_ATA"),         // treasury $DWELL account — the whole $DWELL-rail payment lands here, held (docs/01)
    dwellDecimals: parseInt(env("DWELL_DECIMALS", "6"), 10), // display only — raw DWELL units ÷ 10^decimals for the "≈ pay in $DWELL" figure
    dwellPayBoostBps: parseInt(env("DWELL_PAY_BOOST_BPS", "1000"), 10), // paying in $DWELL boosts a campaign's impressions by this (1000 = +10%)
    maxSlippageBps: parseInt(env("MAX_SLIPPAGE_BPS", "100"), 10), // slippageBps param on pricing quotes (checkout never swaps)
    treasurySignerSecret: env("TREASURY_SIGNER_SECRET"),          // base58 64-byte ed25519 keypair; swap-on-accept + refund-on-reject ONLY
    swapSlippageBps: parseInt(env("SWAP_SLIPPAGE_BPS", "100"), 10), // execution slippage bound on the acceptance-time hedge swap
    usdcOrderTtlMinutes: parseInt(env("USDC_ORDER_TTL_MINUTES", "30"), 10), // price validity window; each built tx is only ~60s (blockhash)

    // ---- brand — the DWELL deployment bills and writes copy under its own name ----
    brandName: env("BRAND_NAME", "DWELL"),
    stripeProductName: env("STRIPE_PRODUCT_NAME", "DWELL ad campaign"),
    stripeProductImage: env("STRIPE_PRODUCT_IMAGE", "https://dwellprotocol.com/og.png"),
  };
}
// Base58 tables live up here because the treasury-signer boot check below
// base58-decodes TREASURY_SIGNER_SECRET at module scope — as consts they must
// initialize before that runs (the hoisted function declarations alone don't).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = Object.fromEntries([...B58_ALPHABET].map((c, i) => [c, BigInt(i)]));

const config = loadConfig();
// Token-mode split sanity (dwell/docs/04 §C): the pool must cover both shares.
if (config.viewerShareBps + config.referrerShareBps > 10000) {
  throw new Error("VIEWER_SHARE_BPS + REFERRER_SHARE_BPS must be <= 10000");
}
if (config.reserveTrancheBps > 10000) throw new Error("RESERVE_TRANCHE_BPS must be <= 10000");
// Crypto checkout (dwell/docs/08 v2): half-configured rails would build
// transactions that can never verify — require account pairs together.
// These are config MISTAKES in an optional feature, not reasons to refuse
// to boot: a bad crypto env var must not take down checkout, login, ads, and
// every other unrelated route on this shared edge function. Collect the
// problem into config.cryptoConfigError instead of throwing; requireSigner()
// (the only place that actually spends from the treasury) refuses with this
// message until it's fixed, and everything else keeps working.
try {
  if ((config.treasuryUsdcAta || config.revenueUsdcAta) && !(config.treasuryUsdcAta && config.revenueUsdcAta)) {
    throw new Error("crypto checkout needs BOTH TREASURY_USDC_ATA and REVENUE_USDC_ATA");
  }
  if ((config.treasurySolAccount || config.revenueSolAccount) && !(config.treasurySolAccount && config.revenueSolAccount)) {
    throw new Error("the SOL rail needs BOTH TREASURY_SOL_ACCOUNT and REVENUE_SOL_ACCOUNT");
  }
  if (config.dwellMint && !config.treasuryDwellAta) {
    throw new Error("DWELL_MINT is set — TREASURY_DWELL_ATA is required for the $DWELL rail");
  }
  // Treasury signer (hedging): swaps/refunds move funds FROM the treasury
  // accounts, so the signer must own them. On the SOL rail both legs land in
  // system accounts we can check offline; the ATA ownership (DWELL/USDC) is a
  // documented going-live requirement (dwell/docs/10).
  if (config.treasurySignerSecret) {
    const signerPub = signerPubkeyFromSecret(config.treasurySignerSecret); // throws on a malformed secret
    if (config.treasurySolAccount && signerPub !== config.treasurySolAccount) {
      throw new Error(`TREASURY_SIGNER_SECRET's pubkey (${signerPub}) must equal TREASURY_SOL_ACCOUNT (${config.treasurySolAccount}) — swaps/refunds spend from it`);
    }
    if (config.revenueSolAccount && signerPub !== config.revenueSolAccount) {
      // A SOL payment splits across both accounts but swaps/refunds move the
      // FULL received amount from the signer — keep both legs on its key.
      console.warn("[dwell] REVENUE_SOL_ACCOUNT differs from the treasury signer — SOL swaps/refunds spend the full received amount from the signer account; sweep the revenue leg to it or set both to the signer's pubkey.");
    }
  } else if (config.treasurySolAccount || config.treasuryDwellAta) {
    console.warn("[dwell] SOL/$DWELL rails are configured without TREASURY_SIGNER_SECRET — campaign accepts (hedge swap) and rejects (on-chain refund) on those rails will fail until it is set.");
  }
} catch (err: any) {
  config.cryptoConfigError = err.message;
  console.error(`[dwell] crypto config error (SOL/USDC/DWELL rails disabled until fixed): ${err.message}`);
}
// When TOKEN_MODE is set, impressions split three ways into points entries
// instead of the legacy two-way credit (passed into ingestBatch/redeem/paid).
const tokenSplit = config.tokenMode
  ? {
      reserveTrancheBps: config.reserveTrancheBps,
      viewerShareBps: config.viewerShareBps,
      referrerShareBps: config.referrerShareBps,
    }
  : null;
// What clients should read as "my cut" for their own estimate math. In token
// mode the legacy two-way config.revenueShare (0.5) is never what's actually
// credited — creditTokenSplit() ignores it entirely — so exposing it here
// would understate the real viewer share (reserveTranche × viewerShare).
const displayRevenueShare = tokenSplit
  ? (tokenSplit.reserveTrancheBps / 10000) * (tokenSplit.viewerShareBps / 10000)
  : config.revenueShare;

// ─────────────────────────── postgres pool ─────────────────────────────────
// SUPABASE_DB_URL points at the Supavisor pooler inside the platform network.
// node-postgres (`pg`) cannot load in the Deno edge runtime (it crashes the
// worker at boot), so we use postgres.js — the same driver web-referrals uses.
// prepare:false is required under transaction-mode pooling.
//
// A thin pg-compatible shim (.query → {rows}, .begin(fn) for transactions)
// keeps createRepo — written against node-postgres' Pool/Client API — unchanged,
// including its transaction-scoped advisory locks. Transactions use sql.begin,
// which pins one connection for BEGIN…COMMIT (and pg_advisory_xact_lock).
if (!/^[a-z_][a-z0-9_]*$/.test(config.dbSchema)) throw new Error("DB_SCHEMA must be a plain identifier");
const sql = postgres(config.databaseUrl, { prepare: false, connection: { search_path: config.dbSchema } });
// Under transaction-mode pooling a startup parameter isn't guaranteed to stick
// to the multiplexed server connection, so every unit of work ALSO pins the
// schema transaction-locally (set_config(..., true) resets at COMMIT). Single
// queries run inside a small transaction for the same guarantee.
const pinSchema = (tx: any) => tx.unsafe(`select set_config('search_path', '${config.dbSchema}', true)`);
// Wrap a postgres.js handle (the pool, or a transaction handle) in the
// node-postgres-shaped client createRepo expects: `.query(text, params)` -> {rows}.
const clientFor = (h: any) => ({
  query: async (text: string, params: any[] = []) => {
    const rows = await h.unsafe(text, params);
    return { rows, rowCount: rows.length };
  },
});
const pool = {
  query: (text: string, params: any[] = []) =>
    sql.begin(async (tx: any) => { await pinSchema(tx); return clientFor(tx).query(text, params); }),
  // Transactions use postgres.js's first-class sql.begin: one pinned connection
  // with automatic COMMIT / ROLLBACK-on-throw. This is the reliable path under
  // transaction-mode pooling and keeps our pg_advisory_xact_lock guards correct.
  begin: (fn: any) => sql.begin(async (tx: any) => { await pinSchema(tx); return fn(clientFor(tx)); }),
};

// ───────────────────────────── util.js ─────────────────────────────────────
function escapeHtml(s: any) {
  return String(s == null ? "" : s).replace(/[&<>"'/]/g, (ch: string) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#47;",
  } as any)[ch]);
}
function isCleanAdLine(s: any) {
  if (typeof s !== "string") return false;
  if (s.length < 3 || s.length > 60) return false;
  if (s.includes("<") || s.includes(">")) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
// Guard user-supplied campaign ids before they hit a uuid column: a non-uuid
// value makes Postgres throw (22P02), which would abort a whole batch tx.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: any) {
  return typeof s === "string" && UUID_RE.test(s);
}

// Advertiser accent color, "#rrggbb" or bare "rrggbb" → canonical "#rrggbb",
// else null (client falls back to a per-brand color).
function normalizeHexColor(value: any) {
  if (value == null || value === "") return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

// Recent-change % badge helpers (mirror of server/src/util.js). 'auto' is the
// default and is NOT offered on the public ad form.
const TIMESCALES = ["5m", "15m", "1h", "4h", "1d"];
function normalizeTimescale(value: any) {
  return TIMESCALES.includes(value) ? value : "auto";
}
function resolveChangePct(changes: any, timescale: any) {
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

// ─────────────────────────── giftcards.js ──────────────────────────────────
const GIFT_PLANS: any = {
  pro: { id: "pro", name: "Claude Pro", tagline: "For the curious", monthlyCents: 2000 },
  max5x: { id: "max5x", name: "Claude Max 5x", tagline: "For the enthusiast", monthlyCents: 10000 },
  max20x: { id: "max20x", name: "Claude Max 20x", tagline: "For the power user", monthlyCents: 20000 },
};
const GIFT_MONTHS = [1, 3, 6, 12];
function giftPriceCents(planId: string, months: number) {
  const plan = GIFT_PLANS[planId];
  if (!plan || !GIFT_MONTHS.includes(months)) return null;
  return plan.monthlyCents * months;
}

// ───────────────────────────── stripe.js ───────────────────────────────────
const STRIPE_API = "https://api.stripe.com/v1";
function formEncode(obj: any, prefix = "", out: string[] = []): string {
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item: any, i: number) => {
        if (typeof item === "object") formEncode(item, `${name}[${i}]`, out);
        else out.push(`${name}[${i}]=${encodeURIComponent(item)}`);
      });
    } else if (typeof val === "object") {
      formEncode(val, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(val as any)}`);
    }
  }
  return out.join("&");
}
class StripeError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) {
    super(`Stripe ${status}: ${body?.error?.message || JSON.stringify(body)}`);
    this.status = status; this.body = body;
  }
}
function createStripe(secretKey: string) {
  async function request(method: string, path: string, params?: any) {
    const res = await fetch(STRIPE_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2024-06-20",
      },
      body: params ? formEncode(params) : undefined,
    });
    const body = await res.json();
    if (!res.ok) throw new StripeError(res.status, body);
    return body;
  }
  return {
    createCheckoutSession: (p: any) => request("POST", "/checkout/sessions", p),
    // Recent card charges for the admin transactions view. GET, so the query
    // rides in the path (the shared request() form-encodes into the body). Cap 100.
    listCharges: ({ limit = 25 }: any = {}) =>
      request("GET", `/charges?limit=${encodeURIComponent(Math.max(1, Math.min(100, limit)))}`),
    createRefund: (p: any) => request("POST", "/refunds", p),
    createAccount: (p: any) => request("POST", "/accounts", p),
    createAccountLink: (p: any) => request("POST", "/account_links", p),
    createTransfer: (p: any) => request("POST", "/transfers", p),
    request,
  };
}
function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string, toleranceSec = 300) {
  if (!signatureHeader) return false;
  const parts: any = Object.create(null);
  const v1s: string[] = [];
  for (const piece of signatureHeader.split(",")) {
    const [k, v] = piece.split("=", 2);
    if (k === "v1") v1s.push(v);
    else parts[k.trim()] = v;
  }
  const t = parseInt(parts.t, 10);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1s.some((sig) => {
    try { return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); }
    catch { return false; }
  });
}
const stripe = createStripe(config.stripeSecretKey);

// ───────────────────────────── mailer.js ───────────────────────────────────
function createMailer(cfg: any) {
  const provider = cfg.mailProvider || "console";
  // Per-audience senders. Outbound mail still goes through the legacy
  // Resend-verified contact.freeai.fyi domain (DWELL grew out of freeai.fyi and
  // inherited its verified sending domain) — so recipients see freeai.fyi in the
  // From address even though the brand is DWELL. Sending from a dwellprotocol.com
  // address is rejected by Resend (unverified) and 500s the request. User mail
  // comes from hello@ with replies routed to support@; advertiser mail comes from
  // ads@. Overridable via MAIL_FROM / MAIL_FROM_ADS.
  const userFrom = cfg.mailFrom || "DWELL <hello@contact.freeai.fyi>";
  const adsFrom = cfg.mailFromAds || "DWELL <ads@contact.freeai.fyi>";
  const supportReplyTo = "support@contact.freeai.fyi";
  const adsReplyTo = "ads@contact.freeai.fyi";
  async function send(to: string, subject: string, htmlBody: string, opts: any = {}) {
    const from = opts.from || userFrom;
    const replyTo = opts.replyTo !== undefined ? opts.replyTo : supportReplyTo;
    if (provider === "resend" && cfg.resendApiKey) {
      const payload: any = { from, to, subject, html: htmlBody };
      if (replyTo) payload.reply_to = replyTo;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("resend send failed: " + res.status + " " + (await res.text().catch(() => "")).slice(0, 300));
      return;
    }
    console.log(`[dwell][mail] to=${to} subject="${subject}" from=${from}`);
  }
  const sendAds = (to: string, subject: string, htmlBody: string) => send(to, subject, htmlBody, { from: adsFrom, replyTo: adsReplyTo });
  // ── Branded shell for user-facing emails (sign-in, verify, invites,
  // redemption, reward). Table layout + inline styles so it renders across mail
  // clients; palette mirrors theme.css (DWELL red on white). The advertiser
  // and admin notices further down keep their original plain layout on purpose. ──
  const FONT = "'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const site = cfg.siteUrl || "https://dwellprotocol.com";
  // DWELL eight-dot brand mark — the real assets/logo.svg, pre-rendered to a
  // transparent PNG (web/assets/logo-email.png, served by the site) because
  // mail clients strip inline SVG and data-URI images (Gmail especially).
  function logoMark() {
    return `<img src="${site}/assets/logo-email.png" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border:0;">`;
  }
  function button(href: string, label: string) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto 6px;"><tr>`
      + `<td align="center" bgcolor="#ff0000" style="border-radius:8px;background:#ff0000;background:linear-gradient(180deg,#ff2323,#c00100);">`
      + `<a href="${href}" style="display:inline-block;padding:13px 30px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>`
      + `</td></tr></table>`;
  }
  function shell({ preheader = "", hero = "", heading = "", body = "", cta = null as any, note = "" }: any) {
    const btn = cta ? button(cta.href, cta.label) : "";
    const foot = note ? `<p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.55;color:#909090;">${note}</p>` : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>`
      + `<body style="margin:0;padding:0;background:#f9f9f9;">`
      + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f9f9f9;font-size:1px;line-height:1px;">${preheader}</div>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;"><tr><td align="center" style="padding:30px 16px;">`
      + `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:100%;">`
      + `<tr><td align="center" style="padding:2px 0 24px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>`
      + `<td valign="middle" style="padding-right:11px;">${logoMark()}</td>`
      + `<td valign="middle" style="font-family:${FONT};font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#0f0f0f;">DWELL</td>`
      + `</tr></table></td></tr>`
      + `<tr><td style="background:#ffffff;border:1px solid #eeeeee;border-radius:12px;padding:34px 32px;">`
      + (hero ? `<div style="text-align:center;font-size:40px;line-height:1;margin:0 0 12px;">${hero}</div>` : "")
      + (heading ? `<h1 style="margin:0 0 16px;text-align:center;font-family:${FONT};font-size:21px;font-weight:800;letter-spacing:-0.02em;color:#0f0f0f;">${heading}</h1>` : "")
      + `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:#282828;">${body}</div>${btn}${foot}`
      + `</td></tr>`
      + `<tr><td align="center" style="padding:22px 10px 6px;font-family:${FONT};font-size:12px;line-height:1.7;color:#909090;">`
      + `<a href="${site}" style="color:#bc0100;text-decoration:none;font-weight:700;">dwellprotocol.com</a>`
      + `&nbsp;·&nbsp;<a href="${site}/terms" style="color:#909090;text-decoration:underline;">Terms</a>`
      + `&nbsp;·&nbsp;<a href="${site}/privacy" style="color:#909090;text-decoration:underline;">Privacy</a>`
      + `<br>Earn credits while you use Claude, ChatGPT &amp; Gemini.`
      + `</td></tr></table></td></tr></table></body></html>`;
  }
  // Key/value detail box for the campaign emails — same inset style as the
  // user-email tables, with hairline row separators. Falsy rows are dropped.
  function detail(rows: any[]) {
    const cells = rows.filter(Boolean).map(([k, v]: any, i: number) =>
      `<tr><td style="padding:8px 16px;font-family:${FONT};font-size:13px;color:#606060;${i ? "border-top:1px solid #eeeeee;" : ""}">${k}</td>`
      + `<td style="padding:8px 16px;font-family:${FONT};font-size:13px;font-weight:600;color:#0f0f0f;text-align:right;${i ? "border-top:1px solid #eeeeee;" : ""}">${v}</td></tr>`).join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 2px;background:#f9f9f9;border:1px solid #eeeeee;border-radius:12px;">${cells}</table>`;
  }
  // Pure builder for the "campaign finished" advertiser receipt — returns
  // { subject, html } so the admin can PREVIEW it (render, don't send) and the send
  // path shares the same render. Advertiser fields are escaped (the preview renders
  // in the admin's browser).
  function buildCampaignCompletedEmail(s: any) {
    const money = (n: any) => "US$" + (Number(n) || 0).toFixed(2);
    const nfmt = (n: any) => (Number(n) || 0).toLocaleString("en-US");
    const pct = (r: any) => (r == null ? "—" : (Number(r) * 100).toFixed(2) + "%");
    return {
      subject: "Your DWELL campaign wrapped up — the final numbers",
      html: shell({
        preheader: "Your DWELL campaign finished — here are its final results.",
        hero: "📊", heading: "Your campaign wrapped up",
        body: `<p style="margin:0 0 14px;">Your DWELL campaign has finished — its budget is fully spent. Here's how it performed:</p>`
          + detail([
            ["Ad line", `“${escapeHtml(s.adLine)}”`],
            s.brand ? ["Brand", escapeHtml(s.brand)] : null,
            ["Impressions shown", nfmt(s.impressionsShown)],
            ["Clicks", nfmt(s.clicks)],
            ["Click-through rate", pct(s.ctr)],
            ["Cost per click", s.cpcUsd == null ? "—" : money(s.cpcUsd)],
            ["Effective CPM", s.ecpmUsd == null ? "—" : money(s.ecpmUsd)],
            ["Total spent", money(s.totalPaidUsd)],
            ["Campaign", escapeHtml(s.campaignId)],
          ]),
        note: "Thanks for advertising on DWELL — just reply to this email to plan your next campaign.",
      }),
    };
  }
  return {
    sendVerifyEmail: (to: string, link: string) => send(to, "Verify your email to get paid",
      shell({
        preheader: "Confirm your email to start receiving DWELL payouts.",
        hero: "✅", heading: "Verify your email to get paid",
        body: `<p style="margin:0 0 14px;">Confirm this address so your DWELL credits land in the right place.</p>`,
        cta: { href: link, label: "Verify my email" },
        note: "This link expires in 30 minutes. If you didn't request it, you can safely ignore this email.",
      })),
    sendWebLoginEmail: (to: string, link: string) => send(to, "Your DWELL sign-in link",
      shell({
        preheader: "Your secure DWELL sign-in link — expires in 30 minutes.",
        hero: "🔑", heading: "Sign in to DWELL",
        body: `<p style="margin:0 0 14px;">Tap the button below to sign in and manage your DWELL credits — redeem them for Claude, ChatGPT or Gemini gift cards whenever you like.</p>`,
        cta: { href: link, label: "Sign in to DWELL" },
        note: "This link expires in 30 minutes and can only be used once. If you didn't request it, ignore this email.",
      })),
    // Pre-account waitlist confirmation: someone typed their email under the hero
    // ("Join the waitlist to earn") while a surface is still in review. No account
    // exists yet — this is just a friendly receipt that warms the address up
    // before the launch broadcast.
    sendWaitlistConfirmationEmail: (to: string) =>
      send(to, "You're on the DWELL waitlist 🎉",
      shell({
        preheader: "You're on the list — we'll email you the moment DWELL is live.",
        hero: "🎉", heading: "You're on the waitlist",
        body: `<p style="margin:0;">Thanks for joining DWELL — you're on the list. We'll email you the moment you can install it and start earning Claude credits while you use ChatGPT, Claude &amp; Gemini.</p>`,
        note: "You're getting this because you joined the waitlist at dwellprotocol.com. Didn't sign up? You can safely ignore this email.",
      })),
    sendAdvertiserReceiptEmail: (to: string, { campaignId, brand, adLine, cpmCents, impressionsTotal, budgetCents }: any) =>
      sendAds(to, "Your DWELL campaign receipt",
      shell({
        preheader: "Your DWELL campaign payment is confirmed — now in review.",
        hero: "💳", heading: "Payment confirmed",
        body: `<p style="margin:0 0 14px;">Thanks for advertising on DWELL — your payment is confirmed and your campaign is in review.</p>`
          + detail([
            ["Ad line", `“${adLine}”`],
            brand ? ["Brand", brand] : null,
            ["Impressions", `${(impressionsTotal || 0).toLocaleString("en-US")}`],
            ["CPM", `US$${(cpmCents / 100).toFixed(2)} per 1,000`],
            ["Total paid", `US$${(budgetCents / 100).toFixed(2)}`],
            ["Campaign", campaignId],
          ]),
        note: "It goes live once we approve it — usually within a day. Stripe has emailed a separate itemized receipt for your records.",
      })),
    buildCampaignCompletedEmail,
    sendCampaignCompletedEmail: (to: string, stats: any) => {
      const { subject, html } = buildCampaignCompletedEmail(stats);
      return sendAds(to, subject, html);
    },
    sendCampaignLiveEmail: (to: string, { campaignId, brand, adLine, impressionsTotal }: any) =>
      sendAds(to, "Your DWELL ad is live 🎉",
      shell({
        preheader: "Approved — your ad is now live on DWELL.",
        hero: "🚀", heading: "Your ad is live",
        body: `<p style="margin:0 0 14px;">Good news — your campaign is approved and now <strong style="color:#0f0f0f;">live on DWELL</strong>. 🎉</p>`
          + detail([
            ["Ad line", `“${adLine}”`],
            brand ? ["Brand", brand] : null,
            ["Running", `${(impressionsTotal || 0).toLocaleString("en-US")} impressions`],
            ["Campaign", campaignId],
          ]),
        note: "It's showing in the spinner while people use ChatGPT, Claude & Gemini. Higher bids serve first — come back any time to boost your bid and climb the leaderboard.",
      })),
    sendCampaignRejectedEmail: (to: string, { campaignId, brand, adLine, budgetCents, note }: any) =>
      sendAds(to, "Your DWELL campaign was refunded",
      shell({
        preheader: "Your DWELL campaign wasn't approved — refunded in full.",
        hero: "💸", heading: "Your campaign was refunded",
        body: `<p style="margin:0 0 14px;">Thanks for your interest in advertising on DWELL. We weren't able to approve this campaign, so we've refunded it in full.</p>`
          + detail([
            ["Ad line", `“${adLine}”`],
            brand ? ["Brand", brand] : null,
            ["Refunded", `US$${((budgetCents || 0) / 100).toFixed(2)}`],
            ["Campaign", campaignId],
          ])
          + (note ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:14px;line-height:1.5;color:#282828;"><strong style="color:#0f0f0f;">Reviewer note:</strong> ${note}</p>` : ""),
        note: "The refund returns to your original payment method; Stripe will email a separate confirmation. You're welcome to submit a new campaign any time.",
      })),
    sendGiftRedemptionEmail: (to: string, { redemptionId, planName, months, amountUsd, recipientEmail }: any) =>
      send(to, `Gift card redemption: ${months} month${months > 1 ? "s" : ""} of ${planName}`,
      `<p>A DWELL user redeemed their credits for a Claude gift card.</p>
       <ul>
         <li><strong>Plan:</strong> ${planName}</li>
         <li><strong>Duration:</strong> ${months} month${months > 1 ? "s" : ""}</li>
         <li><strong>Value:</strong> US$${amountUsd.toFixed(2)}</li>
         <li><strong>Send the gift card to:</strong> ${recipientEmail}</li>
         <li><strong>Redemption id:</strong> ${redemptionId}</li>
       </ul>
       <p>Please fulfill within 48 hours.</p>`),
    sendReferralInviteEmail: (to: string, { inviterEmail, link, rewardUsd }: any) =>
      send(to, `${inviterEmail} invited you to DWELL — free Claude credits`,
      shell({
        preheader: `${inviterEmail} invited you to DWELL — earn free Claude credits.`,
        hero: "🎁", heading: "You're invited to DWELL",
        body: `<p style="margin:0 0 14px;"><strong style="color:#0f0f0f;">${inviterEmail}</strong> is earning free Claude credits with DWELL and wants you in.</p>`
          + `<p style="margin:0 0 14px;">Earn Claude credits as you use ChatGPT, Claude or Gemini — cash out anytime for gift cards.</p>`,
        cta: { href: link, label: "Accept the invite" },
        note: `When you sign up with this link and redeem your first Claude gift card, ${inviterEmail} earns a one-time $${Math.round(rewardUsd)} bonus — at no cost to you.`,
      })),
    // Crew invite from the extension popup: the friend is attributed to the
    // inviter's affiliate code, so the inviter earns their cut of everything the
    // friend makes — forever. The friend keeps 100% of their own earnings.
    sendCrewInviteEmail: (to: string, { inviterEmail, link, rewardPct }: any) =>
      send(to, `${inviterEmail} added you to their DWELL crew`,
      shell({
        preheader: `${inviterEmail} added you to their DWELL crew — earn free Claude credits.`,
        hero: "🤝", heading: "Join your friend's DWELL crew",
        body: `<p style="margin:0 0 14px;"><strong style="color:#0f0f0f;">${inviterEmail}</strong> is earning free money while they use AI, and added you to their crew.</p>`
          + `<p style="margin:0 0 14px;">Earn Claude credits as you use ChatGPT, Claude or Gemini.</p>`,
        cta: { href: link, label: "Join the crew" },
        note: `${inviterEmail} earns an extra ${Math.round(rewardPct)}% on top — at no cost to you.`,
      })),
    // Confirmation to the user who just redeemed credits for a Claude gift card
    // (the fulfillment inbox gets its own separate notice above).
    sendRedemptionConfirmationEmail: (to: string, { planName, months, amountUsd }: any) =>
      send(to, `Your Claude gift card is on the way — ${months} month${months > 1 ? "s" : ""} of ${planName}`,
      shell({
        preheader: `We got your redemption — ${months} month${months > 1 ? "s" : ""} of ${planName}.`,
        hero: "🧾", heading: "Your redemption is in",
        body: `<p style="margin:0 0 16px;">Nice work — you've cashed in your DWELL credits for a Claude gift card. Here's what's on the way:</p>`
          + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border:1px solid #eeeeee;border-radius:12px;"><tr>`
          + `<td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:#282828;"><strong style="color:#0f0f0f;">${planName}</strong> · ${months} month${months > 1 ? "s" : ""}<br><span style="color:#606060;">Value: US$${amountUsd.toFixed(2)} in Claude credits</span></td>`
          + `</tr></table>`,
        note: "We fulfill gift cards within 48 hours — keep an eye on your inbox for the Claude gift card.",
      })),
    // Sent to the referrer when a friend they referred redeems their first gift
    // card, which is what unlocks the one-time referral bonus.
    sendReferralRewardEmail: (to: string, { rewardUsd, link }: any) =>
      send(to, `You earned $${Math.round(rewardUsd)} in Claude credits 🎉`,
      shell({
        preheader: `You earned $${Math.round(rewardUsd)} in Claude credits from a referral.`,
        hero: "🎉", heading: `You earned $${Math.round(rewardUsd)} in credits!`,
        body: `<p style="margin:0 0 14px;">A friend you referred just redeemed their first Claude gift card on DWELL — so we've added a one-time <strong style="color:#0f0f0f;">$${Math.round(rewardUsd)}</strong> bonus to your balance. 🙌</p>`
          + `<p style="margin:0 0 14px;">Keep inviting friends to stack up more credits.</p>`,
        cta: { href: link, label: "View your dashboard" },
        note: "Credits never expire — redeem them for Claude, ChatGPT or Gemini gift cards anytime.",
      })),
  };
}
const mailer = createMailer(config);

// Best-effort mirror of a waitlist email into the Resend contact list, so a
// launch-day broadcast can reach waitlisters from the Resend dashboard. The DB
// (email_leads) is the source of truth; this is a convenience copy. Each contact
// is tagged with a `signup_source` property so a Resend segment can target
// exactly the people who joined to earn. Callers must not await this on the hot
// path — a Resend hiccup must never fail the capture.
async function addResendContact(email: string, source: string | null) {
  if (config.mailProvider !== "resend" || !config.resendApiKey) return;
  const res = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email, unsubscribed: false,
      properties: { signup_source: source || "lander_earn" },
      ...(config.resendWaitlistSegmentId ? { segments: [{ id: config.resendWaitlistSegmentId }] } : {}),
    }),
  });
  // A contact that already exists comes back 409/422 — that's a success for us.
  if (!res.ok && res.status !== 409 && res.status !== 422) {
    throw new Error("resend contact failed: " + res.status + " " + (await res.text().catch(() => "")).slice(0, 200));
  }
}

// ────────────────────────────── repo.js ────────────────────────────────────
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateReferralCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return out;
}
// Mask a referred friend's email for the dashboard (jane@acme.com -> j•••@acme.com)
// so the page never leaks the full address of someone who signed up via a link.
function maskEmail(email: string) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at < 1) return "•••";
  const local = s.slice(0, at);
  const head = local.length > 1 ? local[0] : "";
  return `${head}•••@${s.slice(at + 1)}`;
}
const LOCK_REDEEM = 0x52454431; // "RED1"

function createRepo(pool: any) {
  async function tx(fn: any) {
    return pool.begin(fn);
  }

  async function applyReferral(client: any, newUserId: string, refCode: any) {
    if (!refCode) return;
    const code = String(refCode).trim().toUpperCase();
    if (!code) return;
    const r = await client.query("select id from users where upper(referral_code) = $1", [code]);
    const referrer = r.rows[0];
    if (!referrer || referrer.id === newUserId) return;
    await client.query("update users set referred_by = $2 where id = $1 and referred_by is null", [newUserId, referrer.id]);
    await client.query(
      `insert into referrals (referrer_user_id, referred_user_id, status)
       values ($1, $2, 'pending') on conflict (referred_user_id) do nothing`,
      [referrer.id, newUserId]
    );
    const ne = await client.query("select email from users where id = $1", [newUserId]);
    if (ne.rows[0]?.email) {
      await client.query(
        `update referral_invites set status = 'joined', joined_at = now()
          where referrer_user_id = $1 and lower(email) = lower($2) and status = 'sent'`,
        [referrer.id, ne.rows[0].email]
      );
    }
  }

  async function maybeRewardReferral(client: any, referredUserId: string, rewardMillicents: any, cap: number) {
    const ref = await client.query(
      `select id, referrer_user_id from referrals where referred_user_id = $1 and status = 'pending' for update`,
      [referredUserId]
    );
    if (!ref.rows[0]) return;
    const { id, referrer_user_id } = ref.rows[0];
    const cnt = await client.query(
      "select count(*)::int as n from referrals where referrer_user_id = $1 and status = 'rewarded'",
      [referrer_user_id]
    );
    if (cnt.rows[0].n >= cap) {
      await client.query("update referrals set status = 'capped' where id = $1", [id]);
      return;
    }
    await client.query(
      `insert into ledger (entry_type, amount_millicents, user_id, meta)
       values ('referral_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
      [String(rewardMillicents), referrer_user_id, JSON.stringify({ referralId: id, referredUserId })]
    );
    await client.query(
      `update referrals set status = 'rewarded', rewarded_at = now(), reward_millicents = $2 where id = $1`,
      [id, String(rewardMillicents)]
    );
    const re = await client.query("select email from users where id = $1", [referredUserId]);
    if (re.rows[0]?.email) {
      await client.query(
        `update referral_invites set status = 'rewarded', rewarded_at = now()
          where referrer_user_id = $1 and lower(email) = lower($2) and status <> 'rewarded'`,
        [referrer_user_id, re.rows[0].email]
      );
    }
    // Surface the granted reward so the caller can email the referrer AFTER the
    // transaction commits — never send mail from inside the tx.
    const referrer = await client.query("select email from users where id = $1", [referrer_user_id]);
    return { referrerUserId: referrer_user_id, referrerEmail: referrer.rows[0]?.email || null, rewardMillicents };
  }

  // Attribute a user to an approved affiliate by code. Runs at signup OR
  // retroactively, but only when the user has no prior attribution (no referrer
  // and no affiliate) — the two are mutually exclusive. Self-attribution and
  // unknown/unapproved codes are ignored. Returns true when attributed.
  async function applyAffiliateCode(client: any, userId: string, code: any) {
    if (!code) return false;
    const norm = String(code).trim().toUpperCase();
    if (!norm) return false;
    const a = await client.query(
      "select id, user_id, cap_people from affiliates where upper(code) = $1 and status = 'approved' for update",
      [norm]
    );
    const aff = a.rows[0];
    if (!aff || aff.user_id === userId) return false;
    // People cap: an affiliate can attribute at most cap_people friends.
    const cnt = await client.query(
      "select count(*)::int as n from affiliate_attributions where affiliate_id = $1",
      [aff.id]
    );
    if (cnt.rows[0].n >= aff.cap_people) return false;
    const upd = await client.query(
      `update users set affiliate_id = $2
        where id = $1 and affiliate_id is null and referred_by is null
        returning id`,
      [userId, aff.id]
    );
    if (!upd.rows[0]) return false;
    await client.query(
      `insert into affiliate_attributions (affiliate_id, affiliated_user_id)
       values ($1, $2) on conflict (affiliated_user_id) do nothing`,
      [aff.id, userId]
    );
    return true;
  }

  // Resolve a signup code. The $20 referral program is retired, so a signup code
  // only ever resolves to an affiliate attribution now; old referral codes no
  // longer attribute anything (applyReferral is archived/uncalled).
  async function applyCode(client: any, userId: string, code: any) {
    if (!code) return;
    const attributed = await applyAffiliateCode(client, userId, code);
  }

  // Pay an affiliate their cut of an affiliated user's just-earned credits.
  // Platform-funded — the affiliated user keeps 100% of their earnings. Dollar
  // earnings are UNCAPPED now (the cap is people-based, enforced at attribution);
  // credited_millicents stays as a lifetime "credits earned" tally. The affiliate
  // row is locked FOR UPDATE to serialize the tally update.
  // The device's user's approved affiliate, row-locked to serialize tally
  // updates. Shared by the legacy platform-funded bonus (creditAffiliate) and
  // the token-mode referrer leg (creditTokenSplit). Null when unattributed.
  async function approvedAffiliateFor(client: any, affiliatedUserId: string | null) {
    if (!affiliatedUserId) return null;
    const a = await client.query(
      `select a.id, a.user_id, a.reward_bps
         from affiliates a
         join users u on u.affiliate_id = a.id
        where u.id = $1 and a.status = 'approved'
        for update of a`,
      [affiliatedUserId]
    );
    return a.rows[0] || null;
  }

  async function creditAffiliate(client: any, affiliatedUserId: string | null, baseMillicents: any) {
    if (!affiliatedUserId) return;
    const base = BigInt(baseMillicents);
    if (base <= 0n) return;
    const aff = await approvedAffiliateFor(client, affiliatedUserId);
    if (!aff) return;
    const share = (base * BigInt(aff.reward_bps)) / 10000n;
    if (share <= 0n) return;
    await client.query(
      `insert into ledger (entry_type, amount_millicents, user_id, meta)
       values ('affiliate_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
      [share.toString(), aff.user_id, JSON.stringify({ affiliateId: aff.id, affiliatedUserId })]
    );
    await client.query(
      "update affiliates set credited_millicents = credited_millicents + $2 where id = $1",
      [aff.id, share.toString()]
    );
  }

  // DWELL token mode (dwell/docs/04 §B): three-way BPS split of the reserve
  // tranche, replacing the legacy two-way revenueShare split. Per billed gross:
  //   pool     = gross × RESERVE_TRANCHE_BPS/10000       (the 90%)
  //   viewer   = pool × VIEWER_SHARE_BPS/10000           → points_credit (+device)
  //   referrer = pool × REFERRER_SHARE_BPS/10000 if attributed
  //                                                      → referral_points_credit (+user)
  //   protocol = pool − viewer − referrer                → protocol_points_credit (+platform)
  //   business = gross − pool                            → platform_fee (+platform)
  // The platform_fee row keeps the ledger closed (rows sum to gross, same
  // invariant as the legacy path), so campaign spend metrics stay exact. The
  // legacy platform-funded affiliate bonus is retired here — the referrer's cut
  // is carved from the pool — but the crew tally keeps accruing for the UI.
  // Returns the viewer's credit (what the device earned). Mirrors server/src/repo.js.
  async function creditTokenSplit(c: any, { deviceId, campaignId, gross, tokenSplit, meta }: any) {
    const du = await c.query("select user_id from devices where id = $1", [deviceId]);
    const aff = await approvedAffiliateFor(c, du.rows[0]?.user_id);
    const pool_ = (gross * BigInt(tokenSplit.reserveTrancheBps)) / 10000n;
    const viewer = (pool_ * BigInt(tokenSplit.viewerShareBps)) / 10000n;
    const referrer = aff ? (pool_ * BigInt(tokenSplit.referrerShareBps)) / 10000n : 0n;
    const protocol = pool_ - viewer - referrer; // remainder keeps millicent exactness
    const business = gross - pool_;
    await c.query(
      `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
       values ('points_credit', $1, $2, $3, ($4::jsonb #>> '{}')::jsonb)`,
      [viewer.toString(), deviceId, campaignId, JSON.stringify(meta)]
    );
    if (aff && referrer > 0n) {
      await c.query(
        `insert into ledger (entry_type, amount_millicents, user_id, campaign_id, meta)
         values ('referral_points_credit', $1, $2, $3, ($4::jsonb #>> '{}')::jsonb)`,
        [referrer.toString(), aff.user_id, campaignId,
         JSON.stringify({ affiliateId: aff.id, affiliatedUserId: du.rows[0].user_id })]
      );
      await c.query(
        "update affiliates set credited_millicents = credited_millicents + $2 where id = $1",
        [aff.id, referrer.toString()]
      );
    }
    await c.query(
      `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
       values ('protocol_points_credit', $1, $2, '{}')`,
      [protocol.toString(), campaignId]
    );
    await c.query(
      `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
       values ('platform_fee', $1, $2, '{}')`,
      [business.toString(), campaignId]
    );
    return viewer;
  }

  // Mint a unique affiliate code (unique across users.referral_code AND
  // affiliates.code) onto an affiliate row that has none yet; returns the code
  // (existing or freshly minted). Shared by approveAffiliate and the self-serve
  // getOrCreateAffiliate path so the two never drift.
  async function mintAffiliateCode(affiliateId: string) {
    const ex = await pool.query("select code from affiliates where id = $1", [affiliateId]);
    if (ex.rows[0]?.code) return ex.rows[0].code;
    for (let i = 0; i < 8; i++) {
      const cand = generateReferralCode();
      const clash = await pool.query(
        `select 1 from users where upper(referral_code) = $1
         union all select 1 from affiliates where upper(code) = $1`,
        [cand]
      );
      if (clash.rows[0]) continue;
      try {
        const r = await pool.query(
          "update affiliates set code = $2 where id = $1 and code is null returning code",
          [affiliateId, cand]
        );
        if (r.rows[0]) return r.rows[0].code;
        const re = await pool.query("select code from affiliates where id = $1", [affiliateId]);
        if (re.rows[0]?.code) return re.rows[0].code;
      } catch (err: any) {
        if (err.code === "23505") continue;
        throw err;
      }
    }
    throw new Error("could not allocate affiliate code");
  }

  // Ensure the user is enrolled as an APPROVED affiliate with a code (self-serve,
  // no social application), idempotently; returns { id, code }. Shared by the
  // device popup path and the web dashboard so everyone has a base 10% link.
  async function ensureAffiliate(userId: string) {
    const ins = await pool.query(
      `insert into affiliates (user_id, status, approved_at)
       values ($1, 'approved', now())
       on conflict (user_id) do nothing
       returning id`,
      [userId]
    );
    let id = ins.rows[0]?.id;
    if (!id) {
      const ex = await pool.query("select id, status from affiliates where user_id = $1", [userId]);
      id = ex.rows[0].id;
      if (ex.rows[0].status !== "approved") {
        await pool.query(
          "update affiliates set status = 'approved', approved_at = coalesce(approved_at, now()) where id = $1",
          [id]
        );
      }
    }
    const code = await mintAffiliateCode(id);
    return { id, code };
  }

  return {
    async registerDevice() {
      const secret = crypto.randomBytes(32).toString("hex");
      const { rows } = await pool.query("insert into devices (key_hash) values ($1) returning id", [sha256(secret)]);
      return { deviceId: rows[0].id, deviceKey: secret };
    },
    async authDevice(deviceId: string, deviceKey: string) {
      if (!deviceId || !deviceKey) return null;
      const { rows } = await pool.query(
        "update devices set last_seen_at = now() where id = $1 and key_hash = $2 returning id, user_id",
        [deviceId, sha256(deviceKey)]
      );
      return rows[0] || null;
    },
    async activeAds(limit = 20) {
      // paid_at guards every serve/credit path: a campaign that never went
      // through payment (e.g. a row seeded straight to 'active') must never
      // show or mint credits — user credits have to be backed by real budget.
      const { rows } = await pool.query(
        `select id, brand, ad_line, url, category, color, price_per_block_cents, show_on_leaderboard,
                change_timescale, changes
           from campaigns where status = 'active' and impressions_remaining > 0 and paid_at is not null
          order by price_per_block_cents desc, activated_at asc limit $1`,
        [limit]
      );
      return rows;
    },
    async leaderboard(limit = 15) {
      const { rows } = await pool.query(
        `select brand, ad_line, price_per_block_cents, change_timescale, changes from campaigns
          where status in ('active', 'exhausted') and show_on_leaderboard
          order by price_per_block_cents desc, activated_at asc limit $1`,
        [limit]
      );
      return rows;
    },
    async createPendingCampaign({ email, brand, adLine, url, category, color, pricePerBlockCents, blocks, impressionsTotal, budgetCents, showOnLeaderboard, changeTimescale }: any) {
      // impressionsTotal is the exact purchased count (floor(budget*1000/cpm)),
      // not necessarily a multiple of 1000. budgetCents is the exact charge.
      const impressions = Number.isFinite(impressionsTotal) ? impressionsTotal : blocks * 1000;
      return tx(async (c: any) => {
        // Upsert so a returning advertiser (same email) reuses their row and owns many
        // campaigns, rather than minting a disconnected advertiser per checkout.
        const adv = await c.query("insert into advertisers (email) values ($1) on conflict (email) do update set email = excluded.email returning id", [email]);
        const { rows } = await c.query(
          `insert into campaigns
             (advertiser_id, brand, ad_line, url, category, color, price_per_block_cents,
              blocks, impressions_total, impressions_remaining, budget_cents, show_on_leaderboard,
              change_timescale)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12) returning id`,
          [adv.rows[0].id, brand || null, adLine, url, category || "other", color || null,
           pricePerBlockCents, blocks, impressions, budgetCents ?? null, showOnLeaderboard !== false,
           changeTimescale || "auto"]
        );
        return rows[0].id;
      });
    },
    async attachCheckoutSession(campaignId: string, sessionId: string) {
      await pool.query("update campaigns set stripe_checkout_session_id = $2 where id = $1", [campaignId, sessionId]);
    },
    async markCampaignPaid(campaignId: string, paymentIntentId: string, { tokenSplit }: any = {}) {
      return tx(async (c: any) => {
        const { rows } = await c.query(
          `update campaigns cmp set status = 'pending_review', paid_at = now(),
                  stripe_payment_intent_id = coalesce($2, cmp.stripe_payment_intent_id)
             from advertisers adv
            where cmp.id = $1 and cmp.status = 'pending_payment'
              and adv.id = cmp.advertiser_id
            returning adv.email, cmp.brand, cmp.ad_line, cmp.price_per_block_cents, cmp.blocks,
                      cmp.impressions_total, cmp.budget_cents`,
          [campaignId, paymentIntentId || null]
        );
        if (!rows[0]) return false;
        // Fund the campaign with the EXACT amount charged (budget). Fall back to
        // the old price×blocks for campaigns created before budget_cents existed.
        const chargeCents = rows[0].budget_cents != null
          ? BigInt(rows[0].budget_cents)
          : BigInt(rows[0].price_per_block_cents) * BigInt(rows[0].blocks);
        const funded = chargeCents * 1000n;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('campaign_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
          [funded.toString(), campaignId, JSON.stringify({ impressions: rows[0].impressions_total })]
        );
        // Token mode: earmark the campaign's reserve tranche at payment
        // (dwell/docs/04 §A — the accounting mirror of campaign_credit). The
        // fiat sweeper later records the matching USDC escrow movement in
        // usdc_reserve_entries; a daily attestation checks the two agree.
        if (tokenSplit) {
          const tranche = (funded * BigInt(tokenSplit.reserveTrancheBps)) / 10000n;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('reserve_allocation', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [tranche.toString(), campaignId, JSON.stringify({ trancheBps: tokenSplit.reserveTrancheBps })]
          );
        }
        return {
          email: rows[0].email,
          brand: rows[0].brand,
          adLine: rows[0].ad_line,
          pricePerBlockCents: rows[0].price_per_block_cents,
          blocks: rows[0].blocks,
          impressionsTotal: rows[0].impressions_total,
          budgetCents: rows[0].budget_cents != null ? Number(rows[0].budget_cents) : Number(chargeCents),
        };
      });
    },
    async pendingReviewCampaigns(limit = 50) {
      const { rows } = await pool.query(
        `select id, brand, ad_line, url, category, price_per_block_cents, blocks, paid_at
           from campaigns where status = 'pending_review' order by paid_at asc limit $1`,
        [limit]
      );
      return rows;
    },
    // Approve. Card/USDC campaigns activate directly (funding already posted at
    // payment time). SOL/$DWELL campaigns hold their crypto during review, so
    // approval parks them in pending_swap and hands the held order back to the
    // caller, which executes the acceptance-time hedge swap and then calls
    // finalizeAcceptedSwap. Re-approving a pending_swap campaign (a failed
    // swap) returns the same order — the retry path.
    async approveCampaign(campaignId: string) {
      return tx(async (c: any) => {
        const { rows: camp } = await c.query(
          `select cmp.id, cmp.status, adv.email, cmp.brand, cmp.ad_line, cmp.price_per_block_cents, cmp.blocks, cmp.impressions_total
             from campaigns cmp join advertisers adv on adv.id = cmp.advertiser_id
            where cmp.id = $1 for update of cmp`,
          [campaignId]
        );
        if (!camp[0] || !["pending_review", "pending_swap"].includes(camp[0].status)) return null;
        const info = {
          email: camp[0].email, brand: camp[0].brand, adLine: camp[0].ad_line,
          pricePerBlockCents: camp[0].price_per_block_cents, blocks: camp[0].blocks,
          impressionsTotal: camp[0].impressions_total,
        };
        const { rows: ord } = await c.query(
          `select id, pay_currency, payer_address, received_amount_raw
             from usdc_orders
            where campaign_id = $1 and status = 'confirmed' and pay_currency in ('sol', 'dwell')
            order by created_at desc limit 1`,
          [campaignId]
        );
        if (ord[0]) {
          await c.query(`update campaigns set status = 'pending_swap' where id = $1`, [campaignId]);
          return { ...info, needsSwap: true, order: ord[0] };
        }
        if (camp[0].status !== "pending_review") return null; // pending_swap with no held order — nothing left to do
        await c.query(
          `update campaigns set status = 'active', activated_at = now() where id = $1`,
          [campaignId]
        );
        return { ...info, needsSwap: false };
      });
    },

    // Second half of a SOL/$DWELL approval: the hedge swap landed, fund the
    // campaign from the REALIZED USDC (acceptance-time rate — the effective
    // CPM/impressions may differ from the checkout quote) and activate it.
    // Idempotent on the order's confirmed -> swapped transition.
    async finalizeAcceptedSwap({ orderId, swapSignature, realizedMicroUsdc, tokenSplit, dwellPayBoostBps }: any) {
      return tx(async (c: any) => {
        const ord = await c.query(
          `update usdc_orders set status = 'swapped', swap_signature = $2, realized_micro_usdc = $3
            where id = $1 and status = 'confirmed'
            returning campaign_id, pay_currency`,
          [orderId, swapSignature, realizedMicroUsdc]
        );
        if (!ord.rows[0]) return null;
        const o = ord.rows[0];

        const { rows: camp } = await c.query(
          `select price_per_block_cents from campaigns where id = $1 for update`,
          [o.campaign_id]
        );
        if (!camp[0]) return null;
        const realized = BigInt(realizedMicroUsdc);
        const realizedCents = Number(realized / 10000n);
        const cpmCents = Number(camp[0].price_per_block_cents);
        const boostBps = o.pay_currency === "dwell" ? (dwellPayBoostBps || 0) : 0;
        const baseImpressions = Math.floor((realizedCents * 1000) / cpmCents);
        const impressions = Math.floor((baseImpressions * (10000 + boostBps)) / 10000);
        const blocks = Math.max(1, Math.round(impressions / 1000));
        await c.query(
          `update campaigns set status = 'active', activated_at = now(),
                  budget_cents = $2, impressions_total = $3, blocks = $4
            where id = $1 and status = 'pending_swap'`,
          [o.campaign_id, realizedCents, impressions, blocks]
        );

        // Fund with the realized amount, exactly like confirmUsdcOrder does for
        // the stable rails. USDC micro units -> millicents is /10.
        const funded = realized / 10n;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('campaign_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
          [funded.toString(), o.campaign_id,
           JSON.stringify({ impressions, rail: o.pay_currency, swapTx: swapSignature, settlement: "usdc-at-acceptance" })]
        );
        if (tokenSplit) {
          const tranche = (funded * BigInt(tokenSplit.reserveTrancheBps)) / 10000n;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('reserve_allocation', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [tranche.toString(), o.campaign_id,
             JSON.stringify({ trancheBps: tokenSplit.reserveTrancheBps, rail: o.pay_currency })]
          );
        }
        return { impressionsTotal: impressions, budgetCents: realizedCents };
      });
    },

    // The refund landed on-chain — retire the held order.
    async markOrderRefunded(orderId: string, refundSignature: string) {
      const { rows } = await pool.query(
        `update usdc_orders set status = 'refunded', refund_signature = $2
          where id = $1 and status = 'confirmed' returning id`,
        [orderId, refundSignature]
      );
      return !!rows[0];
    },

    // A rejected crypto campaign whose held funds haven't gone back yet — the
    // admin retry-refund path (e.g. the payer's $DWELL account was missing, or
    // the RPC hiccuped at reject time).
    async getRefundableOrder(orderId: string) {
      const { rows } = await pool.query(
        `select o.id, o.pay_currency, o.payer_address, o.received_amount_raw
           from usdc_orders o join campaigns c on c.id = o.campaign_id
          where o.id = $1 and o.status = 'confirmed'
            and o.pay_currency in ('sol', 'dwell') and c.status = 'rejected'`,
        [orderId]
      );
      return rows[0] || null;
    },
    async rejectCampaign(campaignId: string, note: string) {
      return tx(async (c: any) => {
        // pending_swap is rejectable too: an accepted campaign whose hedge swap
        // never landed still holds its crypto, so it can be reversed in-kind.
        const { rows } = await c.query(
          `update campaigns cmp set status = 'rejected', review_note = $2
             from advertisers adv
            where cmp.id = $1 and cmp.status in ('pending_review', 'pending_swap')
              and adv.id = cmp.advertiser_id
            returning adv.email, cmp.brand, cmp.ad_line,
                      cmp.price_per_block_cents, cmp.blocks, cmp.budget_cents, cmp.stripe_payment_intent_id`,
          [campaignId, note || null]
        );
        if (!rows[0]) return null;
        // A held SOL/$DWELL order refunds on-chain (caller executes it) and
        // never posted ledger funding, so there is nothing to reverse.
        const { rows: held } = await c.query(
          `select id, pay_currency, payer_address, received_amount_raw
             from usdc_orders
            where campaign_id = $1 and status = 'confirmed' and pay_currency in ('sol', 'dwell')
            order by created_at desc limit 1`,
          [campaignId]
        );
        // Refund the exact amount funded (budget); fall back to price×blocks for
        // pre-budget_cents campaigns.
        const chargeCents = rows[0].budget_cents != null
          ? BigInt(rows[0].budget_cents)
          : BigInt(rows[0].price_per_block_cents) * BigInt(rows[0].blocks);
        if (!held[0]) {
          const refund = chargeCents * 1000n;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('campaign_refund', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [(-refund).toString(), campaignId, JSON.stringify({ note: note || null })]
          );
        }
        return {
          heldOrder: held[0] || null,
          paymentIntentId: rows[0].stripe_payment_intent_id,
          email: rows[0].email,
          brand: rows[0].brand,
          adLine: rows[0].ad_line,
          pricePerBlockCents: rows[0].price_per_block_cents,
          blocks: rows[0].blocks,
          budgetCents: rows[0].budget_cents != null ? Number(rows[0].budget_cents) : Number(chargeCents),
          note: note || null,
        };
      });
    },
    async claimWebhookEvent(eventId: string, type: string) {
      if (!eventId) return true;
      const { rows } = await pool.query(
        `insert into processed_webhook_events (event_id, type) values ($1, $2)
         on conflict (event_id) do nothing returning event_id`,
        [eventId, type || null]
      );
      return !!rows[0];
    },
    // `credit: false` is the FORGERY-SURFACE.md killswitch: the batch is still
    // recorded (idempotency, fraud-cap accounting, adoption telemetry) but no
    // campaign budget is spent and no ledger credit is issued.
    async ingestBatch({ deviceId, batchKey, events, source, revenueShare, dailyCap, ipHash, ipDailyCap, tokenSplit, credit = true }: any) {
      return tx(async (c: any) => {
        const claimedImpressions = events.reduce((n: number, e: any) => n + (e.impressions || 0), 0);
        const claimedClicks = events.reduce((n: number, e: any) => n + (e.clicks || 0), 0);
        const ins = await c.query(
          `insert into event_batches (device_id, batch_key, impressions, clicks, ip_hash)
           values ($1,$2,$3,$4,$5) on conflict (batch_key) do nothing returning id`,
          [deviceId, batchKey, claimedImpressions, claimedClicks, ipHash || null]
        );
        if (!ins.rows[0]) return { duplicate: true, creditedMillicents: 0 };
        const cap = await c.query(
          `select coalesce(sum(impressions), 0)::bigint as n from event_batches
            where device_id = $1 and created_at >= date_trunc('day', now())`,
          [deviceId]
        );
        if (Number(cap.rows[0].n) > dailyCap) {
          const err: any = new Error("daily impression cap exceeded");
          err.code = "CAP_EXCEEDED";
          throw err;
        }
        // fraud cap: impressions per source IP per UTC day (hashed, fail-open,
        // disabled when ipDailyCap <= 0).
        if (ipHash && Number.isFinite(ipDailyCap) && ipDailyCap > 0) {
          const ipCap = await c.query(
            `select coalesce(sum(impressions), 0)::bigint as n from event_batches
              where ip_hash = $1 and created_at >= date_trunc('day', now())`,
            [ipHash]
          );
          if (Number(ipCap.rows[0].n) > ipDailyCap) {
            const err: any = new Error("daily ip impression cap exceeded");
            err.code = "CAP_EXCEEDED";
            throw err;
          }
        }
        if (!credit) return { duplicate: false, creditedMillicents: 0, legacyCreditDisabled: true };
        let credited = 0n;
        for (const ev of events) {
          const imp = Math.max(0, ev.impressions | 0);
          const billable = imp;
          if (!billable) continue;
          // Skip demo/preview or otherwise non-uuid campaign ids — querying a
          // uuid column with them throws and would poison the transaction.
          if (!isUuid(ev.campaignId)) continue;
          const camp = await c.query(
            `select price_per_block_cents, impressions_remaining from campaigns
              where id = $1 and status = 'active' and paid_at is not null for update`,
            [ev.campaignId]
          );
          if (!camp.rows[0]) continue;
          const billed = Math.min(billable, camp.rows[0].impressions_remaining);
          if (!billed) continue;
          await c.query(
            `update campaigns set
               impressions_remaining = impressions_remaining - $2,
               status = case when impressions_remaining - $2 <= 0 then 'exhausted' else status end
             where id = $1`,
            [ev.campaignId, billed]
          );
          const gross = BigInt(camp.rows[0].price_per_block_cents) * BigInt(billed);
          const meta = source ? { impressions: imp, billed, source } : { impressions: imp, billed };
          // Token mode (DWELL deployment): three-way points split, same math as
          // the token redeem path; no platform-funded affiliate bonus.
          if (tokenSplit) {
            credited += await creditTokenSplit(c, { deviceId, campaignId: ev.campaignId, gross, tokenSplit, meta });
            continue;
          }
          const dev = (gross * BigInt(Math.round(revenueShare * 1000))) / 1000n;
          const fee = gross - dev;
          credited += dev;
          // postgres.js double-encodes a JSON.stringify'd string bound to a jsonb
          // column (stores it as a JSON *string scalar*, so meta->>'key' is null).
          // ($N::jsonb #>> '{}')::jsonb unwraps that back to a real object; it's a
          // no-op on values that are already objects. Applied to every meta insert.
          await c.query(
            `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
             values ('impression_credit', $1, $2, $3, ($4::jsonb #>> '{}')::jsonb)`,
            [dev.toString(), deviceId, ev.campaignId, JSON.stringify(meta)]
          );
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('platform_fee', $1, $2, '{}')`,
            [fee.toString(), ev.campaignId]
          );
        }
        // If this device's user was attributed to an affiliate, accrue the
        // affiliate's cut (platform-funded, on top) on the batch's net credit.
        // Retired in token mode — the referrer's 10% is inside the split.
        if (credited > 0n && !tokenSplit) {
          const dev = await c.query("select user_id from devices where id = $1", [deviceId]);
          await creditAffiliate(c, dev.rows[0]?.user_id, credited);
        }
        return { duplicate: false, creditedMillicents: Number(credited) };
      });
    },
    async earningsForDevice(deviceId: string) {
      // admin_credit/admin_debit are manual balance adjustments (e.g. a
      // cancelled-redemption refund, or wiping credits an unfunded campaign
      // minted) — they move the spendable balance but not lifetime "earned".
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed,
           coalesce(sum(amount_millicents) filter (where entry_type in ('admin_credit','admin_debit')), 0)::bigint as adjusted
         from ledger
         where device_id = $1
            or user_id = (select user_id from devices where id = $1 and user_id is not null)`,
        [deviceId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out);
      const redeemed = Number(rows[0].redeemed);
      const adjusted = Number(rows[0].adjusted);
      return { earnedMillicents: earned, paidOutMillicents: -paidOut, redeemedMillicents: -redeemed, balanceMillicents: earned + paidOut + redeemed + adjusted };
    },
    async userForDevice(deviceId: string) {
      const { rows } = await pool.query(`select u.* from users u join devices d on d.user_id = u.id where d.id = $1`, [deviceId]);
      return rows[0] || null;
    },
    async createEmailToken(email: string, deviceId: string | null, ttlMs: number, referralCode?: any, cooldownMs?: number, ipHash?: string | null, ipDailyCap?: number) {
      // Per-IP daily cap: the per-email cooldown below only throttles a single
      // address, so one host can still blast magic links to many DISTINCT
      // addresses (spam-cannon / sender-reputation abuse). This bounds sends per
      // source IP per UTC day. Hashed, fail-open (skipped when no IP is known),
      // disabled when ipDailyCap is not positive (shared-NAT/CGNAT opt-out).
      // Throws CAP_EXCEEDED so the route can 429 — a per-IP limit, unlike the
      // per-email cooldown, reveals nothing about whether an address exists.
      if (ipHash && Number.isFinite(ipDailyCap as any) && (ipDailyCap as number) > 0) {
        const ipCap = await pool.query(
          `select count(*)::int as n from email_tokens
            where ip_hash = $1 and created_at >= date_trunc('day', now())`,
          [ipHash]
        );
        if (ipCap.rows[0].n >= (ipDailyCap as number)) {
          const err: any = new Error("daily email cap exceeded");
          err.code = "CAP_EXCEEDED";
          throw err;
        }
      }
      // Per-email send cooldown: collapse rapid repeat requests so the magic-link
      // endpoints can't be used to email-bomb or probe an address. Scoped by
      // device so verify-email (device-linked) and website-login (device-null)
      // never throttle each other. Returns null when a fresh token was just
      // issued — the caller responds the same either way so nothing leaks.
      if (cooldownMs) {
        const recent = await pool.query(
          `select 1 from email_tokens
            where lower(email) = lower($1) and used_at is null
              and device_id is not distinct from $2
              and created_at > now() - ($3 || ' milliseconds')::interval
            limit 1`,
          [email, deviceId || null, String(cooldownMs)]
        );
        if (recent.rows[0]) return null;
      }
      const token = crypto.randomBytes(32).toString("base64url");
      await pool.query(
        `insert into email_tokens (token, email, device_id, referral_code, ip_hash, expires_at)
         values ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)`,
        [token, email, deviceId || null, referralCode || null, ipHash || null, String(ttlMs)]
      );
      return token;
    },
    async verifyEmailToken(token: string) {
      return tx(async (c: any) => {
        const t = await c.query(
          `update email_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now() returning email, device_id`,
          [token]
        );
        if (!t.rows[0]) return null;
        const { email, device_id } = t.rows[0];
        const u = await c.query(
          `insert into users (email, email_verified) values ($1, true)
           on conflict (email) do update set email_verified = true
           returning id, email, stripe_account_id, payouts_enabled, email_verified`,
          [email]
        );
        if (device_id) await c.query("update devices set user_id = $2 where id = $1", [device_id, u.rows[0].id]);
        return u.rows[0];
      });
    },
    // Link a device to a user (self-serve, from the dwellprotocol.com web session). Same
    // association the magic-link verify makes — balance queries already roll up
    // "this user OR any device linked to them", so no balance merge is needed.
    async linkDeviceToUser(deviceId: string, userId: string) {
      await pool.query("update devices set user_id = $2 where id = $1", [deviceId, userId]);
    },
    async createClickToken(campaignId: string, deviceId: string, ttlMs: number) {
      if (!isUuid(campaignId)) return null;
      const camp = await pool.query("select 1 from campaigns where id = $1 and status = 'active'", [campaignId]);
      if (!camp.rows[0]) return null;
      const token = crypto.randomBytes(24).toString("base64url");
      await pool.query(
        `insert into click_tokens (token, campaign_id, device_id, expires_at)
         values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
        [token, campaignId, deviceId, String(ttlMs)]
      );
      return token;
    },
    // Clicks are FREE — record a zero-value 'click_event' for analytics
    // (clicks / CTR / CPC) but never bill the campaign, draw budget, or credit
    // the device (the 50x click billing was removed). History is untouched.
    async redeemClickToken(token: string, dailyClickCap: number) {
      return tx(async (c: any) => {
        const t = await c.query(
          `update click_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now() returning campaign_id, device_id`,
          [token]
        );
        if (!t.rows[0]) return null;
        const { campaign_id, device_id } = t.rows[0];
        // Per-device daily cap still bounds how many clicks we RECORD per day, so
        // the click metric can't be spammed. Past the cap we still 302 the user
        // onward but record nothing.
        let overCap = false;
        if (Number.isFinite(dailyClickCap)) {
          const used = await c.query(
            `select count(*)::int as n from ledger
              where device_id = $1 and entry_type = 'click_event'
                and created_at >= date_trunc('day', now())`,
            [device_id]
          );
          if (used.rows[0].n >= dailyClickCap) overCap = true;
        }
        const camp = await c.query(
          "select url from campaigns where id = $1 and status = 'active'",
          [campaign_id]
        );
        if (!camp.rows[0]) return null;
        if (!overCap) {
          await c.query(
            `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
             values ('click_event', 0, $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [device_id, campaign_id, JSON.stringify({ via: "go" })]
          );
        }
        return { url: camp.rows[0].url };
      });
    },
    // ---------- server-authoritative impressions (single-use tokens) ----------
    // An impression is billable only when the server SERVED that ad to this
    // device (mint here) and only ONCE (redeem below, after the qualifying
    // dwell). Replaces trust in the client's self-reported /v1/events count.
    // Caps are enforced here on tokens served today, so billed <= served <= cap.
    async serveImpression({ deviceId, ipHash, ttlMs, dailyCap, ipDailyCap }: any) {
      if (Number.isFinite(dailyCap) && dailyCap > 0) {
        const n = await pool.query(
          `select count(*)::int as n from impression_tokens
            where device_id = $1 and created_at >= date_trunc('day', now())`,
          [deviceId]
        );
        if (n.rows[0].n >= dailyCap) return { capped: true };
      }
      if (ipHash && Number.isFinite(ipDailyCap) && ipDailyCap > 0) {
        const n = await pool.query(
          `select count(*)::int as n from impression_tokens
            where ip_hash = $1 and created_at >= date_trunc('day', now())`,
          [ipHash]
        );
        if (n.rows[0].n >= ipDailyCap) return { capped: true };
      }
      // Auction winner: highest bid, oldest activated (same order as activeAds).
      const pick = await pool.query(
        `select id, brand, ad_line, url, category, color, price_per_block_cents,
                change_timescale, changes
           from campaigns
          where status = 'active' and impressions_remaining > 0 and paid_at is not null
          order by price_per_block_cents desc, activated_at asc
          limit 1`
      );
      const ad = pick.rows[0];
      if (!ad) return { ad: null };
      const token = crypto.randomBytes(24).toString("base64url");
      await pool.query(
        `insert into impression_tokens (token, campaign_id, device_id, ip_hash, expires_at)
         values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
        [token, ad.id, deviceId, ipHash || null, String(ttlMs)]
      );
      return { token, ad };
    },
    // Redeem a served impression EXACTLY ONCE, after the dwell. Bills one
    // impression against the (locked) campaign, credits the device its share and
    // the affiliate, records the platform fee — identical math to ingestBatch for
    // a single billed impression. A redeem before minDwellMs does NOT consume the
    // token, so an honest client can retry once the 2s dwell completes.
    async redeemImpression({ token, deviceId, revenueShare, minDwellMs, source, tokenSplit }: any) {
      return tx(async (c: any) => {
        const t = await c.query(
          `select campaign_id,
                  used_at is not null                                       as used,
                  expires_at <= now()                                       as expired,
                  (now() - created_at) < ($2 || ' milliseconds')::interval  as too_soon
             from impression_tokens
            where token = $1 and device_id = $3
            for update`,
          [token, String(Math.max(0, minDwellMs | 0)), deviceId]
        );
        const row = t.rows[0];
        if (!row) return { ok: false, reason: "not_found" };
        if (row.used) return { ok: false, reason: "used" };
        if (row.expired) return { ok: false, reason: "expired" };
        if (row.too_soon) return { ok: false, reason: "too_soon" }; // unconsumed → retryable

        await c.query("update impression_tokens set used_at = now() where token = $1", [token]);

        const camp = await c.query(
          `select price_per_block_cents, impressions_remaining from campaigns
            where id = $1 and status = 'active' and paid_at is not null for update`,
          [row.campaign_id]
        );
        if (!camp.rows[0] || camp.rows[0].impressions_remaining < 1) {
          return { ok: true, creditedMillicents: 0, campaignId: row.campaign_id };
        }
        await c.query(
          `update campaigns set
             impressions_remaining = impressions_remaining - 1,
             status = case when impressions_remaining - 1 <= 0 then 'exhausted' else status end
           where id = $1`,
          [row.campaign_id]
        );
        const gross = BigInt(camp.rows[0].price_per_block_cents); // billed = 1
        const meta = source ? { impressions: 1, billed: 1, via: "token", source } : { impressions: 1, billed: 1, via: "token" };
        // Token mode (DWELL deployment): three-way points split of the reserve
        // tranche; the legacy platform-funded affiliate bonus does not apply.
        if (tokenSplit) {
          const viewer = await creditTokenSplit(c, { deviceId, campaignId: row.campaign_id, gross, tokenSplit, meta });
          return { ok: true, creditedMillicents: Number(viewer), campaignId: row.campaign_id };
        }
        const dev = (gross * BigInt(Math.round(revenueShare * 1000))) / 1000n;
        const fee = gross - dev;
        await c.query(
          `insert into ledger (entry_type, amount_millicents, device_id, campaign_id, meta)
           values ('impression_credit', $1, $2, $3, ($4::jsonb #>> '{}')::jsonb)`,
          [dev.toString(), deviceId, row.campaign_id, JSON.stringify(meta)]
        );
        await c.query(
          `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
           values ('platform_fee', $1, $2, '{}')`,
          [fee.toString(), row.campaign_id]
        );
        const du = await c.query("select user_id from devices where id = $1", [deviceId]);
        await creditAffiliate(c, du.rows[0]?.user_id, dev);
        return { ok: true, creditedMillicents: Number(dev), campaignId: row.campaign_id };
      });
    },
    async setStripeAccount(userId: string, accountId: string) {
      await pool.query("update users set stripe_account_id = $2 where id = $1", [userId, accountId]);
    },
    async setPayoutsEnabledByAccount(accountId: string, enabled: boolean) {
      await pool.query("update users set payouts_enabled = $2 where stripe_account_id = $1", [accountId, enabled]);
    },
    async payableUsers(thresholdMillicents: number) {
      const { rows } = await pool.query(
        `select u.id, u.stripe_account_id,
                coalesce(sum(l.amount_millicents), 0)::bigint as balance
           from users u
           join devices d on d.user_id = u.id
           join ledger l on (l.device_id = d.id and l.entry_type in ('impression_credit','click_credit'))
          where u.payouts_enabled and u.stripe_account_id is not null
          group by u.id
         having coalesce(sum(l.amount_millicents), 0)
              + coalesce((select sum(amount_millicents) from ledger where user_id = u.id and entry_type = 'payout_debit'), 0)
              + coalesce((select sum(amount_millicents) from ledger
                           where entry_type = 'gift_redemption_debit'
                             and device_id in (select id from devices where user_id = u.id)), 0)
              + coalesce((select sum(amount_millicents) from ledger
                           where entry_type in ('admin_credit','admin_debit')
                             and (user_id = u.id or device_id in (select id from devices where user_id = u.id))), 0)
             >= $1`,
        [thresholdMillicents]
      );
      return rows.map((r: any) => ({ ...r, balance: Number(r.balance) }));
    },
    async upsertUserByOAuth({ email, googleId, appleId, twitterId, twitterUsername, referralCode, emailVerified }: any, sessionTtlMs: number) {
      return tx(async (c: any) => {
        const matchEmail = emailVerified ? (email || null) : null;
        let found: any = null;
        if (googleId) {
          const r = await c.query("select id, email, google_id, apple_id, twitter_id from users where google_id = $1", [googleId]);
          found = r.rows[0] || null;
        }
        if (!found && appleId) {
          const r = await c.query("select id, email, google_id, apple_id, twitter_id from users where apple_id = $1", [appleId]);
          found = r.rows[0] || null;
        }
        if (!found && twitterId) {
          const r = await c.query("select id, email, google_id, apple_id, twitter_id from users where twitter_id = $1", [twitterId]);
          found = r.rows[0] || null;
        }
        if (!found && matchEmail) {
          const r = await c.query("select id, email, google_id, apple_id, twitter_id from users where email = $1", [matchEmail]);
          found = r.rows[0] || null;
        }
        let userId;
        if (found) {
          const sets = ["email_verified = true"];
          const vals: any[] = [found.id];
          if (matchEmail && !found.email) { sets.push(`email = $${vals.length + 1}`); vals.push(matchEmail); }
          if (googleId && !found.google_id) { sets.push(`google_id = $${vals.length + 1}`); vals.push(googleId); }
          if (appleId && !found.apple_id) { sets.push(`apple_id = $${vals.length + 1}`); vals.push(appleId); }
          if (twitterId && !found.twitter_id) { sets.push(`twitter_id = $${vals.length + 1}`); vals.push(twitterId); }
          if (twitterUsername)                { sets.push(`twitter_username = $${vals.length + 1}`); vals.push(twitterUsername); }
          await c.query(`update users set ${sets.join(", ")} where id = $1`, vals);
          userId = found.id;
        } else {
          const r = await c.query(
            `insert into users (email, email_verified, google_id, apple_id, twitter_id, twitter_username)
             values ($1, true, $2, $3, $4, $5) returning id`,
            [matchEmail || null, googleId || null, appleId || null, twitterId || null, twitterUsername || null]
          );
          userId = r.rows[0].id;
          await applyCode(c, userId, referralCode);
        }
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        await c.query(
          `insert into web_sessions (token, user_id, expires_at)
           values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
          [sessionToken, userId, String(sessionTtlMs)]
        );
        return { sessionToken };
      });
    },
    async createWebSessionFromToken(token: string, sessionTtlMs: number) {
      return tx(async (c: any) => {
        const t = await c.query(
          `update email_tokens set used_at = now()
            where token = $1 and used_at is null and expires_at > now() returning email, referral_code`,
          [token]
        );
        if (!t.rows[0]) return null;
        const u = await c.query(
          `insert into users (email, email_verified) values ($1, true)
           on conflict (email) do update set email_verified = true
           returning id, email, (xmax = 0) as is_new`,
          [t.rows[0].email]
        );
        if (u.rows[0].is_new) await applyCode(c, u.rows[0].id, t.rows[0].referral_code);
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        await c.query(
          `insert into web_sessions (token, user_id, expires_at)
           values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
          [sessionToken, u.rows[0].id, String(sessionTtlMs)]
        );
        return { sessionToken, user: { id: u.rows[0].id, email: u.rows[0].email } };
      });
    },
    async userForSession(sessionToken: string | null) {
      if (!sessionToken) return null;
      const { rows } = await pool.query(
        `select u.id, u.email, u.email_verified, u.stripe_account_id, u.payouts_enabled, u.wallet_address, u.twitter_username
           from web_sessions s join users u on u.id = s.user_id
          where s.token = $1 and s.expires_at > now()`,
        [sessionToken]
      );
      return rows[0] || null;
    },
    async deleteWebSession(sessionToken: string | null) {
      if (!sessionToken) return;
      await pool.query("delete from web_sessions where token = $1", [sessionToken]);
    },
    async balanceForUser(userId: string) {
      // admin_credit/admin_debit adjust the spendable balance (see
      // earningsForDevice) without rewriting lifetime "earned".
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed,
           coalesce(sum(amount_millicents) filter (where entry_type in ('admin_credit','admin_debit')), 0)::bigint as adjusted
         from ledger where user_id = $1 or device_id in (select id from devices where user_id = $1)`,
        [userId]
      );
      const earned = Number(rows[0].earned);
      const paidOut = Number(rows[0].paid_out);
      const redeemed = Number(rows[0].redeemed);
      const adjusted = Number(rows[0].adjusted);
      return { earnedMillicents: earned, paidOutMillicents: -paidOut, redeemedMillicents: -redeemed, balanceMillicents: earned + paidOut + redeemed + adjusted };
    },
    async earningsForUser(userId: string) {
      const { rows } = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit')), 0)::bigint as earned,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit') and created_at >= date_trunc('day', now())), 0)::bigint as today,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit') and created_at >= date_trunc('month', now())), 0)::bigint as month,
           coalesce(sum(amount_millicents) filter (where entry_type = 'payout_debit'), 0)::bigint as paid_out,
           coalesce(sum(amount_millicents) filter (where entry_type = 'gift_redemption_debit'), 0)::bigint as redeemed,
           coalesce(sum(amount_millicents) filter (where entry_type in ('admin_credit','admin_debit')), 0)::bigint as adjusted
         from ledger where user_id = $1 or device_id in (select id from devices where user_id = $1)`,
        [userId]
      );
      const earned = Number(rows[0].earned);
      const today = Number(rows[0].today);
      const month = Number(rows[0].month);
      const paidOut = Number(rows[0].paid_out);
      const redeemed = Number(rows[0].redeemed);
      return {
        lifetimeMillicents: earned, todayMillicents: today, monthMillicents: month,
        redeemedMillicents: -redeemed, paidOutMillicents: -paidOut,
        balanceMillicents: earned + paidOut + redeemed + Number(rows[0].adjusted),
      };
    },
    async earningsSeriesForUser(userId: string, { bucket, since }: any) {
      const unit = bucket === "hour" ? "hour" : "day";
      const { rows } = await pool.query(
        `select date_trunc($2, created_at) as t,
                coalesce(sum(amount_millicents), 0)::bigint as millicents,
                count(*)::int as count
         from ledger
         where (user_id = $1 or device_id in (select id from devices where user_id = $1))
           and entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit')
           and created_at >= $3
         group by 1 order by 1 asc`,
        [userId, unit, since]
      );
      return rows.map((r: any) => ({ t: r.t, millicents: Number(r.millicents), count: r.count }));
    },
    async recentCreditsForUser(userId: string, limit: any) {
      const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 200));
      const { rows } = await pool.query(
        `select l.id, l.created_at, l.entry_type, l.amount_millicents, l.meta, c.brand
           from ledger l
           left join campaigns c on c.id = l.campaign_id
          where (l.user_id = $1 or l.device_id in (select id from devices where user_id = $1))
            and l.entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit')
          order by l.created_at desc limit $2`,
        [userId, n]
      );
      return rows.map((r: any) => ({
        id: r.id, createdAt: r.created_at, entryType: r.entry_type,
        amountMillicents: Number(r.amount_millicents), advertiser: r.brand || null, meta: r.meta || {},
      }));
    },
    // Which surfaces this account has ever received a credit from, read from the
    // source tag stamped on impression credits at ingest. Drives the Install
    // tab's per-service "active" logo (grey → colored on the first credit).
    async sourcesForUser(userId: string) {
      const { rows } = await pool.query(
        `select distinct meta->>'source' as source
           from ledger
          where (user_id = $1 or device_id in (select id from devices where user_id = $1))
            and entry_type in ('impression_credit','click_credit','points_credit')
            and meta->>'source' is not null`,
        [userId]
      );
      const seen = new Set(rows.map((r: any) => r.source));
      return { chrome: seen.has("chrome"), claude_code: seen.has("claude_code"), desktop: seen.has("desktop") };
    },

    // ---------- DWELL token mode: reserve attestation ----------
    // Public /v1/reserve numbers (dwell/docs/04 §D): what the ledger says has
    // been earmarked + accrued, next to what the keeper says is escrowed. The
    // three points legs and the allocation are ledger-derived (never stored);
    // escrowed USDC comes from usdc_reserve_entries (keeper-written).
    // Mirrors server/src/repo.js.
    async reserveStatus() {
      const led = await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type = 'reserve_allocation'), 0)::bigint as allocated,
           coalesce(sum(amount_millicents) filter (where entry_type = 'points_credit'), 0)::bigint as viewer,
           coalesce(sum(amount_millicents) filter (where entry_type = 'referral_points_credit'), 0)::bigint as referrer,
           coalesce(sum(amount_millicents) filter (where entry_type = 'protocol_points_credit'), 0)::bigint as protocol,
           coalesce(sum(amount_millicents) filter (where entry_type = 'token_claim_debit'), 0)::bigint as claimed
         from ledger`
      );
      const usdc = await pool.query(
        `select coalesce(sum(case when direction = 'escrow' then amount_micro_usdc
                                  else -amount_micro_usdc end), 0)::bigint as escrowed
           from usdc_reserve_entries`
      );
      const l = led.rows[0];
      const accrued = Number(l.viewer) + Number(l.referrer) + Number(l.protocol);
      return {
        allocatedMillicents: Number(l.allocated),
        accruedPointsMillicents: accrued,
        viewerPointsMillicents: Number(l.viewer),
        referrerPointsMillicents: Number(l.referrer),
        protocolPointsMillicents: Number(l.protocol),
        outstandingPointsMillicents: accrued + Number(l.claimed), // claim debits are negative
        escrowedMicroUsdc: Number(usdc.rows[0].escrowed),
      };
    },

    // Live mode: funded campaign pools + locked rates, from the indexer's
    // mirror of CampaignFunded events (dwell/docs/04 §D — GET /v1/token/pools).
    async tokenCampaignPools(limit: any = 100) {
      const { rows } = await pool.query(
        `select campaign_id, usdc_in_micro, dwell_out_wei, to_distributor_wei,
                to_treasury_wei, burned_wei, locked_rate_wei, tx_hash, funded_at
           from token_campaign_pools order by funded_at desc limit $1`,
        [Math.max(1, Math.min(500, parseInt(limit, 10) || 100))]
      );
      return rows.map((r: any) => ({
        campaignId: r.campaign_id,
        usdcInMicro: Number(r.usdc_in_micro),
        dwellOutWei: r.dwell_out_wei,
        toDistributorWei: r.to_distributor_wei,
        toTreasuryWei: r.to_treasury_wei,
        burnedWei: r.burned_wei,
        lockedRateWei: r.locked_rate_wei,
        txHash: r.tx_hash,
        fundedAt: r.funded_at,
      }));
    },

    // ---------- USDC advertiser checkout (dwell/docs/08) ----------
    // Mirrors server/src/repo.js. The order row is the verification contract:
    // the API builds a transaction matching these amounts, the advertiser's
    // wallet signs it, and the verifier confirms the finalized transaction
    // against this row read-only.

    async createUsdcOrder({ campaignId, priceMicroUsdc, feeMicroUsdc, trancheMicroUsdc, payCurrency = "usdc", payTotalUnits, payFeeUnits, quote, minDwellOut, referencePubkey, ttlMinutes }: any) {
      const { rows } = await pool.query(
        `insert into usdc_orders
           (campaign_id, price_micro_usdc, fee_micro_usdc, tranche_micro_usdc,
            pay_currency, pay_total_units, pay_fee_units,
            quote, min_dwell_out, reference_pubkey, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(mins => $11))
         returning id, expires_at`,
        [campaignId, priceMicroUsdc, feeMicroUsdc, trancheMicroUsdc,
         payCurrency, payTotalUnits ?? priceMicroUsdc, payFeeUnits ?? feeMicroUsdc,
         JSON.stringify(quote), minDwellOut, referencePubkey, ttlMinutes]
      );
      return rows[0];
    },

    // Lazy expiry rides every read: an unsigned order past its window flips to
    // 'expired' (nothing happened on-chain, so there is nothing to clean up).
    async getUsdcOrder(orderId: string) {
      await pool.query(
        `update usdc_orders set status = 'expired'
          where id = $1 and status = 'awaiting_signature' and expires_at < now()`,
        [orderId]
      );
      const { rows } = await pool.query(
        `select o.*, c.status as campaign_status, c.impressions_total, c.budget_cents
           from usdc_orders o join campaigns c on c.id = o.campaign_id
          where o.id = $1`,
        [orderId]
      );
      return rows[0] || null;
    },

    // Crypto orders for the admin transactions view: every rail, every status,
    // newest first, joined to the campaign + advertiser for context. Read-only.
    async listCryptoOrders({ limit, status }: any = {}) {
      const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
      const params: any[] = [];
      let where = "";
      if (status) { params.push(status); where = `where o.status = $${params.length}`; }
      params.push(n); const lim = `$${params.length}`;
      const { rows } = await pool.query(
        `select o.id, o.pay_currency, o.status, o.fail_reason,
                o.price_micro_usdc, o.pay_total_units, o.pay_fee_units,
                o.reference_pubkey, o.tx_signature, o.created_at, o.expires_at,
                o.payer_address, o.received_amount_raw, o.swap_signature,
                o.realized_micro_usdc, o.refund_signature,
                c.brand, c.ad_line, a.email as advertiser_email
           from usdc_orders o
           join campaigns c on c.id = o.campaign_id
           left join advertisers a on a.id = c.advertiser_id
           ${where}
          order by o.created_at desc
          limit ${lim}`,
        params
      );
      return rows;
    },

    // Each build re-quotes (a built transaction is only ~60s of blockhash
    // validity); the stored quote + slippage floor — and, on the SOL rail, the
    // re-priced lamport amounts — track the latest build so the verifier
    // checks what the wallet was actually shown.
    async refreshUsdcOrderQuote(orderId: string, quote: any, minDwellOut: string, { payTotalUnits, payFeeUnits }: any = {}) {
      await pool.query(
        `update usdc_orders set quote = $2, min_dwell_out = $3,
                pay_total_units = coalesce($4, pay_total_units),
                pay_fee_units = coalesce($5, pay_fee_units)
          where id = $1 and status = 'awaiting_signature'`,
        [orderId, JSON.stringify(quote), minDwellOut, payTotalUnits ?? null, payFeeUnits ?? null]
      );
    },

    async failUsdcOrder(orderId: string, reason: string, txSignature?: string) {
      await pool.query(
        `update usdc_orders set status = 'failed', fail_reason = $2,
                tx_signature = coalesce($3, tx_signature)
          where id = $1 and status = 'awaiting_signature'`,
        [orderId, String(reason).slice(0, 120), txSignature || null]
      );
    },

    // The one state transition that funds a campaign from a verified on-chain
    // payment (tokenomics v2). Mirrors markCampaignPaid's exactly-once shape
    // (only an awaiting_signature order and a pending_payment campaign
    // transition) and funds the campaign on the dollar ledger exactly like a
    // card payment: campaign_credit for the exact charge plus the rewards-pool
    // earmark. No token machinery — viewers earn dollar-denominated dwells on
    // every rail.
    async confirmUsdcOrder({ orderId, txSignature, payerAddress, receivedRaw, tokenSplit }: any) {
      return tx(async (c: any) => {
        const ord = await c.query(
          `update usdc_orders set status = 'confirmed', tx_signature = $2,
                  payer_address = $3, received_amount_raw = $4
            where id = $1 and status = 'awaiting_signature'
            returning campaign_id, price_micro_usdc, fee_micro_usdc, tranche_micro_usdc, pay_currency`,
          [orderId, txSignature, payerAddress || null, receivedRaw || null]
        );
        if (!ord.rows[0]) return false; // already confirmed/expired/failed — idempotent no-op
        const o = ord.rows[0];

        const { rows } = await c.query(
          `update campaigns cmp set status = 'pending_review', paid_at = now()
             from advertisers adv
            where cmp.id = $1 and cmp.status = 'pending_payment'
              and adv.id = cmp.advertiser_id
            returning adv.email, cmp.brand, cmp.ad_line, cmp.price_per_block_cents,
                      cmp.blocks, cmp.impressions_total, cmp.budget_cents`,
          [o.campaign_id]
        );
        if (!rows[0]) {
          // Campaign no longer fundable (cancelled, or a sibling order won the
          // race). Throw so the whole tx — including the order flip above —
          // rolls back; the caller marks the order failed with the signature.
          throw Object.assign(new Error("campaign not fundable"), { code: "CAMPAIGN_NOT_FUNDABLE" });
        }

        // Fund with the EXACT charge. USDC micro units -> millicents is /10.
        // SOL/$DWELL rails DEFER funding: the crypto is held during review and
        // the funded amount is only known after the acceptance-time hedge swap
        // (finalizeAcceptedSwap posts these entries from the realized USDC).
        if (!["sol", "dwell"].includes(o.pay_currency)) {
          const funded = BigInt(o.price_micro_usdc) / 10n;
          await c.query(
            `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
             values ('campaign_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [funded.toString(), o.campaign_id,
             JSON.stringify({ impressions: rows[0].impressions_total, rail: o.pay_currency, tx: txSignature })]
          );
          if (tokenSplit) {
            const tranche = (funded * BigInt(tokenSplit.reserveTrancheBps)) / 10000n;
            await c.query(
              `insert into ledger (entry_type, amount_millicents, campaign_id, meta)
               values ('reserve_allocation', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
              [tranche.toString(), o.campaign_id,
               JSON.stringify({ trancheBps: tokenSplit.reserveTrancheBps, rail: o.pay_currency })]
            );
          }
        }

        return {
          email: rows[0].email,
          brand: rows[0].brand,
          adLine: rows[0].ad_line,
          pricePerBlockCents: rows[0].price_per_block_cents,
          blocks: rows[0].blocks,
          impressionsTotal: rows[0].impressions_total,
          budgetCents: rows[0].budget_cents != null ? Number(rows[0].budget_cents) : null,
        };
      });
    },

    async recordGiftRedemptionForUser({ id, userId, plan, months, amountCents, feeCents = 0, debitCents = null, recipientEmail, referralRewardMillicents, referralCap }: any) {
      return tx(async (c: any) => {
        await c.query("select pg_advisory_xact_lock($1, hashtext($2))", [LOCK_REDEEM, `user:${userId}`]);
        const bal = await c.query(
          `select coalesce(sum(amount_millicents), 0)::bigint as balance from ledger
            where (user_id = $1 or device_id in (select id from devices where user_id = $1))
              and entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit','payout_debit','gift_redemption_debit','admin_credit','admin_debit')`,
          [userId]
        );
        // Legacy pricing debits face + fee (fee platform-side, ledger closed).
        // v2 boost pricing passes debitCents (< face): the user is debited less
        // than face value and the delta is the platform's fulfillment cost.
        const costMillicents = (debitCents != null ? BigInt(debitCents) : BigInt(amountCents) + BigInt(feeCents)) * 1000n;
        if (BigInt(bal.rows[0].balance) < costMillicents) return null;
        const { rows } = await c.query(
          `insert into gift_redemptions (id, user_id, plan, months, amount_cents, recipient_email)
           values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6) returning id`,
          [id || null, userId, plan, months, amountCents, recipientEmail]
        );
        await c.query(
          `insert into ledger (entry_type, amount_millicents, user_id, meta)
           values ('gift_redemption_debit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
          [(-costMillicents).toString(), userId, JSON.stringify({ redemptionId: rows[0].id, plan, months, faceCents: amountCents, feeCents })]
        );
        if (feeCents > 0) {
          await c.query(
            `insert into ledger (entry_type, amount_millicents, meta)
             values ('platform_fee', $1, ($2::jsonb #>> '{}')::jsonb)`,
            [(BigInt(feeCents) * 1000n).toString(), JSON.stringify({ source: "redemption_fee", redemptionId: rows[0].id, userId })]
          );
        }
        // The $20 referral program is retired — redeeming no longer rewards any
        // referrer. (maybeRewardReferral is kept defined but uncalled.) We still
        // return an object with a null reward so the redemption flow keeps a
        // stable shape for callers that branch on `reward`.
        return { id: rows[0].id, reward: null };
      });
    },
    async getOrCreateReferralCode(userId: string) {
      const existing = await pool.query("select referral_code from users where id = $1", [userId]);
      if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;
      for (let i = 0; i < 6; i++) {
        const code = generateReferralCode();
        try {
          const r = await pool.query(
            "update users set referral_code = $2 where id = $1 and referral_code is null returning referral_code",
            [userId, code]
          );
          if (r.rows[0]) return r.rows[0].referral_code;
          const re = await pool.query("select referral_code from users where id = $1", [userId]);
          if (re.rows[0]?.referral_code) return re.rows[0].referral_code;
        } catch (err: any) {
          if (err.code === "23505") continue;
          throw err;
        }
      }
      throw new Error("could not allocate referral code");
    },
    async createReferralInvite(referrerUserId: string, email: string, code: string) {
      const r = await pool.query(
        `insert into referral_invites (referrer_user_id, email, code)
           values ($1, lower($2), $3)
         on conflict (referrer_user_id, email)
           do update set sent_at = now(), code = excluded.code
         returning email, status, sent_at`,
        [referrerUserId, email, code]
      );
      return r.rows[0];
    },
    // Pending crew invites (email sent, friend hasn't signed up yet) for the
    // device-scoped affiliate panel in the extension. Masked emails only — the
    // full address never leaves the server. Friends who've already joined are
    // filtered out by the caller (they surface via affiliateCrew instead).
    async pendingInvitesForUser(userId: string) {
      const r = await pool.query(
        `select email, sent_at from referral_invites
          where referrer_user_id = $1 and status = 'sent'
          order by sent_at asc limit 20`,
        [userId]
      );
      return r.rows.map((row: any) => ({ email: maskEmail(row.email), invitedAt: row.sent_at }));
    },
    // First-login onboarding gate: true once the user has referred anyone — either
    // sent at least one invite, or has a friend who joined with their code. Drives
    // the "refer a friend to start earning" screen the new user must clear before
    // reaching their dashboard.
    async hasReferredAnyone(userId: string) {
      const r = await pool.query(
        `select exists(select 1 from referral_invites where referrer_user_id = $1)
             or exists(select 1 from referrals where referrer_user_id = $1) as referred`,
        [userId]
      );
      return r.rows[0]?.referred === true;
    },

    // First-login survey: true once the user has answered the "what models /
    // where do you use them" questions. Drives the needsSurvey gate on
    // /v1/web/me, shown before the refer-a-friend step.
    async hasOnboardingSurvey(userId: string) {
      const r = await pool.query("select 1 from onboarding_surveys where user_id = $1", [userId]);
      return r.rowCount > 0;
    },
    // Upsert the survey answers (idempotent — re-answering overwrites). Arrays
    // are stored as jsonb; surfaceOther is the free text for the "other" surface.
    async saveOnboardingSurvey(userId: string, { models, surfaces, surfaceOther }: any) {
      await pool.query(
        `insert into onboarding_surveys (user_id, models, surfaces, surface_other)
           values ($1, ($2::jsonb #>> '{}')::jsonb, ($3::jsonb #>> '{}')::jsonb, $4)
         on conflict (user_id) do update
           set models = excluded.models, surfaces = excluded.surfaces,
               surface_other = excluded.surface_other, updated_at = now()`,
        [userId, JSON.stringify(models), JSON.stringify(surfaces), surfaceOther]
      );
    },
    // First-login onboarding post: true once the user has confirmed they posted
    // the prebuilt DWELL note to their X timeline. Drives the needsPost gate on
    // /v1/web/me — the dashboard stays locked until it's set, and accounts
    // without it may not be paid out.
    async hasPostedOnboarding(userId: string) {
      const r = await pool.query("select onboarding_posted_at from users where id = $1", [userId]);
      return r.rows[0]?.onboarding_posted_at != null;
    },
    // Self-attested — set the first time the user confirms the post. Idempotent.
    async markOnboardingPosted(userId: string) {
      await pool.query(
        "update users set onboarding_posted_at = coalesce(onboarding_posted_at, now()) where id = $1",
        [userId]
      );
    },
    // Record a server-side X verification of the onboarding post (admin-only).
    async saveOnboardingPostVerification(userId: string, { url }: any) {
      await pool.query(
        `update users set onboarding_post_verified_at = case when $2::text is not null then now() else null end,
                          onboarding_post_url = $2, onboarding_post_checked_at = now()
           where id = $1`,
        [userId, url || null]
      );
    },
    async userForAdmin(userId: string) {
      const r = await pool.query(
        `select id, email, twitter_id, stripe_account_id, payouts_enabled,
                onboarding_posted_at, onboarding_post_verified_at, onboarding_post_url, onboarding_post_checked_at
           from users where id = $1`,
        [userId]
      );
      return r.rows[0] || null;
    },
    async referralStats(userId: string) {
      const stats = await pool.query(
        `select
           count(*) filter (where status = 'rewarded')::int as rewarded,
           count(*) filter (where status = 'pending')::int as pending,
           count(*) filter (where status = 'capped')::int as capped,
           coalesce(sum(reward_millicents), 0)::bigint as earned_millicents
         from referrals where referrer_user_id = $1`,
        [userId]
      );
      const joined = await pool.query(
        `select u.email, r.status, r.created_at
           from referrals r join users u on u.id = r.referred_user_id
          where r.referrer_user_id = $1 order by r.created_at desc limit 100`,
        [userId]
      );
      const invited = await pool.query(
        `select email, sent_at as created_at from referral_invites
          where referrer_user_id = $1 and status = 'sent' order by sent_at desc limit 100`,
        [userId]
      );
      const s = stats.rows[0];
      const referrals = [
        ...invited.rows.map((r: any) => ({ email: maskEmail(r.email), status: "invited", createdAt: r.created_at })),
        ...joined.rows.map((r: any) => ({ email: maskEmail(r.email), status: r.status, createdAt: r.created_at })),
      ].sort((a: any, b: any) => +new Date(b.createdAt) - +new Date(a.createdAt));
      return {
        rewardedCount: s.rewarded, pendingCount: s.pending, cappedCount: s.capped,
        invitedCount: invited.rows.length,
        creditsEarnedMillicents: Number(s.earned_millicents),
        referrals,
      };
    },
    // ---------- affiliates ----------
    async submitAffiliateApplication(userId: string, socials: any) {
      const s = socials || {};
      const { rows } = await pool.query(
        `insert into affiliates
           (user_id, instagram_handle, instagram_followers,
            linkedin_handle, linkedin_followers, twitter_handle, twitter_followers)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (user_id) do nothing
         returning id, status`,
        [userId, s.instagram || null, s.instagramFollowers ?? null,
         s.linkedin || null, s.linkedinFollowers ?? null,
         s.twitter || null, s.twitterFollowers ?? null]
      );
      return rows[0] || null;
    },
    async affiliateForUser(userId: string) {
      const u = await pool.query("select affiliate_id, referred_by from users where id = $1", [userId]);
      const attributed = !!u.rows[0]?.affiliate_id;
      const hasReferrer = !!u.rows[0]?.referred_by;
      const a = await pool.query(
        `select id, status, code, instagram_handle, instagram_followers,
                linkedin_handle, linkedin_followers, twitter_handle, twitter_followers,
                reward_bps, cap_millicents, cap_people, credited_millicents, created_at, approved_at
           from affiliates where user_id = $1`,
        [userId]
      );
      if (!a.rows[0]) return { application: null, attributed, hasReferrer };
      const aff = a.rows[0];
      let attributedCount = 0;
      if (aff.status === "approved") {
        const cnt = await pool.query(
          "select count(*)::int as n from affiliate_attributions where affiliate_id = $1",
          [aff.id]
        );
        attributedCount = cnt.rows[0].n;
      }
      return {
        attributed, hasReferrer,
        application: {
          status: aff.status, code: aff.code,
          socials: {
            instagram: aff.instagram_handle, instagramFollowers: aff.instagram_followers,
            linkedin: aff.linkedin_handle, linkedinFollowers: aff.linkedin_followers,
            twitter: aff.twitter_handle, twitterFollowers: aff.twitter_followers,
          },
          rewardBps: aff.reward_bps,
          capMillicents: Number(aff.cap_millicents),
          capPeople: Number(aff.cap_people),
          creditedMillicents: Number(aff.credited_millicents),
          attributedCount, createdAt: aff.created_at, approvedAt: aff.approved_at,
        },
      };
    },
    async applyAffiliateCodeForUser(userId: string, code: any) {
      return tx(async (c: any) => {
        const u = await c.query("select affiliate_id, referred_by from users where id = $1 for update", [userId]);
        if (u.rows[0]?.affiliate_id) return { ok: false, reason: "already_affiliated" };
        if (u.rows[0]?.referred_by) return { ok: false, reason: "has_referrer" };
        const ok = await applyAffiliateCode(c, userId, code);
        return { ok, reason: ok ? null : "invalid_code" };
      });
    },
    async listAffiliateApplications() {
      const { rows } = await pool.query(
        `select a.id, a.status, a.code, u.email,
                a.instagram_handle, a.instagram_followers,
                a.linkedin_handle, a.linkedin_followers,
                a.twitter_handle, a.twitter_followers,
                a.reward_bps, a.cap_millicents, a.cap_people, a.credited_millicents,
                a.review_note, a.created_at, a.approved_at,
                (select count(*)::int from affiliate_attributions aa where aa.affiliate_id = a.id) as attributed_count
           from affiliates a join users u on u.id = a.user_id
          order by case a.status when 'pending' then 0 when 'approved' then 1 else 2 end,
                   a.created_at desc`
      );
      return rows;
    },
    async approveAffiliate(affiliateId: string) {
      const existing = await pool.query("select id from affiliates where id = $1", [affiliateId]);
      if (!existing.rows[0]) return null;
      const code = await mintAffiliateCode(affiliateId);
      const upd = await pool.query(
        `update affiliates set status = 'approved', approved_at = coalesce(approved_at, now()),
            review_note = null where id = $1 returning id`,
        [affiliateId]
      );
      return upd.rows[0] ? { id: affiliateId, code } : null;
    },
    // Self-serve affiliate enrollment: every signed-in earner is an approved
    // affiliate (base 10%) with a code — no social application, no admin review.
    async getOrCreateAffiliate(userId: string) {
      return ensureAffiliate(userId);
    },
    // Influencer upgrade request: the user keeps their active base 10% while
    // attaching socials so an admin can grant a higher rate / uncapped earnings /
    // a custom code. Records the socials on the (auto-created) affiliate row; the
    // presence of any handle is the "upgrade requested" signal the dashboard reads.
    async requestAffiliateUpgrade(userId: string, socials: any) {
      await ensureAffiliate(userId);
      const s = socials || {};
      await pool.query(
        `update affiliates set
           instagram_handle = $2, instagram_followers = $3,
           linkedin_handle = $4, linkedin_followers = $5,
           twitter_handle = $6, twitter_followers = $7
         where user_id = $1`,
        [userId, s.instagram || null, s.instagramFollowers ?? null,
         s.linkedin || null, s.linkedinFollowers ?? null,
         s.twitter || null, s.twitterFollowers ?? null]
      );
    },
    // Per-friend crew breakdown for an affiliate: each attributed friend, the
    // credits they've generated, and the affiliate's 10% cut earned from them.
    async affiliateCrew(affiliateId: string, affiliateUserId: string) {
      const credited = await pool.query(
        "select coalesce(sum(amount_millicents), 0)::bigint as c from ledger where entry_type in ('affiliate_credit','referral_points_credit') and user_id = $1",
        [affiliateUserId]
      );
      const { rows } = await pool.query(
        `select u.email,
          coalesce((select sum(amount_millicents) from ledger l
                     where l.entry_type in ('impression_credit','click_credit','points_credit')
                       and (l.user_id = aa.affiliated_user_id
                            or l.device_id in (select id from devices where user_id = aa.affiliated_user_id))), 0)::bigint as generated,
          coalesce((select sum(amount_millicents) from ledger l
                     where l.entry_type in ('affiliate_credit','referral_points_credit') and l.user_id = $2
                       and l.meta->>'affiliatedUserId' = aa.affiliated_user_id::text), 0)::bigint as your_cut
         from affiliate_attributions aa
         join users u on u.id = aa.affiliated_user_id
        where aa.affiliate_id = $1
        order by aa.created_at asc
        limit 50`,
        [affiliateId, affiliateUserId]
      );
      return {
        count: rows.length,
        creditedMillicents: Number(credited.rows[0].c),
        friends: rows.map((r: any) => ({
          name: maskEmail(r.email),
          generatedUsd: Number(r.generated) / 100000,
          youUsd: Number(r.your_cut) / 100000,
        })),
      };
    },
    async rejectAffiliate(affiliateId: string, note: string) {
      const { rows } = await pool.query(
        "update affiliates set status = 'rejected', review_note = $2 where id = $1 returning id",
        [affiliateId, note || null]
      );
      return rows[0] || null;
    },
    // Admin grants an influencer upgrade: a custom rate (reward_bps), a raised /
    // uncapped people cap, and optionally a vanity code. Stays 'approved' so the
    // cut keeps flowing. rewardBps/capPeople are validated by the route.
    async grantAffiliateUpgrade(affiliateId: string, opts: any) {
      const ex = await pool.query("select id, code from affiliates where id = $1", [affiliateId]);
      if (!ex.rows[0]) return { ok: false, error: "not found" };
      let newCode: string | null = null;
      if (opts.code != null && String(opts.code).trim() !== "") {
        newCode = String(opts.code).trim().toUpperCase();
        if (!/^[A-Z0-9]{3,16}$/.test(newCode)) return { ok: false, error: "code must be 3–16 letters or numbers" };
        if (newCode !== ex.rows[0].code) {
          const clash = await pool.query(
            `select 1 from users where upper(referral_code) = $1
              union all select 1 from affiliates where upper(code) = $1 and id <> $2`,
            [newCode, affiliateId]
          );
          if (clash.rows[0]) return { ok: false, error: "that code is already taken" };
        }
      }
      const upd = await pool.query(
        `update affiliates set status = 'approved', approved_at = coalesce(approved_at, now()),
            reward_bps = $2, cap_people = $3, code = coalesce($4, code), review_note = null
          where id = $1
          returning id, reward_bps, cap_people, code`,
        [affiliateId, opts.rewardBps, opts.capPeople, newCode]
      );
      return { ok: true, affiliate: upd.rows[0] };
    },
    // Post-transfer record used by the admin sweep: debits the gross, books the
    // protocol's fee platform-side, and stores the net actually transferred.
    async recordPayout(userId: string, grossCents: number, netCents: number, feeCents: number, transferId: string) {
      return tx(async (c: any) => {
        await c.query(
          `insert into ledger (entry_type, amount_millicents, user_id, meta)
           values ('payout_debit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
          [(-BigInt(grossCents) * 1000n).toString(), userId, JSON.stringify({ transferId, grossCents, netCents, feeCents })]
        );
        if (feeCents > 0) {
          await c.query(
            `insert into ledger (entry_type, amount_millicents, meta)
             values ('platform_fee', $1, ($2::jsonb #>> '{}')::jsonb)`,
            [(BigInt(feeCents) * 1000n).toString(), JSON.stringify({ source: "payout_fee", userId, transferId })]
          );
        }
        await c.query("insert into payouts (user_id, amount_cents, stripe_transfer_id) values ($1,$2,$3)", [userId, netCents, transferId]);
      });
    },

    // Recent payout history for the portal's cash-out card. amount_cents is the
    // net the user received (or will receive, for 'pending').
    async payoutsForUser(userId: string) {
      const { rows } = await pool.query(
        `select amount_cents, status, method, destination, tx_signature, created_at
           from payouts where user_id = $1 order by created_at desc limit 20`,
        [userId]
      );
      return rows.map((r: any) => ({
        amountUsd: r.amount_cents / 100,
        status: r.status,
        method: r.method || "stripe",
        destination: r.destination || null,
        txSignature: r.tx_signature || null,
        createdAt: r.created_at,
      }));
    },

    // Tokenomics v2: link a Solana wallet for USDC payouts.
    async linkWallet(userId: string, address: string) {
      try {
        await pool.query(
          `update users set wallet_address = $2, wallet_provider = 'external', wallet_linked_at = now()
            where id = $1`,
          [userId, address]
        );
        return { ok: true };
      } catch (err: any) {
        if (err.code === "23505") return { ok: false, taken: true };
        throw err;
      }
    },

    // Ops half of a USDC payout: partner executed the transfer, stamp the signature.
    async markUsdcPayoutPaid(payoutId: string, txSignature: string) {
      const { rowCount } = await pool.query(
        `update payouts set status = 'paid', tx_signature = $2
          where id = $1 and method = 'usdc' and status in ('requested', 'pending')`,
        [payoutId, txSignature]
      );
      return rowCount === 1;
    },

    // Queue view for ops: pending USDC payouts oldest-first.
    async pendingUsdcPayouts() {
      const { rows } = await pool.query(
        `select p.id, p.user_id, u.email, p.amount_cents, p.destination, p.created_at
           from payouts p join users u on u.id = p.user_id
          where p.method = 'usdc' and p.status = 'requested'
          order by p.created_at asc limit 200`
      );
      return rows.map((r: any) => ({
        id: r.id, userId: r.user_id, email: r.email,
        amountUsd: r.amount_cents / 100, destination: r.destination, createdAt: r.created_at,
      }));
    },

    // Debit-first half of an on-demand payout: inside one transaction, take the
    // per-user redemption lock, re-check the balance, debit the gross, book the
    // fee, and create a 'pending' payouts row. The Stripe transfer happens after
    // commit; finalizePayout flips the row to paid/failed. Returns
    // { id, netCents } or null when the balance no longer covers the gross.
    async recordPayoutRequest({ userId, grossCents, feeCents, method = "stripe", destination = null }: any) {
      return tx(async (c: any) => {
        await c.query("select pg_advisory_xact_lock($1, hashtext($2))", [LOCK_REDEEM, `user:${userId}`]);
        const bal = await c.query(
          `select coalesce(sum(amount_millicents), 0)::bigint as balance from ledger
            where (user_id = $1 or device_id in (select id from devices where user_id = $1))
              and entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit','payout_debit','gift_redemption_debit','admin_credit','admin_debit')`,
          [userId]
        );
        const grossMillicents = BigInt(grossCents) * 1000n;
        if (BigInt(bal.rows[0].balance) < grossMillicents) return null;

        const netCents = grossCents - feeCents;
        // Queue as 'requested': funds held via the debit, no transfer until an
        // admin approves. See claimPayoutRequest / rejectPayoutRequest.
        const { rows } = await c.query(
          `insert into payouts (user_id, amount_cents, status, method, destination)
           values ($1, $2, 'requested', $3, $4) returning id`,
          [userId, netCents, method, destination]
        );
        await c.query(
          `insert into ledger (entry_type, amount_millicents, user_id, meta)
           values ('payout_debit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
          [(-grossMillicents).toString(), userId, JSON.stringify({ payoutId: rows[0].id, grossCents, netCents, feeCents })]
        );
        if (feeCents > 0) {
          await c.query(
            `insert into ledger (entry_type, amount_millicents, meta)
             values ('platform_fee', $1, ($2::jsonb #>> '{}')::jsonb)`,
            [(BigInt(feeCents) * 1000n).toString(), JSON.stringify({ source: "payout_fee", payoutId: rows[0].id, userId })]
          );
        }
        return { id: rows[0].id, netCents, grossCents, feeCents };
      });
    },

    // Second half of an on-demand payout. Success stamps the transfer id;
    // failure reverses both ledger legs (credit the user's gross back, negate
    // the fee) so the books return to exactly the pre-request state.
    async finalizePayout(payoutId: string, outcome: any) {
      return tx(async (c: any) => {
        if (outcome.failed) {
          await c.query("update payouts set status = 'failed' where id = $1", [payoutId]);
          await c.query(
            `insert into ledger (entry_type, amount_millicents, user_id, meta)
             values ('admin_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [(BigInt(outcome.grossCents) * 1000n).toString(), outcome.userId, JSON.stringify({ source: "payout_reversal", payoutId })]
          );
          if (outcome.feeCents > 0) {
            await c.query(
              `insert into ledger (entry_type, amount_millicents, meta)
               values ('platform_fee', $1, ($2::jsonb #>> '{}')::jsonb)`,
              [(-BigInt(outcome.feeCents) * 1000n).toString(), JSON.stringify({ source: "payout_fee_reversal", payoutId })]
            );
          }
        } else {
          await c.query(
            "update payouts set status = 'paid', stripe_transfer_id = $2 where id = $1",
            [payoutId, outcome.transferId]
          );
        }
      });
    },
    // ── manual payout approval (admin) ──
    async listPayoutRequests() {
      const r = await pool.query(
        `select p.id, p.user_id, p.amount_cents as net_cents, p.created_at,
                (l.meta->>'grossCents')::int as gross_cents,
                (l.meta->>'feeCents')::int as fee_cents,
                u.email, u.twitter_id, u.twitter_username, u.stripe_account_id, u.payouts_enabled,
                u.onboarding_posted_at, u.onboarding_post_verified_at,
                u.onboarding_post_url, u.onboarding_post_checked_at
           from payouts p
           join users u on u.id = p.user_id
           left join ledger l on l.entry_type = 'payout_debit' and l.meta->>'payoutId' = p.id::text
          where p.status = 'requested'
          order by p.created_at asc`
      );
      return r.rows;
    },
    async claimPayoutRequest(payoutId: string) {
      return tx(async (c: any) => {
        const p = await c.query(
          "update payouts set status = 'pending' where id = $1 and status = 'requested' returning id, user_id, amount_cents",
          [payoutId]
        );
        if (!p.rows[0]) return null;
        const u = await c.query("select stripe_account_id, payouts_enabled from users where id = $1", [p.rows[0].user_id]);
        const meta = await c.query(
          "select meta from ledger where entry_type = 'payout_debit' and meta->>'payoutId' = $1::text",
          [payoutId]
        );
        return {
          id: p.rows[0].id, userId: p.rows[0].user_id, netCents: p.rows[0].amount_cents,
          grossCents: Number(meta.rows[0]?.meta?.grossCents || 0),
          feeCents: Number(meta.rows[0]?.meta?.feeCents || 0),
          stripeAccountId: u.rows[0]?.stripe_account_id || null,
          payoutsEnabled: !!u.rows[0]?.payouts_enabled,
        };
      });
    },
    async releasePayoutClaim(payoutId: string) {
      await pool.query("update payouts set status = 'requested' where id = $1 and status = 'pending'", [payoutId]);
    },
    async rejectPayoutRequest(payoutId: string) {
      return tx(async (c: any) => {
        const p = await c.query(
          "update payouts set status = 'rejected' where id = $1 and status = 'requested' returning id, user_id",
          [payoutId]
        );
        if (!p.rows[0]) return null;
        const userId = p.rows[0].user_id;
        const meta = await c.query(
          "select meta from ledger where entry_type = 'payout_debit' and meta->>'payoutId' = $1::text",
          [payoutId]
        );
        const grossCents = Number(meta.rows[0]?.meta?.grossCents || 0);
        const feeCents = Number(meta.rows[0]?.meta?.feeCents || 0);
        if (grossCents > 0) {
          await c.query(
            `insert into ledger (entry_type, amount_millicents, user_id, meta)
             values ('admin_credit', $1, $2, ($3::jsonb #>> '{}')::jsonb)`,
            [(BigInt(grossCents) * 1000n).toString(), userId, JSON.stringify({ source: "payout_reversal", payoutId })]
          );
        }
        if (feeCents > 0) {
          await c.query(
            `insert into ledger (entry_type, amount_millicents, meta)
             values ('platform_fee', $1, ($2::jsonb #>> '{}')::jsonb)`,
            [(-BigInt(feeCents) * 1000n).toString(), JSON.stringify({ source: "payout_fee_reversal", payoutId })]
          );
        }
        return { ok: true, userId, grossCents };
      });
    },
    // Pre-account email capture from the public landers. Normalizes the email,
    // enforces a soft per-IP daily cap (the edge runtime has no in-memory limiter
    // and this endpoint is unauthenticated), and is idempotent on (email, kind):
    // a re-submit returns created:false. Distinct from joinWaitlist below, which
    // is the signed-in, per-ad-surface interest list.
    async addEmailLead({ email, kind = "earn", source = null, ipHash = null, ipDailyCap = 0 }: any) {
      const e = String(email || "").trim().toLowerCase();
      if (ipHash && Number.isFinite(ipDailyCap) && ipDailyCap > 0) {
        const cap = await pool.query(
          `select count(*)::int as n from email_leads
            where ip_hash = $1 and created_at >= date_trunc('day', now())`,
          [ipHash]
        );
        if (cap.rows[0].n >= ipDailyCap) {
          const err: any = new Error("daily lead cap exceeded");
          err.code = "CAP_EXCEEDED";
          throw err;
        }
      }
      const { rows } = await pool.query(
        `insert into email_leads (email, kind, source, ip_hash) values ($1, $2, $3, $4)
         on conflict (email, kind) do nothing returning id`,
        [e, kind, source, ipHash]
      );
      return { created: !!rows[0] };
    },
    async listWaitlistSurfaces() {
      const { rows } = await pool.query("select surface, label from waitlist_surfaces order by sort_order asc, surface asc");
      return rows;
    },
    async joinWaitlist(userId: string, surface: string) {
      const { rows } = await pool.query(
        `insert into waitlist_signups (user_id, surface) values ($1, $2)
         on conflict (user_id, surface) do nothing returning id`,
        [userId, surface]
      );
      return !!rows[0];
    },
    async waitlistsForUser(userId: string) {
      const { rows } = await pool.query(
        "select surface, created_at from waitlist_signups where user_id = $1 order by created_at asc",
        [userId]
      );
      return rows;
    },

    // ────────────────────────── admin dashboard ───────────────────────────────
    // Persistent key/value settings (e.g. the killswitch). Best-effort: callers
    // wrap in try/catch so a missing `settings` table never breaks ad serving.
    async getSetting(key: string) {
      const { rows } = await pool.query("select value from settings where key = $1", [key]);
      return rows[0] ? rows[0].value : null;
    },
    async setSetting(key: string, value: any) {
      await pool.query(
        `insert into settings (key, value, updated_at) values ($1, ($2::jsonb #>> '{}')::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    },

    // Advertiser pricing knobs (admin-tunable, all in cents). Best-effort: a
    // missing `settings` table/row falls back to defaults so checkout never
    // breaks. minBid is floored at 50 (Stripe's USD minimum).
    async getPricing() {
      // Budget + CPM knobs (all cents). CPM == price_per_block_cents (1 block =
      // 1,000 impressions). Old *BidCents keys are read as fallbacks. minCpm is
      // floored at 50 (the Stripe/price_per_block_cents floor).
      const defaults = {
        minCpmCents: 500, suggestedCpmCents: 1500, maxCpmCents: 10000, topCpmAnchorCents: 5000,
        minBudgetCents: 10000, suggestedBudgetCents: 250000, maxBudgetCents: 10000000,
      };
      try {
        const { rows } = await pool.query("select value from settings where key = 'pricing'");
        const v = (rows[0] && rows[0].value) || {};
        const pick = (n: any, d: number) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : d);
        const minCpmCents = Math.max(50, pick(v.minCpmCents ?? v.minBidCents, defaults.minCpmCents));
        const maxCpmCents = Math.max(minCpmCents, pick(v.maxCpmCents, defaults.maxCpmCents));
        return {
          minCpmCents,
          suggestedCpmCents: Math.max(minCpmCents, pick(v.suggestedCpmCents ?? v.suggestedBidCents, defaults.suggestedCpmCents)),
          maxCpmCents,
          topCpmAnchorCents: Math.min(maxCpmCents, Math.max(0, pick(v.topCpmAnchorCents ?? v.topBidAnchorCents, defaults.topCpmAnchorCents))),
          minBudgetCents: Math.max(50, pick(v.minBudgetCents, defaults.minBudgetCents)),
          suggestedBudgetCents: pick(v.suggestedBudgetCents, defaults.suggestedBudgetCents),
          maxBudgetCents: Math.max(pick(v.minBudgetCents, defaults.minBudgetCents), pick(v.maxBudgetCents, defaults.maxBudgetCents)),
        };
      } catch { return defaults; }
    },
    async setPricing(next: any) {
      await pool.query(
        `insert into settings (key, value, updated_at) values ('pricing', ($1::jsonb #>> '{}')::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [JSON.stringify(next)]
      );
    },
    // Highest bid among currently-active campaigns (0 if none). Drives the
    // live-override half of the lander's "top bid".
    async topActiveBidCents() {
      try {
        const { rows } = await pool.query("select coalesce(max(price_per_block_cents),0)::int as top from campaigns where status = 'active'");
        return rows[0]?.top || 0;
      } catch { return 0; }
    },

    // KPI tiles + counts for the Overview tab. All money returned as raw
    // millicents (ledger) or cents (gift_redemptions); the edge route converts.
    async adminOverview() {
      const money = (await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type='campaign_credit'),0)::bigint as campaign_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='campaign_refund'),0)::bigint as campaign_refund,
           coalesce(sum(amount_millicents) filter (where entry_type='platform_fee'),0)::bigint as platform_fee,
           coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','points_credit')),0)::bigint as dev_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='referral_credit'),0)::bigint as referral_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='affiliate_credit'),0)::bigint as affiliate_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='payout_debit'),0)::bigint as payout_debit,
           coalesce(sum(amount_millicents) filter (where entry_type='gift_redemption_debit'),0)::bigint as redemption_debit,
           coalesce(sum(amount_millicents) filter (where entry_type in ('admin_credit','admin_debit')),0)::bigint as admin_adjust,
           coalesce(sum(amount_millicents) filter (where entry_type in
             ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit','admin_credit','admin_debit','payout_debit','gift_redemption_debit')),0)::bigint as liability
         from ledger`
      )).rows[0];
      // "Test money" = ledger activity tied to a campaign that was marked paid
      // without a real Stripe charge (stripe_payment_intent_id is null) — i.e. a
      // dev/seed-funded campaign, never actual advertiser revenue. Every dollar
      // figure above double-counts this unless a caller subtracts it out; keep
      // it as its own bucket so the dashboard can show real vs. test instead of
      // silently blending them (that blend is exactly how a $600 seed campaign
      // once read as real "ads purchased").
      const moneyTest = (await pool.query(
        `select
           coalesce(sum(amount_millicents) filter (where entry_type='campaign_credit'),0)::bigint as campaign_credit,
           coalesce(sum(amount_millicents) filter (where entry_type='platform_fee'),0)::bigint as platform_fee,
           coalesce(sum(amount_millicents) filter (where entry_type in
             ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit','admin_credit','admin_debit','payout_debit','gift_redemption_debit')),0)::bigint as liability
         from ledger
         where campaign_id in (select id from campaigns where paid_at is not null and stripe_payment_intent_id is null)`
      )).rows[0];
      const counts = (await pool.query(
        `select
           (select count(*) from users)::int as users,
           (select count(*) from users where email is not null)::int as users_with_email,
           (select count(*) from devices)::int as devices,
           (select count(*) from devices where last_seen_at >= now() - interval '1 day')::int as devices_active_1d,
           (select count(*) from advertisers)::int as advertisers,
           (select count(*) from campaigns)::int as campaigns,
           (select count(*) from campaigns where status='active')::int as campaigns_active,
           (select count(*) from campaigns where status='pending_review')::int as campaigns_pending,
           (select count(*) from gift_redemptions)::int as redemptions,
           (select count(*) from gift_redemptions where status='pending')::int as redemptions_pending,
           (select coalesce(sum(amount_cents),0) from gift_redemptions where status='pending')::bigint as redemptions_pending_cents,
           (select count(*) from referrals)::int as referrals,
           (select coalesce(sum(impressions),0) from event_batches)::bigint as impressions,
           (select coalesce(sum(clicks),0) from event_batches)::bigint as clicks`
      )).rows[0];
      const byStatus = (await pool.query(
        "select status, count(*)::int as n from campaigns group by status order by status"
      )).rows;
      const testCampaigns = (await pool.query(
        `select id, brand, budget_cents, status, paid_at from campaigns
          where paid_at is not null and stripe_payment_intent_id is null
          order by paid_at desc`
      )).rows;
      return { money, moneyTest, counts, campaignsByStatus: byStatus, testCampaigns };
    },

    // One bucket per UTC day, merged across tables in JS by the route.
    async adminDailyMetrics(days: number) {
      const d = Math.max(1, Math.min(365, days || 30));
      const events = (await pool.query(
        `select date_trunc('day', created_at) as d, sum(impressions)::bigint as imp, sum(clicks)::bigint as clk
           from event_batches where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const ledger = (await pool.query(
        `select date_trunc('day', created_at) as d,
                coalesce(sum(amount_millicents) filter (where entry_type='campaign_credit'),0)::bigint as bought,
                coalesce(sum(amount_millicents) filter (where entry_type='platform_fee'),0)::bigint as fee,
                coalesce(sum(amount_millicents) filter (where entry_type in ('impression_credit','click_credit','points_credit')),0)::bigint as dev
           from ledger where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const users = (await pool.query(
        `select date_trunc('day', created_at) as d, count(*)::int as n
           from users where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const devices = (await pool.query(
        `select date_trunc('day', created_at) as d, count(*)::int as n
           from devices where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      const redemptions = (await pool.query(
        `select date_trunc('day', created_at) as d, count(*)::int as n, coalesce(sum(amount_cents),0)::bigint as cents
           from gift_redemptions where created_at >= now() - ($1 || ' days')::interval group by 1`, [d]
      )).rows;
      return { days: d, events, ledger, users, devices, redemptions };
    },

    async adminCampaigns({ status, limit, offset }: any) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const filters: string[] = [];
      const params: any[] = [];
      if (status) { params.push(status); filters.push(`c.status = $${params.length}`); }
      const where = filters.length ? `where ${filters.join(" and ")}` : "";
      params.push(n); const lim = `$${params.length}`;
      params.push(off); const ofs = `$${params.length}`;
      const { rows } = await pool.query(
        `select c.id, c.brand, c.ad_line, c.url, c.category, c.status,
                c.price_per_block_cents, c.blocks, c.impressions_total, c.impressions_remaining,
                (c.impressions_total - c.impressions_remaining) as impressions_served,
                c.show_on_leaderboard, c.review_note, c.completion_email_sent_at, c.created_at, c.paid_at, c.activated_at,
                a.email as advertiser_email,
                coalesce((select sum(amount_millicents) from ledger
                          where campaign_id = c.id and entry_type in ('impression_credit','click_credit','platform_fee','points_credit','referral_points_credit','protocol_points_credit')),0)::bigint as recognized_millicents,
                coalesce((select count(*) from ledger
                          where campaign_id = c.id and entry_type in ('click_credit','click_event')),0)::int as clicks,
                coalesce((select sum((meta->>'billed')::int) from ledger
                          where campaign_id = c.id and entry_type in ('impression_credit','points_credit')),0)::bigint as impressions_shown
           from campaigns c left join advertisers a on a.id = c.advertiser_id
           ${where}
          order by c.created_at desc limit ${lim} offset ${ofs}`,
        params
      );
      return rows;
    },
    // One campaign's full data for the completion-receipt preview/send: advertiser
    // email + ad copy + status + the receipt guard + realized metrics. Null if unknown.
    async campaignReceiptData(campaignId: string) {
      if (!isUuid(campaignId)) return null;
      const { rows } = await pool.query(
        `select c.id, c.brand, c.ad_line, c.url, c.status,
                c.price_per_block_cents, c.blocks, c.budget_cents,
                c.impressions_total, c.impressions_remaining, c.completion_email_sent_at,
                c.created_at, c.activated_at,
                a.email as advertiser_email,
                coalesce((select sum(amount_millicents) from ledger
                          where campaign_id = c.id and entry_type in ('impression_credit','click_credit','platform_fee','points_credit','referral_points_credit','protocol_points_credit')),0)::bigint as recognized_millicents,
                coalesce((select count(*) from ledger
                          where campaign_id = c.id and entry_type in ('click_credit','click_event')),0)::int as clicks,
                coalesce((select sum((meta->>'billed')::int) from ledger
                          where campaign_id = c.id and entry_type in ('impression_credit','points_credit')),0)::bigint as impressions_shown
           from campaigns c left join advertisers a on a.id = c.advertiser_id
          where c.id = $1`,
        [campaignId]
      );
      return rows[0] || null;
    },
    // Atomically claim the one-time completion receipt (stamps only if exhausted and
    // unstamped). { sentAt } on the winning claim, null otherwise — so no double-send.
    async claimCampaignReceipt(campaignId: string) {
      if (!isUuid(campaignId)) return null;
      const { rows } = await pool.query(
        `update campaigns set completion_email_sent_at = now()
          where id = $1 and status = 'exhausted' and completion_email_sent_at is null
          returning completion_email_sent_at`,
        [campaignId]
      );
      return rows[0] ? { sentAt: rows[0].completion_email_sent_at } : null;
    },
    async clearCampaignReceipt(campaignId: string) {
      if (!isUuid(campaignId)) return;
      await pool.query("update campaigns set completion_email_sent_at = null where id = $1", [campaignId]);
    },
    // Per-advertiser rollup: one row per advertiser, aggregating realized metrics
    // across all of their campaigns.
    async adminAdvertisers({ limit, offset }: any = {}) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const { rows } = await pool.query(
        `select a.id, a.email, a.created_at,
                count(distinct c.id)::int as campaigns,
                count(distinct c.id) filter (where c.status = 'active')::int as active_campaigns,
                coalesce(sum(l.amount_millicents) filter (where l.entry_type in ('impression_credit','click_credit','platform_fee','points_credit','referral_points_credit','protocol_points_credit')),0)::bigint as spend_millicents,
                coalesce(sum((l.meta->>'billed')::int) filter (where l.entry_type in ('impression_credit','points_credit')),0)::bigint as impressions_shown,
                count(*) filter (where l.entry_type in ('click_credit','click_event'))::int as clicks
           from advertisers a
           left join campaigns c on c.advertiser_id = a.id
           left join ledger l on l.campaign_id = c.id
          group by a.id, a.email, a.created_at
          order by spend_millicents desc, a.created_at desc
          limit $1 offset $2`,
        [n, off]
      );
      return rows;
    },
    // Exhausted campaigns awaiting their one-time completion receipt — the sweep's
    // work list, oldest-finished first.
    async pendingReceiptCampaignIds(limit = 100) {
      const n = Math.max(1, Math.min(500, parseInt(String(limit), 10) || 100));
      const { rows } = await pool.query(
        `select id from campaigns
          where status = 'exhausted' and completion_email_sent_at is null
          order by activated_at nulls last, created_at limit $1`,
        [n]
      );
      return rows.map((r: any) => r.id);
    },
    async cancelCampaign(campaignId: string) {
      if (!isUuid(campaignId)) return false;
      const { rows } = await pool.query(
        `update campaigns set status='cancelled'
          where id=$1 and status in ('active','pending_review','pending_payment') returning id`,
        [campaignId]
      );
      return !!rows[0];
    },
    // Stripe Checkout Sessions we create expire after 24h (we don't set a custom
    // expires_at), so a campaign still sitting in pending_payment past that point
    // had its checkout abandoned — no webhook ever fired, so no money was ever
    // captured (no campaign_credit ledger row exists for it). Safe to auto-cancel.
    // Run lazily whenever the admin campaign list loads, so no cron is needed.
    async expireStalePendingPayments(hours = 24) {
      const { rows } = await pool.query(
        `update campaigns set status='cancelled',
                review_note = coalesce(review_note, 'Auto-cancelled: checkout not completed within ' || $1 || 'h')
          where status='pending_payment' and created_at < now() - ($1 || ' hours')::interval
          returning id`,
        [hours]
      );
      return rows.length;
    },

    async adminRedemptions({ status, limit }: any) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
      const params: any[] = [];
      let where = "";
      if (status) { params.push(status); where = `where g.status = $${params.length}`; }
      params.push(n);
      const { rows } = await pool.query(
        `select g.id, g.plan, g.months, g.amount_cents, g.recipient_email, g.status, g.created_at,
                g.user_id, g.device_id, u.email as user_email
           from gift_redemptions g left join users u on u.id = g.user_id
           ${where}
          order by g.created_at desc limit $${params.length}`,
        params
      );
      return rows;
    },
    // Set a redemption's status. When cancelling with refund=true, restore the
    // user's/device's balance via an admin_credit equal to the original debit.
    async setRedemptionStatus(id: string, status: string, refund: boolean) {
      if (!isUuid(id)) return null;
      if (!["pending", "fulfilled", "cancelled"].includes(status)) return null;
      return tx(async (c: any) => {
        const { rows } = await c.query(
          "update gift_redemptions set status=$2 where id=$1 returning user_id, device_id, amount_cents, status, recipient_email",
          [id, status]
        );
        if (!rows[0]) return null;
        let refunded = false;
        if (status === "cancelled" && refund) {
          const mc = (BigInt(rows[0].amount_cents) * 1000n).toString();
          await c.query(
            `insert into ledger (entry_type, amount_millicents, user_id, device_id, meta)
             values ('admin_credit', $1, $2, $3, ($4::jsonb #>> '{}')::jsonb)`,
            [mc, rows[0].user_id || null, rows[0].device_id || null, JSON.stringify({ reason: "redemption_cancelled", redemptionId: id })]
          );
          refunded = true;
        }
        return { ...rows[0], refunded };
      });
    },

    async adminUsers({ search, limit, offset }: any) {
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const params: any[] = [];
      let where = "";
      if (search) { params.push(`%${search}%`); where = `where u.email ilike $${params.length}`; }
      params.push(n); const lim = `$${params.length}`;
      params.push(off); const ofs = `$${params.length}`;
      const { rows } = await pool.query(
        `select u.id, u.email, u.email_verified, u.payouts_enabled, u.stripe_account_id,
                u.referral_code, u.referred_by, u.created_at,
                (select count(*) from devices d where d.user_id = u.id)::int as devices,
                coalesce((select sum(amount_millicents) from ledger l
                          where l.user_id = u.id or l.device_id in (select id from devices where user_id = u.id)),0)::bigint as balance_millicents,
                coalesce((select sum(amount_millicents) from ledger l
                          where (l.user_id = u.id or l.device_id in (select id from devices where user_id = u.id))
                            and l.entry_type in ('impression_credit','click_credit','referral_credit','affiliate_credit','points_credit','referral_points_credit')),0)::bigint as earned_millicents
           from users u ${where}
          order by u.created_at desc limit ${lim} offset ${ofs}`,
        params
      );
      return rows;
    },

    async adminEmails() {
      const { rows } = await pool.query(
        `select email, source, created_at from (
           select email, 'user' as source, created_at from users where email is not null
           union all
           select email, 'advertiser' as source, created_at from advertisers where email is not null
           union all
           select recipient_email as email, 'redemption_recipient' as source, created_at from gift_redemptions where recipient_email is not null
         ) e order by created_at desc`
      );
      return rows;
    },

    async adminIncome() {
      const byType = (await pool.query(
        "select entry_type, count(*)::int as n, coalesce(sum(amount_millicents),0)::bigint as total from ledger group by entry_type order by entry_type"
      )).rows;
      return byType;
    },

    async adminPayoutsList() {
      const { rows } = await pool.query(
        `select p.id, p.user_id, p.amount_cents, p.status, p.stripe_transfer_id, p.created_at, u.email
           from payouts p left join users u on u.id = p.user_id
          order by p.created_at desc limit 200`
      );
      return rows;
    },

    async adminReferrals() {
      const byStatus = (await pool.query(
        "select status, count(*)::int as n, coalesce(sum(reward_millicents),0)::bigint as reward from referrals group by status order by status"
      )).rows;
      const top = (await pool.query(
        `select r.referrer_user_id, u.email, count(*)::int as referred,
                count(*) filter (where r.status='rewarded')::int as rewarded,
                coalesce(sum(r.reward_millicents),0)::bigint as reward_millicents
           from referrals r left join users u on u.id = r.referrer_user_id
          group by r.referrer_user_id, u.email order by referred desc limit 50`
      )).rows;
      return { byStatus, top };
    },

    async adminDevices(dailyImpCap: number, dailyClickCap: number) {
      const totals = (await pool.query(
        `select count(*)::int as total,
                count(*) filter (where last_seen_at >= now()-interval '1 day')::int as active_1d,
                count(*) filter (where last_seen_at >= now()-interval '7 days')::int as active_7d,
                count(*) filter (where user_id is not null)::int as linked
           from devices`
      )).rows[0];
      const heavyDevices = (await pool.query(
        `select device_id, sum(impressions)::bigint as imp, sum(clicks)::bigint as clk
           from event_batches where created_at >= date_trunc('day', now())
          group by device_id having sum(impressions) >= $1 or sum(clicks) >= $2
          order by imp desc limit 50`, [dailyImpCap, dailyClickCap]
      )).rows;
      const heavyIps = (await pool.query(
        `select ip_hash, count(distinct device_id)::int as devices, sum(impressions)::bigint as imp
           from event_batches where created_at >= date_trunc('day', now()) and ip_hash is not null
          group by ip_hash having sum(impressions) >= $1 order by imp desc limit 50`, [dailyImpCap]
      )).rows;
      return { totals, heavyDevices, heavyIps };
    },

    // Live schema introspection: every public table with its columns + exact
    // row count. Powers the Schema tab.
    async adminSchema() {
      const cols = (await pool.query(
        `select table_name, column_name, data_type, is_nullable, ordinal_position
           from information_schema.columns where table_schema='public'
          order by table_name, ordinal_position`
      )).rows;
      const tbls = (await pool.query(
        "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name"
      )).rows;
      const out: any[] = [];
      for (const t of tbls) {
        const name = t.table_name;
        if (!/^[a-z_][a-z0-9_]*$/i.test(name)) continue; // guard the interpolated identifier
        let count: number | null = null;
        try { count = Number((await pool.query(`select count(*)::bigint as n from "${name}"`)).rows[0].n); } catch { count = null; }
        out.push({
          table: name,
          rowCount: count,
          columns: cols.filter((c: any) => c.table_name === name)
            .map((c: any) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES" })),
        });
      }
      return out;
    },

    async adminLedgerAdjust({ userId, deviceId, amountCents, direction, note }: any) {
      const cents = Math.abs(parseInt(amountCents, 10) || 0);
      if (!cents) return null;
      if (userId && !isUuid(userId)) return null;
      if (deviceId && !isUuid(deviceId)) return null;
      if (!userId && !deviceId) return null;
      const isCredit = direction !== "debit";
      const entryType = isCredit ? "admin_credit" : "admin_debit";
      const mc = (BigInt(cents) * 1000n) * (isCredit ? 1n : -1n);
      const { rows } = await pool.query(
        `insert into ledger (entry_type, amount_millicents, user_id, device_id, meta)
         values ($1, $2, $3, $4, ($5::jsonb #>> '{}')::jsonb) returning id`,
        [entryType, mc.toString(), userId || null, deviceId || null, JSON.stringify({ note: note || null, source: "admin" })]
      );
      return rows[0]?.id || null;
    },

    // Referral invites funnel: emails a referrer invited, and how far each got
    // (sent -> joined -> rewarded).
    async adminInvites(limit = 200) {
      const byStatus = (await pool.query(
        "select status, count(*)::int as n from referral_invites group by status order by status"
      )).rows;
      const recent = (await pool.query(
        `select i.email, i.status, i.code, i.created_at, i.sent_at, i.joined_at, i.rewarded_at,
                u.email as referrer_email
           from referral_invites i left join users u on u.id = i.referrer_user_id
          order by i.created_at desc limit $1`,
        [Math.max(1, Math.min(500, limit))]
      )).rows;
      return { byStatus, recent };
    },

    // Waitlist demand per surface + recent signups (who's waiting for what).
    async adminWaitlist(limit = 200) {
      const bySurface = (await pool.query(
        `select s.surface, s.label, count(w.id)::int as n
           from waitlist_surfaces s left join waitlist_signups w on w.surface = s.surface
          group by s.surface, s.label, s.sort_order order by s.sort_order asc, s.surface asc`
      )).rows;
      const recent = (await pool.query(
        `select w.surface, w.created_at, u.email
           from waitlist_signups w left join users u on u.id = w.user_id
          order by w.created_at desc limit $1`,
        [Math.max(1, Math.min(500, limit))]
      )).rows;
      return { bySurface, recent };
    },

    // Most recent runtime errors captured by the dispatch handler.
    async adminErrors(limit = 100) {
      const { rows } = await pool.query(
        "select id, method, path, message, created_at from diag_errors order by created_at desc limit $1",
        [Math.max(1, Math.min(500, limit))]
      );
      return rows;
    },
  };
}
const repo = createRepo(pool);

// ───────────────────────────── payouts.js ──────────────────────────────────
// Admin-only sweep. The protocol keeps payoutFeeBps of the gross — the user's
// balance is debited in full and the net is transferred. The portal's
// on-demand path (/v1/web/payouts/request) is the user-facing route; this
// sweep would drain balances people may be holding for the $DWELL claim, so
// never cron it without a deliberate call.
async function runPayouts() {
  const users = await repo.payableUsers(config.payoutThresholdCents * 1000);
  const results: any[] = [];
  for (const user of users) {
    const grossCents = Math.floor(user.balance / 1000);
    if (grossCents < config.payoutThresholdCents) continue;
    const feeCents = Math.ceil((grossCents * config.payoutFeeBps) / 10000);
    const netCents = grossCents - feeCents;
    if (netCents <= 0) continue;
    try {
      const transfer = await stripe.createTransfer({
        amount: netCents, currency: "usd", destination: user.stripe_account_id,
        transfer_group: `payout_${user.id}_${crypto.randomUUID()}`,
      });
      await repo.recordPayout(user.id, grossCents, netCents, feeCents, transfer.id);
      results.push({ userId: user.id, grossCents, netCents, feeCents, transferId: transfer.id, ok: true });
    } catch (err: any) {
      results.push({ userId: user.id, grossCents, netCents, feeCents, ok: false, error: err.message });
    }
  }
  return { paid: results.filter((r) => r.ok).length, results };
}

// Server-side X (Twitter) verification of a user's onboarding post — admin
// payout review only, never called from an earner path or shown in the portal.
function onboardingPostMatches(t: any) {
  const text = String(t?.text || "");
  if (/dwellprotocol\.com/i.test(text) || /@dwellprotocol/i.test(text)) return true;
  const urls = (t && t.entities && t.entities.urls) || [];
  return urls.some((u: any) => /dwellprotocol\.com/i.test((u && (u.expanded_url || u.url)) || ""));
}
async function verifyOnboardingPost(u: any) {
  if (!u.twitter_id) return { status: "no_x_account" };
  if (!config.twitterBearerToken) return { status: "unconfigured" };
  try {
    const url = `https://api.twitter.com/2/users/${encodeURIComponent(u.twitter_id)}/tweets` +
      `?max_results=100&exclude=retweets,replies&tweet.fields=entities`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${config.twitterBearerToken}` } });
    const data = await r.json();
    const tweets = Array.isArray(data && data.data) ? data.data : [];
    const hit = tweets.find((t: any) => onboardingPostMatches(t));
    if (hit) {
      const postUrl = `https://x.com/i/status/${hit.id}`;
      await repo.saveOnboardingPostVerification(u.id, { url: postUrl });
      return { status: "verified", url: postUrl };
    }
    await repo.saveOnboardingPostVerification(u.id, { url: null });
    return { status: "not_found" };
  } catch (err: any) {
    console.error("[dwell] onboarding post verify:", err?.message);
    return { status: "error", error: err?.message };
  }
}
function onboardingPostStatus(u: any) {
  if (u.onboarding_post_verified_at) return "verified";
  if (!u.twitter_id) return "no_x_account";
  if (u.onboarding_post_checked_at) return "not_found";
  return "unchecked";
}
function payoutRequestView(r: any) {
  return {
    payoutId: r.id, userId: r.user_id, email: r.email,
    twitterId: r.twitter_id || null,
    twitterUsername: r.twitter_username || null,
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

// ─────────────────────────── http plumbing ─────────────────────────────────
// Ad-serving killswitch. Seeded from the KILLSWITCH env on cold start, then
// kept in sync with the persisted `settings.serving` flag so a toggle from the
// admin dashboard propagates across isolates. syncServing() refreshes at most
// once per 15s to keep the /v1/ads hot path cheap.
let serving = !config.killswitch;
// Master earnings killswitch — separate from (and stronger than) `serving`.
// `serving` only stops *new* ads from being shown/tokenized; the legacy
// /v1/events batch path and an already-served impression token can still
// mint points while `serving` is off. `earningsEnabled` additionally blocks
// the actual crediting in ingestBatch/redeemImpression, so flipping it off
// stops every way a viewer can earn points, immediately.
let earningsEnabled = true;
// Whether the public "Live bid market" leaderboard is shown on the lander.
// Off by default; flipped from the admin dashboard and surfaced via /v1/config.
let leaderboardPublic = false;
// Whether the advertiser CPM slider's "top bid" ghost marker tracks the live
// marketplace top. Off by default (the lander hardcodes the ghost to $50).
let liveTopCpm = false;
// Whether the portal shows the "Not serving ads until after launch." banner.
// Off by default; flipped from the admin dashboard and surfaced via /v1/config.
let adNoticeVisible = false;
// Whether clients show the non-billable house/default ad ("$empty — promote your
// token now") when the auction is empty. ON by default; flipped from the admin
// dashboard and surfaced via /v1/config so every client can gate the filler.
let houseAdEnabled = true;
let servingSyncedAt = 0;
async function syncServing() {
  if (Date.now() - servingSyncedAt < 15000) return;
  servingSyncedAt = Date.now();
  try {
    const v = await repo.getSetting("serving");
    if (typeof v === "boolean") serving = v;
  } catch { /* settings table absent / unreachable — keep current value */ }
  try {
    const v = await repo.getSetting("earnings_enabled");
    if (typeof v === "boolean") earningsEnabled = v;
  } catch { /* settings absent — keep current value (default: on) */ }
  try {
    leaderboardPublic = (await repo.getSetting("leaderboard_public")) === true;
  } catch { /* settings absent — keep default (hidden) */ }
  try {
    liveTopCpm = (await repo.getSetting("live_top_cpm")) === true;
  } catch { /* settings absent — keep default (off) */ }
  try {
    adNoticeVisible = (await repo.getSetting("ad_notice_visible")) === true;
  } catch { /* settings absent — keep default (hidden) */ }
  try {
    // Default ON: only an explicit `false` disables the house ad.
    houseAdEnabled = (await repo.getSetting("house_ad_enabled")) !== false;
  } catch { /* settings absent — keep default (on) */ }
}
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key,X-Device-Id,X-Device-Key,Authorization,apikey",
  "Access-Control-Max-Age": "86400",
};
// Allowed browser origins. Reflect the caller's Origin when it's on our
// allowlist (apex + www variants of SITE_URL, plus any CORS_ORIGIN entries) so
// both https://dwellprotocol.com and https://www.dwellprotocol.com pass preflight.
const ALLOWED_ORIGINS: Set<string> = (() => {
  const set = new Set<string>();
  const add = (o: string) => { const v = (o || "").trim().replace(/\/+$/, ""); if (v) set.add(v); };
  (env("CORS_ORIGIN") || config.siteUrl || "").split(",").forEach(add);
  try {
    const u = new URL(config.siteUrl);
    const host = u.host.replace(/^www\./, "");
    add(`${u.protocol}//${host}`);
    add(`${u.protocol}//www.${host}`);
  } catch { /* siteUrl not a URL — skip variants */ }
  return set;
})();
function resolveOrigin(req: Request): string {
  const o = (req.headers.get("Origin") || "").replace(/\/+$/, "");
  return ALLOWED_ORIGINS.has(o) ? o : (config.corsOrigin || "*");
}
const json = (status: number, body: any) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const redirect = (url: string) => new Response(null, { status: 302, headers: { ...CORS, Location: url } });
const htmlResp = (status: number, body: string) =>
  new Response(body, { status, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });

// route table (mirrors app.js)
const exact = new Map<string, any>();
const paramRoutes: any[] = [];
function route(method: string, path: string, handler: any) {
  if (path.includes(":")) {
    const keys: string[] = [];
    const regex = new RegExp("^" + path.replace(/:([A-Za-z0-9_]+)/g, (_: any, k: string) => { keys.push(k); return "([^/]+)"; }) + "$");
    paramRoutes.push({ method, regex, keys, handler });
  } else {
    exact.set(`${method} ${path}`, handler);
  }
}

// ctx: { headers, body, rawBody, query, params }
async function authDeviceFrom(ctx: any, fromQuery = false) {
  // Prefer the deviceKey in a header, so clients can keep the bearer secret out
  // of the URL query string (which leaks into access/proxy logs). Falls back to
  // body/query for older clients.
  const hId = ctx.headers.get("x-device-id");
  const hKey = ctx.headers.get("x-device-key");
  const src = fromQuery ? null : ctx.body;
  const deviceId = hId || src?.deviceId || ctx.query.get("deviceId");
  const deviceKey = hKey || src?.deviceKey || ctx.query.get("deviceKey");
  return repo.authDevice(deviceId, deviceKey);
}
// Constant-time compare so the admin key can't be recovered byte-by-byte via
// response-timing. Length-guarded because timingSafeEqual throws on a mismatch.
function safeEqual(a: string, b: string) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}
function adminOk(ctx: any) {
  const key = ctx.headers.get("x-admin-key") || ctx.body?.adminKey || ctx.query.get("adminKey");
  return !!config.adminKey && !!key && safeEqual(key, config.adminKey);
}
function sessionFrom(ctx: any) {
  const h = ctx.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
  return bearer || ctx.body?.session || ctx.query.get("session") || null;
}
// Client IP from the proxy header. Used — hashed, never stored raw — for the
// per-IP fraud cap.
function clientIp(ctx: any) {
  return (ctx.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "";
}
function hashIp(ctx: any) {
  const ip = clientIp(ctx);
  return ip ? crypto.createHmac("sha256", config.adminKey || "ip-salt").update(ip).digest("hex") : null;
}
// Validate + normalize an affiliate application's socials. At least one handle is
// required, and every handle provided must carry a non-negative follower count.
function parseAffiliateSocials(body: any): { socials?: any; error?: string } {
  const b = body || {};
  const handle = (v: any) => {
    const s = String(v ?? "").trim().replace(/^@+/, "").slice(0, 60);
    return s || null;
  };
  const platforms: [string, string, string][] = [
    ["instagram", "instagramFollowers", "Instagram"],
    ["linkedin", "linkedinFollowers", "LinkedIn"],
    ["twitter", "twitterFollowers", "Twitter"],
  ];
  const socials: any = {};
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

// ── health & catalog ──
route("GET", "/healthz", async () => json(200, { ok: true }));
// Expose the Solana mints only once $DWELL launches (DWELL_MINT set) — the static
// lander needs them to prefill the Jupiter "Buy $DWELL" swap (USDC → $DWELL). Both
// are public on-chain addresses; no secret leaves here.
route("GET", "/v1/config", async () => { await syncServing(); return json(200, { serving, revenueShare: displayRevenueShare, leaderboardPublic, liveTopCpm, adNoticeVisible, houseAdEnabled, ...(config.tokenMode ? { tokenMode: config.tokenMode } : {}), ...(config.dwellMint ? { dwellMint: config.dwellMint, usdcMint: config.usdcMint } : {}) }); });

// Advertiser pricing for the lander (min / suggested / top). Kept off /v1/config
// so the extension's frequent config polls stay query-free. top = max(anchor,
// highest active bid).
route("GET", "/v1/pricing", async () => {
  const p = await repo.getPricing();
  const topCpmCents = Math.min(p.maxCpmCents, Math.max(p.topCpmAnchorCents, await repo.topActiveBidCents()));
  return json(200, {
    minCpmCents: p.minCpmCents, suggestedCpmCents: p.suggestedCpmCents, maxCpmCents: p.maxCpmCents, topCpmCents,
    minBudgetCents: p.minBudgetCents, suggestedBudgetCents: p.suggestedBudgetCents, maxBudgetCents: p.maxBudgetCents,
    // Transitional aliases so a cached/older frontend keeps working for one release.
    minBidCents: p.minCpmCents, suggestedBidCents: p.suggestedCpmCents, topBidCents: topCpmCents,
  });
});
route("GET", "/v1/ads", async () => {
  await syncServing();
  const ads = (serving && earningsEnabled) ? await repo.activeAds() : [];
  return json(200, { revenueShare: displayRevenueShare, ads: ads.map((a: any) => ({ id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined, change: resolveChangePct(a.changes, a.change_timescale) ?? undefined })) });
});
route("GET", "/v1/leaderboard", async () => {
  const rows = await repo.leaderboard();
  return json(200, { leaderboard: rows.map((r: any, i: number) => ({ rank: i + 1, brand: r.brand, line: r.ad_line, change: resolveChangePct(r.changes, r.change_timescale) ?? undefined })) });
});

// ── devices & events ──
route("POST", "/v1/devices/register", async () => json(200, await repo.registerDevice()));
// Self-serve device→account link: the extension's dwellprotocol.com bridge posts the
// device creds + the site's web session; we attach the device to that user and
// enroll them as an affiliate so the popup's crew lights up. No magic link.
route("POST", "/v1/devices/link", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) { console.warn("[devices/link] rejected: bad device credentials"); return json(401, { error: "bad device credentials" }); }
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) { console.warn(`[devices/link] rejected: device ${device.id} not signed in`); return json(401, { error: "not signed in" }); }
  await repo.linkDeviceToUser(device.id, user.id);
  await repo.getOrCreateAffiliate(user.id);
  console.log(`[devices/link] linked device ${device.id} -> user ${user.id}`);
  return json(200, { ok: true });
});
route("POST", "/v1/events", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const body = ctx.body || {};
  // A client on the server-authoritative impression-token path must NOT also
  // post self-reported batches (that would double-credit the same views). It
  // advertises the capability, so we refuse its legacy batches outright.
  if (Array.isArray(body.capabilities) && body.capabilities.includes("impression_tokens")) {
    return json(409, { error: "migrated client must use /v1/impressions/serve+redeem" });
  }
  if (!body.batchKey || !Array.isArray(body.events)) return json(400, { error: "batchKey and events[] required" });
  await syncServing();
  if (!earningsEnabled) return json(200, { ok: true, duplicate: false, creditedMillicents: 0, earningsDisabled: true });
  try {
    const result = await repo.ingestBatch({
      deviceId: device.id, batchKey: body.batchKey, events: body.events,
      // Which product reported this batch (chrome / claude_code / desktop), so a
      // credit can be attributed back to its surface; ignored unless allow-listed.
      source: ["chrome", "claude_code", "desktop"].includes(body.source) ? body.source : null,
      revenueShare: config.revenueShare, dailyCap: config.dailyImpressionCap,
      ipHash: hashIp(ctx), ipDailyCap: config.ipDailyImpressionCap,
      tokenSplit, credit: config.legacyEventsCredit,
    });
    return json(200, { ok: true, ...result });
  } catch (err: any) {
    if (err.code === "CAP_EXCEEDED") return json(429, { error: "daily impression cap exceeded" });
    throw err;
  }
});

// ── server-side clicks ──
route("POST", "/v1/clicks/intent", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  if (!ctx.body?.campaignId) return json(400, { error: "campaignId required" });
  const token = await repo.createClickToken(ctx.body.campaignId, device.id, config.clickTokenTtlMs);
  if (!token) return json(404, { error: "campaign not active" });
  return json(200, { trackingUrl: `${config.apiBaseUrl}/v1/go/${token}` });
});
route("GET", "/v1/go/:token", async (ctx: any) => {
  const result = await repo.redeemClickToken(ctx.params.token, config.dailyClickCap);
  return redirect(result?.url || config.siteUrl);
});

// ── server-authoritative impressions ──
// serve: the server picks the auction winner and mints a single-use token for
// THIS device; redeem: after the qualifying dwell, bill that impression once.
// Forged/inflated counts are impossible — every billed impression maps to a
// server serve. Runs alongside /v1/events until every client has migrated.
route("POST", "/v1/impressions/serve", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  await syncServing();
  if (!serving || !earningsEnabled) return json(200, { ad: null, serving: false });
  const result = await repo.serveImpression({
    deviceId: device.id, ipHash: hashIp(ctx), ttlMs: config.impressionTokenTtlMs,
    dailyCap: config.dailyImpressionCap, ipDailyCap: config.ipDailyImpressionCap,
  });
  if (result.capped) return json(200, { ad: null, capped: true });
  if (!result.ad) return json(200, { ad: null });
  const a = result.ad;
  return json(200, {
    token: result.token,
    ad: { id: a.id, brand: a.brand, line: a.ad_line, url: a.url, cat: a.category, color: a.color || undefined, change: resolveChangePct(a.changes, a.change_timescale) ?? undefined },
    revenueShare: displayRevenueShare,
  });
});
route("POST", "/v1/impressions/redeem", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  if (!ctx.body?.token) return json(400, { error: "token required" });
  await syncServing();
  if (!earningsEnabled) return json(503, { ok: false, reason: "earnings_disabled" });
  const result = await repo.redeemImpression({
    token: ctx.body.token, deviceId: device.id, revenueShare: config.revenueShare,
    minDwellMs: config.impressionMinDwellMs,
    source: ["chrome", "claude_code", "desktop"].includes(ctx.body.source) ? ctx.body.source : null,
    tokenSplit,
  });
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409; // used / expired / too_soon
    return json(status, { ok: false, reason: result.reason });
  }
  return json(200, { ok: true, creditedMillicents: result.creditedMillicents });
});

// ── DWELL token mode (dwell/docs/04 §D) ──
// Every route here 404s when TOKEN_MODE is unset, so the DWELL deployment
// exposes no token surface at all. Wallet linking and claims are live-mode
// only; in points mode they answer 409 so clients can show "at launch".
// Mirrors server/src/app.js.
const tokenModeOff = () => json(404, { error: "not found" });
const liveOnly = () =>
  config.tokenMode === "live"
    ? json(501, { error: "not implemented — ships with the TGE tooling" })
    : json(409, { error: "live mode only — points phase is accrual-only" });

// Public reserve attestation: escrowed USDC vs. outstanding points.
route("GET", "/v1/reserve", async () => {
  if (!config.tokenMode) return tokenModeOff();
  const r = await repo.reserveStatus();
  return json(200, { mode: config.tokenMode, ...r, updatedAt: new Date().toISOString() });
});

// Public: funded campaign pools + locked rates (live mode fills this via the
// indexer; empty during the points phase).
route("GET", "/v1/token/pools", async (ctx: any) => {
  if (!config.tokenMode) return tokenModeOff();
  return json(200, { pools: await repo.tokenCampaignPools(ctx.query.get("limit")) });
});

// Points balance for the signed-in user — the portal balance card. The
// millicent balance IS the points number (1,000 points = $1.00).
route("GET", "/v1/web/points/summary", async (ctx: any) => {
  if (!config.tokenMode) return tokenModeOff();
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const e = await repo.earningsForUser(user.id);
  return json(200, {
    mode: config.tokenMode,
    points: e.balanceMillicents,
    usdEquivalent: e.balanceMillicents / 100000,
    todayPoints: e.todayMillicents,
    monthPoints: e.monthMillicents,
    lifetimePoints: e.lifetimeMillicents,
  });
});

// Tokenomics v2: wallet linking is live in points mode — it's the payout
// destination for USDC redemptions, not a token-claim surface.
const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
route("POST", "/v1/web/wallet", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const address = String(ctx.body?.address || "").trim();
  if (!SOLANA_ADDR.test(address)) return json(400, { error: "address must be a Solana public key" });
  const result = await repo.linkWallet(user.id, address);
  if (!result.ok) return json(409, { error: "that wallet is already linked to another account" });
  return json(200, { ok: true, wallet: address });
});
// v2 retired the earner token claim: dwells never convert to $DWELL.
route("GET", "/v1/web/token/claim-proof", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  return json(410, { error: "dwells do not convert to $DWELL; redeem as USDC or Claude credits" });
});
route("POST", "/v1/admin/epochs/publish-root", async (ctx: any) => {
  if (!config.tokenMode) return tokenModeOff();
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return liveOnly();
});

// ── USDC advertiser checkout (dwell/docs/08) — mirrors server/src/solana.js + app.js ──
// Non-custodial pay-and-swap: the backend BUILDS unsigned transactions and
// VERIFIES finalized ones read-only; the advertiser's wallet is the only
// signer. One atomic transaction pays the 10% USDC fee to the treasury and
// market-buys DWELL via a Jupiter route straight to the distributor vault.
// The whole surface 404s until DWELL_MINT is configured (the launch gate).

const SOL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SOL_SYSTEM_PROGRAM = "11111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_DECIMALS = 6;
// Headroom the payer keeps for tx fees + wSOL rent when paying in SOL (~0.01 SOL).
const SOL_GAS_HEADROOM_LAMPORTS = 10_000_000n;
// B58_ALPHABET / B58_MAP are declared above loadConfig() — see the note there.
function base58Decode(s: string) {
  if (typeof s !== "string" || !s.length) throw new Error("bad base58");
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error("bad base58 char");
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function base58Encode(buf: Uint8Array) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}
function isPubkey(s: string) {
  try { return base58Decode(s).length === 32; } catch { return false; }
}
// Fresh throwaway reference key (Solana Pay): appended read-only so the
// payment is findable by getSignaturesForAddress; never signs, never holds.
function newReferencePubkey() {
  return base58Encode(crypto.randomBytes(32));
}
// Solana "compact-u16" (shortvec) length prefix.
function compactU16(n: number) {
  const out: number[] = [];
  let rem = n;
  for (;;) {
    const byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) { out.push(byte); break; }
    out.push(byte | 0x80);
  }
  return Buffer.from(out);
}
function u64le(v: any) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
// Compile instructions into a LEGACY message + serialize an unsigned
// transaction (signature slots zeroed; the wallet fills them).
function serializeUnsignedTransaction({ feePayer, recentBlockhash, instructions }: any) {
  const metas = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  const touch = (pubkey: string, isSigner: boolean, isWritable: boolean) => {
    const m = metas.get(pubkey) || { isSigner: false, isWritable: false };
    m.isSigner = m.isSigner || isSigner;
    m.isWritable = m.isWritable || isWritable;
    metas.set(pubkey, m);
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    touch(ix.programId, false, false);
    for (const a of ix.accounts) touch(a.pubkey, !!a.isSigner, !!a.isWritable);
  }
  const rank = (k: string, m: any) => {
    if (k === feePayer) return 0;
    if (m.isSigner && m.isWritable) return 1;
    if (m.isSigner) return 2;
    if (m.isWritable) return 3;
    return 4;
  };
  const keys = [...metas.entries()]
    .sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k);
  const index = new Map(keys.map((k, i) => [k, i]));
  // Every account key AND the blockhash must be exactly 32 bytes, or the
  // message is silently truncated and no wallet can parse it. A wrong program
  // constant is the classic cause — fail loud at build time instead. (Verified
  // against @solana/web3.js: correct keys serialize byte-identically.)
  for (const k of [...keys, recentBlockhash]) {
    if (base58Decode(k).length !== 32) throw new Error(`not a 32-byte Solana key: ${k}`);
  }
  let numSigners = 0, numReadonlySigned = 0, numReadonlyUnsigned = 0;
  for (const k of keys) {
    const m: any = metas.get(k);
    if (m.isSigner) { numSigners++; if (!m.isWritable) numReadonlySigned++; }
    else if (!m.isWritable) numReadonlyUnsigned++;
  }
  const parts = [
    Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]),
    compactU16(keys.length),
    ...keys.map((k) => base58Decode(k)),
    base58Decode(recentBlockhash),
    compactU16(instructions.length),
  ];
  for (const ix of instructions) {
    const data = Buffer.from(ix.data, "base64");
    parts.push(
      Buffer.from([index.get(ix.programId)!]),
      compactU16(ix.accounts.length),
      Buffer.from(ix.accounts.map((a: any) => index.get(a.pubkey)!)),
      compactU16(data.length),
      data
    );
  }
  const message = Buffer.concat(parts);
  const txBytes = Buffer.concat([compactU16(numSigners), Buffer.alloc(64 * numSigners), message]);
  return txBytes.toString("base64");
}
// SPL Token TransferChecked (ix 12): fee leg, USDC -> treasury vault. The
// Solana Pay reference key rides as an extra read-only account.
function transferCheckedInstruction({ source, mint, destination, owner, amount, decimals, reference }: any) {
  return {
    programId: SOL_TOKEN_PROGRAM,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      ...(reference ? [{ pubkey: reference, isSigner: false, isWritable: false }] : []),
    ],
    data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])]).toString("base64"),
  };
}
// System-program transfer (ix 2): the fee leg when paying in SOL — native
// lamports to the treasury. Same Solana Pay trick: the reference key rides as
// an extra read-only account (the system program ignores extras).
function systemTransferInstruction({ from, to, lamports, reference }: any) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return {
    programId: SOL_SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      ...(reference ? [{ pubkey: reference, isSigner: false, isWritable: false }] : []),
    ],
    data: data.toString("base64"),
  };
}
// SPL Token Transfer (ix 3): the fee/tranche legs on the $DWELL rail. Unlike
// TransferChecked it carries no mint/decimals, so it works for the DWELL mint
// without knowing its decimals. Accounts: source, destination, owner, [ref].
function tokenTransferInstruction({ source, destination, owner, amount, reference }: any) {
  return {
    programId: SOL_TOKEN_PROGRAM,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      ...(reference ? [{ pubkey: reference, isSigner: false, isWritable: false }] : []),
    ],
    data: Buffer.concat([Buffer.from([3]), u64le(amount)]).toString("base64"),
  };
}
function memoInstruction(text: string) {
  return { programId: SOL_MEMO_PROGRAM, accounts: [], data: Buffer.from(text, "utf8").toString("base64") };
}
// ── treasury signing (swap-on-accept / refund-on-reject only) ──
// The secret is a base58 64-byte ed25519 keypair (seed || pubkey), the format
// solana-keygen and every wallet exports. node:crypto signs ed25519 natively
// once the 32-byte seed is wrapped in a PKCS8 envelope — no new dependencies.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function signerPubkeyFromSecret(secret: string) {
  const raw = base58Decode(secret);
  if (raw.length !== 64) throw new Error("treasury signer secret must be a base58 64-byte ed25519 keypair");
  return base58Encode(raw.subarray(32));
}
function ed25519Sign(seed32: Uint8Array, message: Uint8Array) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, message, key);
}
// Read a compact-u16 (shortvec) length; returns [value, nextOffset].
function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
  let n = 0, shift = 0, o = offset;
  for (;;) {
    const b = buf[o++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [n, o];
}
// Sign a serialized legacy transaction whose fee payer is the treasury signer
// (our own refunds, and Jupiter /swap responses where userPublicKey is the
// signer). Fills the fee payer's signature slot; refuses anything whose fee
// payer isn't the signer, so a hostile transaction can't ride this key.
function signTransactionBase64(txBase64: string, signerSecret: string) {
  const buf = Buffer.from(txBase64, "base64");
  const raw = base58Decode(signerSecret);
  if (raw.length !== 64) throw new Error("treasury signer secret must be a base58 64-byte ed25519 keypair");
  const [numSigs, sigOffset] = readCompactU16(buf, 0);
  if (numSigs < 1) throw new Error("transaction has no signature slots");
  const message = buf.subarray(sigOffset + 64 * numSigs);
  let o = 3; // numSigners, numReadonlySigned, numReadonlyUnsigned
  let numKeys;
  [numKeys, o] = readCompactU16(message, o);
  if (numKeys < 1) throw new Error("transaction has no account keys");
  const feePayer = base58Encode(message.subarray(o, o + 32));
  const signerPub = base58Encode(raw.subarray(32));
  if (feePayer !== signerPub) throw new Error(`refusing to sign: fee payer ${feePayer} is not the treasury signer`);
  const sig = ed25519Sign(raw.subarray(0, 32), message);
  sig.copy(buf, sigOffset);
  return buf.toString("base64");
}
async function solanaRpc(method: string, params: any[]) {
  const res = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`solana rpc ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`solana rpc ${method}: ${body.error.message}`);
  return body.result;
}
// The payer's token account (for `mint`) with the largest balance — RPC lookup
// instead of ATA derivation keeps this free of PDA/curve math.
async function findTokenAccount(owner: string, mint: string) {
  const result = await solanaRpc("getTokenAccountsByOwner", [
    owner, { mint }, { encoding: "jsonParsed" },
  ]);
  const accounts = (result?.value || [])
    .map((a: any) => ({ pubkey: a.pubkey, amount: BigInt(a.account?.data?.parsed?.info?.tokenAmount?.amount || "0") }))
    .sort((a: any, b: any) => (a.amount > b.amount ? -1 : 1));
  return accounts[0] || null;
}
const findUsdcAccount = (owner: string) => findTokenAccount(owner, config.usdcMint);
async function jupiterQuote({ inputMint, outputMint, amount, slippageBps }: any) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps ?? config.maxSlippageBps),
    swapMode: "ExactIn",
    asLegacyTransaction: "true", // no ALTs -> the legacy encoder above suffices
  });
  const res = await fetch(`${config.jupiterBaseUrl}/quote?${q}`);
  if (!res.ok) throw new Error(`jupiter quote: HTTP ${res.status}`);
  const quote = await res.json();
  if (quote.error) throw new Error(`jupiter quote: ${quote.error}`);
  if (!quote.outAmount) throw new Error("jupiter quote: no route");
  return quote;
}
// How many lamports the order's USD price is worth right now, via a
// USDC -> wSOL spot PRICING quote (nothing is swapped). Re-run on every
// build — the wallet always sees a current number.
async function priceOrderInSol(priceMicroUsdc: string, feeBps: number) {
  const pricing = await jupiterQuote({ inputMint: config.usdcMint, outputMint: WSOL_MINT, amount: priceMicroUsdc });
  const total = BigInt(pricing.outAmount);
  const fee = (total * BigInt(feeBps)) / 10000n;
  return { totalLamports: total, feeLamports: fee, trancheLamports: total - fee, quote: pricing };
}
// How many raw $DWELL units the order's USD price is worth right now, via a
// USDC -> DWELL spot PRICING quote (docs/01 ▸ "priced at the USD campaign
// price via a spot quote at checkout"). Re-priced on every build like SOL.
async function priceOrderInDwell(priceMicroUsdc: string) {
  const pricing = await jupiterQuote({ inputMint: config.usdcMint, outputMint: config.dwellMint, amount: priceMicroUsdc });
  return { totalDwell: BigInt(pricing.outAmount), quote: pricing };
}
// One atomic unsigned transaction for an order (tokenomics v2 — plain
// transfers, checkout never swaps and no leg buys $DWELL):
//   usdc  — fee leg (USDC -> treasury, with the reference key) + revenue leg
//           (USDC -> revenue account) + order-id memo;
//   sol   — the same two legs as native lamport transfers;
//   dwell — ONE transfer of the full amount to the company treasury, where
//           it is held (docs/01 ▸ What the token does), + memo.
async function buildOrderTransaction({ order, payer }: any) {
  if (!isPubkey(payer)) throw Object.assign(new Error("payer must be a Solana pubkey"), { code: "BAD_ACCOUNT" });
  let instructions: any[];

  if (order.pay_currency === "dwell") {
    const dwellAccount = await findTokenAccount(payer, config.dwellMint);
    if (!dwellAccount) throw Object.assign(new Error("no $DWELL account for this wallet"), { code: "NO_FUNDS" });
    const need = BigInt(order.pay_total_units);
    if (dwellAccount.amount < need) {
      throw Object.assign(new Error(`insufficient $DWELL: need ${need}, have ${dwellAccount.amount}`), { code: "NO_FUNDS" });
    }
    instructions = [
      tokenTransferInstruction({
        source: dwellAccount.pubkey, destination: config.treasuryDwellAta, owner: payer,
        amount: need.toString(), reference: order.reference_pubkey,
      }),
      memoInstruction(`dwell-usdc-order:${order.id}`),
    ];
  } else if (order.pay_currency === "sol") {
    const bal = await solanaRpc("getBalance", [payer, { commitment: "finalized" }]);
    const lamports = BigInt(bal?.value ?? bal ?? 0);
    const need = BigInt(order.pay_total_units) + SOL_GAS_HEADROOM_LAMPORTS;
    if (lamports < need) {
      throw Object.assign(new Error(`insufficient SOL: need ${need} lamports (incl. gas headroom), have ${lamports}`), { code: "NO_FUNDS" });
    }
    const tranche = BigInt(order.pay_total_units) - BigInt(order.pay_fee_units);
    instructions = [
      systemTransferInstruction({
        from: payer, to: config.treasurySolAccount,
        lamports: order.pay_fee_units, reference: order.reference_pubkey,
      }),
      systemTransferInstruction({ from: payer, to: config.revenueSolAccount, lamports: tranche.toString() }),
      memoInstruction(`dwell-usdc-order:${order.id}`),
    ];
  } else {
    const usdcAccount = await findUsdcAccount(payer);
    if (!usdcAccount) throw Object.assign(new Error("no USDC account for this wallet"), { code: "NO_FUNDS" });
    const need = BigInt(order.price_micro_usdc);
    if (usdcAccount.amount < need) {
      throw Object.assign(new Error(`insufficient USDC: need ${need}, have ${usdcAccount.amount}`), { code: "NO_FUNDS" });
    }
    instructions = [
      transferCheckedInstruction({
        source: usdcAccount.pubkey, mint: config.usdcMint, destination: config.treasuryUsdcAta,
        owner: payer, amount: order.fee_micro_usdc, decimals: USDC_DECIMALS,
        reference: order.reference_pubkey,
      }),
      transferCheckedInstruction({
        source: usdcAccount.pubkey, mint: config.usdcMint, destination: config.revenueUsdcAta,
        owner: payer, amount: order.tranche_micro_usdc, decimals: USDC_DECIMALS,
      }),
      memoInstruction(`dwell-usdc-order:${order.id}`),
    ];
  }

  const bh = await solanaRpc("getLatestBlockhash", [{ commitment: "finalized" }]);
  const value = bh.value || bh;
  return serializeUnsignedTransaction({ feePayer: payer, recentBlockhash: value.blockhash, instructions });
}
// Signatures that touched the order's reference key (Solana Pay findReference).
async function findReferenceSignatures(referencePubkey: string) {
  const result = await solanaRpc("getSignaturesForAddress", [referencePubkey, { limit: 5 }]);
  return (result || []).map((r: any) => r.signature);
}
// Read-only verification of a finalized transaction against the order
// (tokenomics v2 — both legs are plain transfers). Amount deltas come from the
// runtime's own pre/post balances — never from anything the client claims.
async function verifyOrderTransaction({ signature, order }: any) {
  const txr = await solanaRpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ]);
  if (!txr) return { ok: false, reason: "not_found" };
  if (txr.meta?.err) return { ok: false, reason: "tx_failed" };
  const keys = (txr.transaction?.message?.accountKeys || []).map((k: any) => (typeof k === "string" ? k : k.pubkey));
  if (!keys.includes(order.reference_pubkey)) return { ok: false, reason: "reference_missing" };
  const tokenDelta = (account: string, mint: string) => {
    const find = (list: any[]) => (list || []).find((b: any) => keys[b.accountIndex] === account && b.mint === mint);
    const pre = find(txr.meta?.preTokenBalances);
    const post = find(txr.meta?.postTokenBalances);
    if (!post && !pre) return null; // account untouched by this tx
    return BigInt(post?.uiTokenAmount?.amount || "0") - BigInt(pre?.uiTokenAmount?.amount || "0");
  };
  const nativeDelta = (account: string) => {
    const idx = keys.indexOf(account);
    if (idx < 0) return null;
    return BigInt(txr.meta?.postBalances?.[idx] ?? 0) - BigInt(txr.meta?.preBalances?.[idx] ?? 0);
  };
  let feePaid: bigint | null, revenuePaid: bigint | null;
  if (order.pay_currency === "sol") {
    feePaid = nativeDelta(config.treasurySolAccount);
    if (feePaid === null || feePaid < BigInt(order.pay_fee_units)) return { ok: false, reason: "fee_short" };
    const trancheLamports = BigInt(order.pay_total_units) - BigInt(order.pay_fee_units);
    revenuePaid = nativeDelta(config.revenueSolAccount);
    if (revenuePaid === null || revenuePaid < trancheLamports) return { ok: false, reason: "revenue_short" };
  } else if (order.pay_currency === "dwell") {
    // $DWELL rail: one leg — the full payment to the company treasury, held.
    feePaid = tokenDelta(config.treasuryDwellAta, config.dwellMint);
    if (feePaid === null || feePaid < BigInt(order.pay_total_units)) return { ok: false, reason: "payment_short" };
    revenuePaid = 0n;
  } else {
    feePaid = tokenDelta(config.treasuryUsdcAta, config.usdcMint);
    if (feePaid === null || feePaid < BigInt(order.fee_micro_usdc)) return { ok: false, reason: "fee_short" };
    revenuePaid = tokenDelta(config.revenueUsdcAta, config.usdcMint);
    if (revenuePaid === null || revenuePaid < BigInt(order.tranche_micro_usdc)) return { ok: false, reason: "revenue_short" };
  }
  // payer (fee payer, the first account key) is the refund destination on
  // reject; receivedRaw is the actual on-chain amount held (both legs), the
  // exact quantity swapped on accept or refunded on reject.
  return {
    ok: true, feePaid, revenuePaid,
    payer: keys[0] || null,
    receivedRaw: (feePaid! + revenuePaid!).toString(),
    slot: txr.slot ?? null, blockTime: txr.blockTime ?? null,
  };
}

// ── treasury hedging (swap-on-accept / refund-on-reject) ──
// Both paths require TREASURY_SIGNER_SECRET; nothing in checkout does.
function requireSigner() {
  if (config.cryptoConfigError) {
    throw Object.assign(new Error(config.cryptoConfigError), { code: "NO_SIGNER" });
  }
  if (!config.treasurySignerSecret) {
    throw Object.assign(new Error("TREASURY_SIGNER_SECRET is not configured"), { code: "NO_SIGNER" });
  }
  return { secret: config.treasurySignerSecret, pubkey: signerPubkeyFromSecret(config.treasurySignerSecret) };
}
// Broadcast a signed transaction and poll until it finalizes. Bounded: the
// blockhash expires after ~90s, so a transaction that hasn't finalized by
// then never will.
async function sendAndConfirmTransaction(signedTxBase64: string, { pollMs = 2000, maxPolls = 45 }: any = {}) {
  const signature = await solanaRpc("sendTransaction", [
    signedTxBase64, { encoding: "base64", maxRetries: 3, preflightCommitment: "confirmed" },
  ]);
  for (let i = 0; i < maxPolls; i++) {
    const st = await solanaRpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const s = st?.value?.[0];
    if (s?.err) throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "finalized") return signature;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`transaction ${signature} did not finalize in time`);
}
// The USDC actually credited to the treasury by a finalized transaction —
// the runtime's own pre/post balances, never the quote's outAmount.
async function realizedUsdcDelta(signature: string) {
  const txr = await solanaRpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ]);
  if (!txr) throw new Error(`swap ${signature} not found`);
  if (txr.meta?.err) throw new Error(`swap ${signature} failed on-chain`);
  const keys = (txr.transaction?.message?.accountKeys || []).map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const find = (list: any[]) => (list || []).find((b: any) => keys[b.accountIndex] === config.treasuryUsdcAta && b.mint === config.usdcMint);
  const pre = find(txr.meta?.preTokenBalances);
  const post = find(txr.meta?.postTokenBalances);
  const delta = BigInt(post?.uiTokenAmount?.amount || "0") - BigInt(pre?.uiTokenAmount?.amount || "0");
  if (delta <= 0n) throw new Error(`swap ${signature} produced no USDC for the treasury`);
  return delta;
}
// Hedge: swap the SOL/$DWELL held for an accepted campaign into USDC via a
// Jupiter swap executed by the treasury signer. The realized USDC (read from
// the finalized transaction's balance deltas) becomes the campaign's funded
// dollar amount — the swap rate at acceptance time, not the checkout quote.
async function executeTreasurySwap({ payCurrency, amountRaw }: any) {
  const signer = requireSigner();
  const inputMint = payCurrency === "sol" ? WSOL_MINT : config.dwellMint;
  const quote = await jupiterQuote({
    inputMint, outputMint: config.usdcMint,
    amount: amountRaw, slippageBps: config.swapSlippageBps,
  });
  const res = await fetch(`${config.jupiterBaseUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.pubkey,
      destinationTokenAccount: config.treasuryUsdcAta,
      wrapAndUnwrapSol: true, // native SOL in the signer account wraps/unwraps in-route
      asLegacyTransaction: true,
    }),
  });
  if (!res.ok) throw new Error(`jupiter swap: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error || !body.swapTransaction) throw new Error(`jupiter swap: ${body.error || "no transaction"}`);
  const signed = signTransactionBase64(body.swapTransaction, signer.secret);
  const signature = await sendAndConfirmTransaction(signed);
  const realized = await realizedUsdcDelta(signature);
  return { signature, realizedMicroUsdc: realized.toString() };
}
// Refund a rejected campaign's held SOL/$DWELL in-kind to the paying wallet.
// $DWELL refunds need the payer to still hold a $DWELL token account; if
// they closed it the refund fails with NO_DEST_ACCOUNT and the admin can
// retry once the advertiser re-creates one.
async function executeRefund({ payCurrency, destination, amountRaw }: any) {
  const signer = requireSigner();
  if (!isPubkey(destination)) throw new Error("refund destination must be a Solana pubkey");
  let instructions: any[];
  if (payCurrency === "sol") {
    instructions = [systemTransferInstruction({ from: signer.pubkey, to: destination, lamports: amountRaw })];
  } else {
    const dest = await findTokenAccount(destination, config.dwellMint);
    if (!dest) {
      throw Object.assign(new Error("payer has no $DWELL token account to refund into"), { code: "NO_DEST_ACCOUNT" });
    }
    instructions = [tokenTransferInstruction({
      source: config.treasuryDwellAta, destination: dest.pubkey, owner: signer.pubkey, amount: amountRaw,
    })];
  }
  const bh = await solanaRpc("getLatestBlockhash", [{ commitment: "finalized" }]);
  const value = bh.value || bh;
  const unsigned = serializeUnsignedTransaction({
    feePayer: signer.pubkey, recentBlockhash: value.blockhash, instructions,
  });
  const signed = signTransactionBase64(unsigned, signer.secret);
  const signature = await sendAndConfirmTransaction(signed);
  return { signature };
}

const usdcCheckoutOff = () =>
  !config.tokenMode || !config.treasuryUsdcAta || !config.revenueUsdcAta;
const microUsd = (micro: any) => Number(micro) / 1e6;
const shapeUsdcOrder = (o: any) => ({
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
  ...(o.pay_currency === "dwell" ? { estPayTotalDwell: Number(o.pay_total_units) / 10 ** config.dwellDecimals, boostBps: config.dwellPayBoostBps } : {}),
  reference: o.reference_pubkey,
  txSignature: o.tx_signature || null,
  failReason: o.fail_reason || null,
  expiresAt: o.expires_at,
  // SOL/$DWELL settle at ACCEPTANCE: the payment is held during review, then
  // swapped to USDC when the ad is approved. The realized USDC at that
  // moment's rate is the funded dollar amount, so the effective CPM and
  // impression count may differ from the checkout quote.
  ...(["sol", "dwell"].includes(o.pay_currency) ? {
    settlement: "usdc-at-acceptance",
    settlementNote: "Held during review; swapped to USDC when the ad is accepted. The funded dollar amount is the realized USDC at the acceptance-time rate, so effective CPM/impressions may differ from this quote. Rejected ads are refunded in-kind to the paying wallet.",
    payerAddress: o.payer_address || null,
    swapSignature: o.swap_signature || null,
    realizedUsdc: o.realized_micro_usdc != null ? microUsd(o.realized_micro_usdc) : null,
    refundSignature: o.refund_signature || null,
  } : {}),
});

route("POST", "/v1/ads/usdc/orders", async (ctx: any) => {
  if (usdcCheckoutOff()) return json(404, { error: "not found" });
  // Same budget+CPM campaign shape as the card checkout — only the rail
  // differs. currency picks what the wallet pays with: 'usdc' (default),
  // 'sol' (two native transfers; needs the SOL account pair), or 'dwell'
  // (post-launch: one transfer to the treasury at a spot quote).
  const { email, adLine, url, brand, category, color, budget, cpm, showOnLeaderboard, currency, timescale } = ctx.body || {};
  const payCurrency = ["sol", "dwell"].includes(currency) ? currency : "usdc";
  if (payCurrency === "sol" && !(config.treasurySolAccount && config.revenueSolAccount)) {
    return json(400, { error: "SOL payments aren't enabled — pay with USDC" });
  }
  if (payCurrency === "dwell" && !(config.dwellMint && config.treasuryDwellAta)) {
    return json(400, { error: "$DWELL payments open after token launch — pay with USDC or SOL" });
  }
  const budgetCents = Math.round(Number(budget) * 100);
  const cpmCents = Math.round(Number(cpm) * 100);
  // Email is optional on the crypto rails (the wallet is the identity; a
  // receipt address is Stripe-only). When absent, the advertiser row hangs
  // off a synthetic per-order address on the reserved .invalid TLD — never
  // deliverable, never mailed.
  const advertiserEmail = String(email || "").trim();
  if (advertiserEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(advertiserEmail)) {
    return json(400, { error: "that email doesn't look valid — fix it or leave it blank" });
  }
  if (!isCleanAdLine(adLine)) return json(400, { error: "ad line must be 3-60 printable chars, no < >" });
  if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(400, { error: "https url required" });
  const P = await repo.getPricing();
  if (!(cpmCents >= P.minCpmCents && cpmCents <= P.maxCpmCents)) {
    return json(400, { error: `CPM must be $${(P.minCpmCents / 100).toFixed(2)}–$${(P.maxCpmCents / 100).toFixed(2)}` });
  }
  if (!(budgetCents >= P.minBudgetCents && budgetCents <= P.maxBudgetCents)) {
    return json(400, { error: `budget must be $${(P.minBudgetCents / 100).toFixed(0)}–$${(P.maxBudgetCents / 100).toLocaleString("en-US")}` });
  }
  // Paying in $DWELL boosts the campaign's impressions (docs/08) — same
  // spend, +DWELL_PAY_BOOST_BPS more reach. Impressions only; the rewards
  // pool stays sized to the USD price, so the boost is extra reach, not a
  // bigger viewer pool.
  const boostBps = payCurrency === "dwell" ? config.dwellPayBoostBps : 0;
  const baseImpressions = Math.floor((budgetCents * 1000) / cpmCents);
  const impressions = Math.floor(baseImpressions * (10000 + boostBps) / 10000);
  if (!(baseImpressions >= 1)) return json(400, { error: "budget too small for this CPM" });

  // The USD split is the pricing truth on every rail, exact in micro-USDC:
  // the fee leg is the 10000-RESERVE_TRANCHE_BPS remainder; the rewards-pool
  // (revenue) leg keeps every leftover micro unit. SOL/$DWELL amounts derive
  // from it per spot quote — nothing is swapped, no leg buys $DWELL.
  const priceMicro = BigInt(budgetCents) * 10000n;
  const feeMicro = (priceMicro * BigInt(10000 - config.reserveTrancheBps)) / 10000n;
  const trancheMicro = priceMicro - feeMicro;

  let quote: any = {}, payTotalUnits: string, payFeeUnits: string;
  try {
    if (payCurrency === "sol") {
      const sol = await priceOrderInSol(priceMicro.toString(), 10000 - config.reserveTrancheBps);
      payTotalUnits = sol.totalLamports.toString();
      payFeeUnits = sol.feeLamports.toString();
      quote = sol.quote;
    } else if (payCurrency === "dwell") {
      const d = await priceOrderInDwell(priceMicro.toString());
      payTotalUnits = d.totalDwell.toString();
      payFeeUnits = d.totalDwell.toString(); // one leg: the verifier enforces the full payment
      quote = d.quote;
    } else {
      // USDC needs no quote at all — the price IS the pay amount.
      payTotalUnits = priceMicro.toString();
      payFeeUnits = feeMicro.toString();
    }
  } catch (err: any) {
    console.error("[dwell] crypto order pricing failed:", err?.message);
    return json(502, { error: "couldn't price the order — try again" });
  }

  const reference = newReferencePubkey();
  const blocks = Math.max(1, Math.round(impressions / 1000));
  const campaignId = await repo.createPendingCampaign({
    email: advertiserEmail || `${reference.slice(0, 20).toLowerCase()}@wallet.invalid`,
    brand, adLine, url, category, color: normalizeHexColor(color),
    pricePerBlockCents: cpmCents, blocks, impressionsTotal: impressions, budgetCents, showOnLeaderboard,
    changeTimescale: normalizeTimescale(timescale),
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
    minDwellOut: "0", // v2: no swap, no slippage floor (column kept for compatibility)
    referencePubkey: reference,
    ttlMinutes: config.usdcOrderTtlMinutes,
  });
  return json(200, {
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
    ...(["sol", "dwell"].includes(payCurrency) ? {
      settlement: "usdc-at-acceptance",
      settlementNote: "Held during review; swapped to USDC when the ad is accepted. The funded dollar amount is the realized USDC at the acceptance-time rate, so effective CPM/impressions may differ from this quote. Rejected ads are refunded in-kind to the paying wallet.",
    } : {}),
    expiresAt: order.expires_at,
    // Solana Pay transaction request: wallets GET label/icon then POST
    // {account} to this link and receive the unsigned transaction.
    solanaPayUrl: `solana:${encodeURIComponent(`${config.apiBaseUrl}/v1/ads/usdc/orders/${order.id}/transaction`)}`,
  });
});

// Order status — the checkout page poller. Discovery + verification ride the
// poll (Solana Pay findReference), so no webhook is needed for the scaffold;
// a Helius webhook can shortcut this later without changing the contract.
route("GET", "/v1/ads/usdc/orders/:id", async (ctx: any) => {
  if (usdcCheckoutOff()) return json(404, { error: "not found" });
  const order = await repo.getUsdcOrder(ctx.params.id);
  if (!order) return json(404, { error: "order not found" });
  if (order.status !== "awaiting_signature") return json(200, shapeUsdcOrder(order));

  // Optional hint from the paying client; otherwise look up by reference.
  let signatures: string[] = [];
  const hinted = ctx.query.get("signature");
  try {
    signatures = hinted ? [hinted] : await findReferenceSignatures(order.reference_pubkey);
  } catch (err: any) {
    console.error("[dwell] usdc order signature lookup failed:", err?.message);
    return json(200, shapeUsdcOrder(order)); // RPC hiccup — stay awaiting, client re-polls
  }
  for (const signature of signatures) {
    let v: any;
    try {
      v = await verifyOrderTransaction({ signature, order });
    } catch (err: any) {
      console.error("[dwell] usdc order verify failed:", err?.message);
      continue;
    }
    if (!v.ok) {
      // A landed-but-wrong transaction (a short leg) permanently fails the
      // order; not-yet-final ones keep the order open.
      if (["tx_failed", "fee_short", "revenue_short", "payment_short", "reference_missing"].includes(v.reason) && !hinted) {
        await repo.failUsdcOrder(order.id, v.reason, signature);
      }
      continue;
    }
    try {
      const paid = await repo.confirmUsdcOrder({
        orderId: order.id,
        txSignature: signature,
        payerAddress: v.payer,
        receivedRaw: v.receivedRaw,
        tokenSplit,
      });
      // Receipt only when the advertiser gave a real address — anonymous
      // wallet checkouts hang off a synthetic @wallet.invalid address.
      if (paid && !(paid as any).email.endsWith("@wallet.invalid")) {
        try {
          await mailer.sendAdvertiserReceiptEmail((paid as any).email, {
            campaignId: order.campaign_id,
            brand: (paid as any).brand,
            adLine: (paid as any).adLine,
            cpmCents: (paid as any).pricePerBlockCents,
            impressionsTotal: (paid as any).impressionsTotal,
            budgetCents: (paid as any).budgetCents,
          });
        } catch (err) {
          console.error("[dwell] usdc advertiser receipt email failed", err);
        }
      }
    } catch (err: any) {
      if (err.code === "CAMPAIGN_NOT_FUNDABLE") {
        await repo.failUsdcOrder(order.id, "campaign_not_fundable", signature);
      } else {
        throw err;
      }
    }
    break;
  }
  const fresh = await repo.getUsdcOrder(order.id);
  return json(200, shapeUsdcOrder(fresh));
});

// Solana Pay transaction request (GET half): wallet-facing metadata.
route("GET", "/v1/ads/usdc/orders/:id/transaction", async () => {
  if (usdcCheckoutOff()) return json(404, { error: "not found" });
  return json(200, { label: `${config.brandName} ad campaign`, icon: `${config.siteUrl}/og.png` });
});

// Solana Pay transaction request (POST half): build the atomic unsigned
// transaction for the paying wallet. SOL/$DWELL re-price on every build —
// a built transaction is only ~60s of blockhash validity — and the refreshed
// amounts pin to the order so the verifier enforces what the wallet saw.
// USDC amounts are the USD price itself: nothing to re-price.
route("POST", "/v1/ads/usdc/orders/:id/transaction", async (ctx: any) => {
  if (usdcCheckoutOff()) return json(404, { error: "not found" });
  const order = await repo.getUsdcOrder(ctx.params.id);
  if (!order) return json(404, { error: "order not found" });
  if (order.status === "expired") return json(410, { error: "order expired — start a new one" });
  if (order.status !== "awaiting_signature") return json(409, { error: `order is ${order.status}` });
  const payer = String(ctx.body?.account || "");
  if (!isPubkey(payer)) return json(400, { error: "account must be a Solana pubkey" });
  try {
    const built: any = { ...order };
    let tail = "";

    if (order.pay_currency === "dwell") {
      const d = await priceOrderInDwell(String(order.price_micro_usdc));
      built.pay_total_units = d.totalDwell.toString();
      built.pay_fee_units = d.totalDwell.toString();
      await repo.refreshUsdcOrderQuote(order.id, d.quote, "0", { payTotalUnits: built.pay_total_units, payFeeUnits: built.pay_fee_units });
      tail = ` (≈ ${(Number(built.pay_total_units) / 10 ** config.dwellDecimals).toLocaleString("en-US", { maximumFractionDigits: 2 })} $DWELL to the company treasury, +${config.dwellPayBoostBps / 100}% impressions)`;
    } else if (order.pay_currency === "sol") {
      const sol = await priceOrderInSol(String(order.price_micro_usdc), 10000 - config.reserveTrancheBps);
      built.pay_total_units = sol.totalLamports.toString();
      built.pay_fee_units = sol.feeLamports.toString();
      await repo.refreshUsdcOrderQuote(order.id, sol.quote, "0", { payTotalUnits: built.pay_total_units, payFeeUnits: built.pay_fee_units });
      tail = ` (≈ ${(Number(built.pay_total_units) / 1e9).toFixed(4)} SOL)`;
    }

    const transaction = await buildOrderTransaction({ order: built, payer });
    return json(200, {
      transaction,
      message: order.pay_currency === "dwell"
        ? `${config.brandName}: $${microUsd(order.price_micro_usdc).toFixed(2)} ad campaign paid in $DWELL${tail}`
        : `${config.brandName}: $${microUsd(order.price_micro_usdc).toFixed(2)} ad campaign — $${microUsd(order.fee_micro_usdc).toFixed(2)} protocol fee + $${microUsd(order.tranche_micro_usdc).toFixed(2)} to the rewards pool${tail}`,
    });
  } catch (err: any) {
    if (err.code === "NO_FUNDS" || err.code === "BAD_ACCOUNT") return json(400, { error: err.message });
    console.error("[dwell] crypto order build failed:", err?.message);
    return json(502, { error: "couldn't build the transaction — try again" });
  }
});

// ── advertiser checkout ──
route("POST", "/v1/checkout", async (ctx: any) => {
  // Budget + CPM model: advertiser pays the full budget; impressions = floor(
  // budget*1000/cpm). CPM == price_per_block_cents (block = 1,000 impressions).
  const { email, adLine, url, brand, category, color, budget, cpm, showOnLeaderboard, timescale } = ctx.body || {};
  const budgetCents = Math.round(Number(budget) * 100);
  const cpmCents = Math.round(Number(cpm) * 100);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (!isCleanAdLine(adLine)) return json(400, { error: "ad line must be 3-60 printable chars, no < >" });
  if (!/^https:\/\/[^\s]+$/.test(url || "")) return json(400, { error: "https url required" });
  const { minCpmCents, maxCpmCents, minBudgetCents, maxBudgetCents } = await repo.getPricing();
  if (!(cpmCents >= minCpmCents && cpmCents <= maxCpmCents)) return json(400, { error: `CPM must be $${(minCpmCents / 100).toFixed(2)}–$${(maxCpmCents / 100).toFixed(2)}` });
  if (!(budgetCents >= minBudgetCents && budgetCents <= maxBudgetCents)) return json(400, { error: `budget must be $${(minBudgetCents / 100).toFixed(0)}–$${(maxBudgetCents / 100).toLocaleString("en-US")}` });
  const impressions = Math.floor((budgetCents * 1000) / cpmCents);
  if (!(impressions >= 1)) return json(400, { error: "budget too small for this CPM" });
  const blocks = Math.max(1, Math.round(impressions / 1000)); // legacy display column; impressions_total is authoritative
  const campaignId = await repo.createPendingCampaign({ email, brand, adLine, url, category, color: normalizeHexColor(color), pricePerBlockCents: cpmCents, blocks, impressionsTotal: impressions, budgetCents, showOnLeaderboard, changeTimescale: normalizeTimescale(timescale) });
  const session = await stripe.createCheckoutSession({
    mode: "payment", customer_email: email,
    // receipt_email isn't a Checkout Session param; it lives on the PaymentIntent.
    payment_intent_data: { receipt_email: email },
    // Brand-configurable so the DWELL deployment bills under its own Stripe
    // product line, even before its keys move to their own account.
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: budgetCents, product_data: { name: config.stripeProductName || "DWELL ad campaign", description: `${brand ? brand + " — " : ""}"${adLine}" → ${url} · ${impressions.toLocaleString("en-US")} impressions @ $${(cpmCents / 100).toFixed(2)} CPM`, images: [config.stripeProductImage || "https://dwellprotocol.com/og.png"] } } }],
    metadata: { campaign_id: campaignId },
    success_url: `${config.siteUrl}/?checkout=success`,
    cancel_url: `${config.siteUrl}/?checkout=cancelled`,
  });
  await repo.attachCheckoutSession(campaignId, session.id);
  return json(200, { campaignId, checkoutUrl: session.url });
});

// ── Pre-account email capture (launch waitlist) ──
// Public, no-auth: someone types their email under the hero on dwellprotocol.com (or a
// lander) to be told when they can install and start earning. We store the bare
// email (no account, no magic link), then — best-effort, off the hot path — send
// a confirmation and mirror them into Resend for the launch broadcast.
route("POST", "/v1/waitlist", async (ctx: any) => {
  const email = String(ctx.body?.email || "").trim().toLowerCase();
  const source = typeof ctx.body?.source === "string" ? ctx.body.source.slice(0, 80) : null;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  try {
    const { created } = await repo.addEmailLead({ email, kind: "earn", source, ipHash: hashIp(ctx), ipDailyCap: config.leadDailyCap });
    if (created) {
      // Fire-and-forget: never let a mail/Resend failure fail the capture.
      mailer.sendWaitlistConfirmationEmail(email).catch((e: any) => console.error("[dwell] waitlist confirm mail failed:", e?.message));
      addResendContact(email, source).catch((e: any) => console.error("[dwell] waitlist resend contact failed:", e?.message));
    }
    return json(200, { ok: true, joined: true, alreadyJoined: !created });
  } catch (err: any) {
    if (err.code === "CAP_EXCEEDED") return json(429, { error: "too many signups from here today — try again later" });
    throw err;
  }
});

// ── Stripe webhooks ──
route("POST", "/v1/webhooks/stripe", async (ctx: any) => {
  const sig = ctx.headers.get("stripe-signature");
  const signed =
    verifyWebhookSignature(ctx.rawBody, sig, config.stripeWebhookSecret) ||
    (!!config.stripeConnectWebhookSecret &&
      verifyWebhookSignature(ctx.rawBody, sig, config.stripeConnectWebhookSecret));
  if (!signed) return json(400, { error: "bad signature" });
  const event = ctx.body;
  const fresh = await repo.claimWebhookEvent(event.id, event.type);
  if (!fresh) return json(200, { received: true, duplicate: true });
  switch (event.type) {
    case "checkout.session.completed": {
      const obj = event.data?.object || {};
      if (obj.metadata?.campaign_id) {
        const paid = await repo.markCampaignPaid(obj.metadata.campaign_id, obj.payment_intent, { tokenSplit });
        // Only on the transitioning call. Wrapped so a mail outage never rolls
        // back the funded state — the webhook event is already claimed.
        if (paid) {
          try {
            await mailer.sendAdvertiserReceiptEmail((paid as any).email, {
              campaignId: obj.metadata.campaign_id,
              brand: (paid as any).brand,
              adLine: (paid as any).adLine,
              cpmCents: (paid as any).pricePerBlockCents,
              impressionsTotal: (paid as any).impressionsTotal,
              budgetCents: (paid as any).budgetCents,
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
  return json(200, { received: true });
});

// ── email verification (before payouts) ──
route("POST", "/v1/auth/request-link", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  if (!ctx.body?.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ctx.body.email)) return json(400, { error: "valid email required" });
  let token: any;
  try {
    token = await repo.createEmailToken(ctx.body.email, device.id, config.emailTokenTtlMs, null, config.emailCooldownMs, hashIp(ctx), config.emailIpDailyCap);
  } catch (err: any) {
    if (err.code === "CAP_EXCEEDED") return json(429, { error: "too many email requests from here today — try again later" });
    throw err;
  }
  if (token) await mailer.sendVerifyEmail(ctx.body.email, `${config.apiBaseUrl}/v1/auth/verify?token=${token}`);
  return json(200, { ok: true, sent: true });
});
route("GET", "/v1/auth/verify", async (ctx: any) => {
  const user = await repo.verifyEmailToken(ctx.query.get("token"));
  return redirect(`${config.siteUrl}/?verified=${user ? 1 : 0}`);
});

// ── developer onboarding & earnings ──
route("POST", "/v1/connect/onboard", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const user = await repo.userForDevice(device.id);
  if (!user || !user.email_verified) return json(403, { error: "verify your email first" });
  let accountId = user.stripe_account_id;
  if (!accountId) {
    const account = await stripe.createAccount({ type: "express", email: user.email, capabilities: { transfers: { requested: true } }, business_type: "individual" });
    accountId = account.id;
    await repo.setStripeAccount(user.id, accountId);
  }
  const link = await stripe.createAccountLink({ account: accountId, type: "account_onboarding", refresh_url: `${config.siteUrl}/?onboarding=retry`, return_url: `${config.siteUrl}/?onboarding=done` });
  return json(200, { onboardingUrl: link.url });
});
route("GET", "/v1/me/earnings", async (ctx: any) => {
  const device = await authDeviceFrom(ctx, true);
  if (!device) return json(401, { error: "bad device credentials" });
  // Once the device is linked, report the pooled account balance (every surface
  // the user has) so the desktop menu matches the web dashboard exactly; an
  // anonymous device still sees only its own earnings.
  const user = await repo.userForDevice(device.id);
  const e = user ? await repo.balanceForUser(user.id) : await repo.earningsForDevice(device.id);
  return json(200, {
    revenueShare: displayRevenueShare,
    earnedUsd: e.earnedMillicents / 100000, paidOutUsd: e.paidOutMillicents / 100000,
    redeemedUsd: e.redeemedMillicents / 100000, balanceUsd: e.balanceMillicents / 100000,
    payoutThresholdUsd: config.payoutThresholdCents / 100,
  });
});

// Device-scoped affiliate "crew": the extension popup's earn-with-friends panel.
// Anonymous until the device is linked to a user (via the magic link from
// /v1/auth/request-link). Once linked, the user is auto-enrolled as an approved
// affiliate and this returns their invite code/link plus the per-friend breakdown
// — no web session needed, just device credentials.
route("GET", "/v1/me/affiliate", async (ctx: any) => {
  const device = await authDeviceFrom(ctx, true);
  if (!device) return json(401, { error: "bad device credentials" });
  const rewardPct = config.affiliateRewardBps / 100;
  const user = await repo.userForDevice(device.id);
  if (!user) return json(200, { linked: false, rewardPct });
  const aff = await repo.getOrCreateAffiliate(user.id);
  const crew = await repo.affiliateCrew(aff.id, user.id);
  // Pending invites you've sent that haven't joined yet — surfaced so the popup's
  // crew slots stay filled across reopens. Drop any whose masked address already
  // matches a joined friend (an invited friend who accepted shows up in `friends`).
  const friendNames = new Set(crew.friends.map((f: any) => f.name));
  const invited = (await repo.pendingInvitesForUser(user.id)).filter((i: any) => !friendNames.has(i.email));
  return json(200, {
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
// session): authed by device credentials, the invite carries the user's affiliate
// link so the friend is attributed to them — earning the affiliate's cut forever.
route("POST", "/v1/me/affiliate/invite", async (ctx: any) => {
  const device = await authDeviceFrom(ctx);
  if (!device) return json(401, { error: "bad device credentials" });
  const user = await repo.userForDevice(device.id);
  if (!user) return json(401, { error: "link this device to invite friends" });
  const email = String(ctx.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
    return json(400, { error: "you can't invite your own email" });
  }
  const aff = await repo.getOrCreateAffiliate(user.id);
  const link = `${config.siteUrl}/portal.html?ref=${aff.code}`;
  const invite = await repo.createReferralInvite(user.id, email, aff.code);
  // Email delivery is best-effort — the invite row is the source of truth. A
  // mail-provider rejection must not fail the request (see /v1/web/affiliate/invite).
  let sent = true;
  try {
    await mailer.sendCrewInviteEmail(email, { inviterEmail: user.email, link, rewardPct: config.affiliateRewardBps / 100 });
  } catch (err: any) {
    sent = false;
    console.error("[dwell] crew invite email failed:", err?.message);
    try {
      await pool.query(
        "insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)",
        ["POST", "/v1/me/affiliate/invite", String(err?.message || err), String(err?.stack || "")]
      );
    } catch (_e) { /* logging is best-effort too */ }
  }
  return json(200, { ok: true, sent, invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at } });
});

// ── gift card catalog & device-scoped redemption ──
route("GET", "/v1/giftcards", async () => json(200, {
  plans: Object.values(GIFT_PLANS).map((p: any) => ({ id: p.id, name: p.name, tagline: p.tagline, monthlyUsd: p.monthlyCents / 100 })),
  months: GIFT_MONTHS, redemptionFeeBps: config.redemptionFeeBps, redemptionBoostBps: config.redemptionBoostBps || 0, deliveryWindowHours: 48,
}));
// Redemption is a website-only, logged-in flow (see AGENTS.md): credits are
// cashed out at /v1/web/redemptions behind a web session. The old
// device-credential path is retired — a leaked deviceKey must let someone
// accrue credits in your name, never cash them out. Old clients get a clear,
// safe refusal instead of a money-out they can't be trusted with.
route("POST", "/v1/redemptions", async () => {
  return json(410, {
    error: "redeem on the website after signing in",
    redeemUrl: `${config.siteUrl}/portal.html`,
  });
});

// ── OAuth helpers ──
function makeOAuthState(ref: any) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  const code = String(ref || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  const payload = `${ts}.${nonce}.${code}`;
  const sig = crypto.createHmac("sha256", config.adminKey || "fallback").update(payload).digest("hex").slice(0, 20);
  return `${payload}.${sig}`;
}
function verifyOAuthState(state: string | null) {
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
// X's OAuth 2.0 Authorization Code flow mandates PKCE. We stay stateless by
// deriving the code_verifier from the signed state's nonce with a server secret
// — only its S256 hash (the challenge) travels through the browser, and the
// callback recomputes the verifier from the returned state.
function pkceVerifier(nonce: string) {
  return crypto.createHmac("sha256", config.adminKey || "fallback").update(`pkce:${nonce}`).digest("hex");
}
function pkceChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
function derEcdsaToP1363(der: any) {
  let i = 2; i++;
  const rLen = der[i++];
  const r = der.slice(i, i + rLen);
  i += rLen; i++;
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  const fit32 = (b: any) => { const out = Buffer.alloc(32); b.slice(b.length > 32 ? b.length - 32 : 0).copy(out, 32 - Math.min(b.length, 32)); return out; };
  return Buffer.concat([fit32(r), fit32(s)]);
}
function decodeJwtPayload(token: string) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); } catch { return null; }
}
function buildAppleClientSecret() {
  if (!config.applePrivateKey || !config.appleTeamId || !config.appleKeyId || !config.appleClientId) return null;
  const hdr = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.appleKeyId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const pay = Buffer.from(JSON.stringify({ iss: config.appleTeamId, iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: config.appleClientId })).toString("base64url");
  const input = `${hdr}.${pay}`;
  const sign = crypto.createSign("SHA256");
  sign.update(input);
  const der = sign.sign(config.applePrivateKey);
  return `${input}.${derEcdsaToP1363(der).toString("base64url")}`;
}

// ── Google OAuth ──
route("GET", "/v1/auth/google", async (ctx: any) => {
  if (!config.googleClientId) return redirect(`${config.siteUrl}/portal.html?login=no-google`);
  const params = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`,
    response_type: "code", scope: "email profile", state: makeOAuthState(ctx.query.get("ref")),
    access_type: "online", prompt: "select_account",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});
route("GET", "/v1/auth/google/callback", async (ctx: any) => {
  const query = ctx.query;
  if (query.get("error") || !query.get("code")) return redirect(`${config.siteUrl}/portal.html?login=cancelled`);
  const oauthState = verifyOAuthState(query.get("state"));
  if (!oauthState) return redirect(`${config.siteUrl}/portal.html?login=error`);
  try {
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: query.get("code"), client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: `${config.apiBaseUrl}/v1/auth/google/callback`, grant_type: "authorization_code" }).toString(),
    });
    const tokens = await tokRes.json();
    if (!tokens.access_token) throw new Error("no access_token");
    const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const gu = await uiRes.json();
    if (!gu.email) throw new Error("no email from Google");
    const { sessionToken } = await repo.upsertUserByOAuth(
      { email: gu.email, googleId: gu.sub, referralCode: oauthState.ref, emailVerified: gu.email_verified === true || gu.email_verified === "true" },
      config.webSessionTtlMs
    );
    return redirect(`${config.siteUrl}/portal.html#session=${sessionToken}`);
  } catch (err: any) {
    console.error("[dwell] google oauth:", err.message);
    return redirect(`${config.siteUrl}/portal.html?login=error`);
  }
});

// ── Apple OAuth ──
route("GET", "/v1/auth/apple", async (ctx: any) => {
  if (!config.appleClientId) return redirect(`${config.siteUrl}/portal.html?login=no-apple`);
  const params = new URLSearchParams({
    client_id: config.appleClientId, redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`,
    response_type: "code", scope: "email", response_mode: "query", state: makeOAuthState(ctx.query.get("ref")),
  });
  return redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});
route("GET", "/v1/auth/apple/callback", async (ctx: any) => {
  const query = ctx.query;
  if (query.get("error") || !query.get("code")) return redirect(`${config.siteUrl}/portal.html?login=cancelled`);
  const oauthState = verifyOAuthState(query.get("state"));
  if (!oauthState) return redirect(`${config.siteUrl}/portal.html?login=error`);
  try {
    const secret = buildAppleClientSecret();
    if (!secret) throw new Error("Apple credentials not configured");
    const tokRes = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: query.get("code"), client_id: config.appleClientId, client_secret: secret, redirect_uri: `${config.apiBaseUrl}/v1/auth/apple/callback`, grant_type: "authorization_code" }).toString(),
    });
    const tokens = await tokRes.json();
    if (!tokens.id_token) throw new Error("no id_token from Apple");
    const claims = decodeJwtPayload(tokens.id_token);
    if (!claims?.sub) throw new Error("no sub in Apple id_token");
    const { sessionToken } = await repo.upsertUserByOAuth(
      { email: claims.email || null, appleId: claims.sub, referralCode: oauthState.ref, emailVerified: claims.email_verified === true || claims.email_verified === "true" },
      config.webSessionTtlMs
    );
    return redirect(`${config.siteUrl}/portal.html#session=${sessionToken}`);
  } catch (err: any) {
    console.error("[dwell] apple oauth:", err.message);
    return redirect(`${config.siteUrl}/portal.html?login=error`);
  }
});

// ── X (Twitter) sign-in — OAuth 2.0 Authorization Code + PKCE ──
// Endpoints per docs.x.com: authorize at x.com/i/oauth2/authorize, token at
// api.x.com/2/oauth2/token, identity via GET /2/users/me (tweet.read +
// users.read scopes). X returns no email, so accounts are keyed on the numeric
// X user id; the handle is display-only. The confidential client authenticates
// the token exchange with HTTP Basic.
route("GET", "/v1/auth/twitter", async (ctx: any) => {
  if (!config.twitterClientId) return redirect(`${config.siteUrl}/portal.html?login=no-twitter`);
  const state = makeOAuthState(ctx.query.get("ref"));
  const st = verifyOAuthState(state);
  const params = new URLSearchParams({
    response_type: "code", client_id: config.twitterClientId,
    redirect_uri: `${config.apiBaseUrl}/v1/auth/twitter/callback`,
    scope: "tweet.read users.read", state,
    code_challenge: pkceChallenge(pkceVerifier(st!.nonce)), code_challenge_method: "S256",
  });
  return redirect(`https://x.com/i/oauth2/authorize?${params}`);
});
route("GET", "/v1/auth/twitter/callback", async (ctx: any) => {
  const query = ctx.query;
  if (query.get("error") || !query.get("code")) return redirect(`${config.siteUrl}/portal.html?login=cancelled`);
  const oauthState = verifyOAuthState(query.get("state"));
  if (!oauthState) return redirect(`${config.siteUrl}/portal.html?login=error`);
  try {
    const basic = Buffer.from(`${config.twitterClientId}:${config.twitterClientSecret}`).toString("base64");
    const tokRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ code: query.get("code"), grant_type: "authorization_code", client_id: config.twitterClientId, redirect_uri: `${config.apiBaseUrl}/v1/auth/twitter/callback`, code_verifier: pkceVerifier(oauthState.nonce) }).toString(),
    });
    const tokens = await tokRes.json();
    if (!tokens.access_token) throw new Error(`no access_token from X (${tokRes.status}: ${JSON.stringify(tokens).slice(0, 200)})`);
    const uiRes = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const tu = await uiRes.json();
    if (!tu?.data?.id) throw new Error(`no user id from X (${uiRes.status}: ${JSON.stringify(tu).slice(0, 200)})`);
    const { sessionToken } = await repo.upsertUserByOAuth(
      { twitterId: String(tu.data.id), twitterUsername: tu.data.username || null, referralCode: oauthState.ref, emailVerified: false },
      config.webSessionTtlMs
    );
    return redirect(`${config.siteUrl}/portal.html#session=${sessionToken}`);
  } catch (err: any) {
    console.error("[dwell] twitter oauth:", err.message);
    // Record the failure durably — the redirect swallows it from the caller, and
    // console output alone has proven easy to miss when debugging sign-in.
    try {
      await pool.query(
        "insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)",
        ["GET", "/v1/auth/twitter/callback", String(err?.message || err), String(err?.stack || "")]
      );
    } catch (_e) { /* diagnostics must never break the redirect */ }
    return redirect(`${config.siteUrl}/portal.html?login=error`);
  }
});

// ── website login + redemption ──
route("POST", "/v1/web/login", async (ctx: any) => {
  const body = ctx.body || {};
  if (!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return json(400, { error: "valid email required" });
  let token: any;
  try {
    token = await repo.createEmailToken(body.email, null, config.emailTokenTtlMs, body.referralCode, config.emailCooldownMs, hashIp(ctx), config.emailIpDailyCap);
  } catch (err: any) {
    if (err.code === "CAP_EXCEEDED") return json(429, { error: "too many sign-in requests from here today — try again later" });
    throw err;
  }
  if (token) await mailer.sendWebLoginEmail(body.email, `${config.apiBaseUrl}/v1/web/session?token=${token}`);
  return json(200, { ok: true, sent: true });
});
route("GET", "/v1/web/session", async (ctx: any) => {
  const result = await repo.createWebSessionFromToken(ctx.query.get("token"), config.webSessionTtlMs);
  if (!result) return redirect(`${config.siteUrl}/portal.html?login=expired`);
  return redirect(`${config.siteUrl}/portal.html#session=${result.sessionToken}`);
});
route("GET", "/v1/web/me", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const bal = await repo.balanceForUser(user.id);
  const [hasSurvey, posted, code] = await Promise.all([
    repo.hasOnboardingSurvey(user.id),
    repo.hasPostedOnboarding(user.id),
    repo.getOrCreateReferralCode(user.id),
  ]);
  return json(200, {
    email: user.email, twitterUsername: user.twitter_username || null,
    balanceUsd: bal.balanceMillicents / 100000,
    needsSurvey: !hasSurvey, needsPost: !posted,
    referralLink: `${config.siteUrl}/portal.html?ref=${code}`,
  });
});
// Sign out: revoke the session server-side so the bearer token is dead even if
// it lingers in a browser/localStorage. Always 200 (idempotent).
route("POST", "/v1/web/logout", async (ctx: any) => {
  await repo.deleteWebSession(sessionFrom(ctx));
  return json(200, { ok: true });
});
route("GET", "/v1/web/earnings", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const window = ({ "24h": "24h", "7d": "7d", "30d": "30d" } as any)[ctx.query.get("window")] || "7d";
  const bucket = window === "24h" ? "hour" : "day";
  const sinceMs = window === "24h" ? 24 * 3600e3 : (window === "7d" ? 7 : 30) * 86400e3;
  const since = new Date(Date.now() - sinceMs);
  const e = await repo.earningsForUser(user.id);
  const series = await repo.earningsSeriesForUser(user.id, { bucket, since });
  return json(200, {
    todayUsd: e.todayMillicents / 100000, monthUsd: e.monthMillicents / 100000,
    lifetimeUsd: e.lifetimeMillicents / 100000, balanceUsd: e.balanceMillicents / 100000,
    redeemedUsd: e.redeemedMillicents / 100000, window,
    series: series.map((b: any) => ({ t: b.t, usd: b.millicents / 100000, count: b.count })),
  });
});
route("GET", "/v1/web/activity", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const rows = await repo.recentCreditsForUser(user.id, ctx.query.get("limit") || 200);
  return json(200, {
    count: rows.length,
    rows: rows.map((r: any) => ({
      id: String(r.id), createdAt: r.createdAt, type: r.entryType,
      amountUsd: r.amountMillicents / 100000, advertiser: r.advertiser, meta: r.meta,
    })),
  });
});
// Per-service activation for the Install tab: true once the account has received
// its first credit from that surface (chrome / claude_code / desktop).
route("GET", "/v1/web/sources", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const sources = await repo.sourcesForUser(user.id);
  return json(200, { sources });
});
route("GET", "/v1/web/referrals", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const code = await repo.getOrCreateReferralCode(user.id);
  const stats = await repo.referralStats(user.id);
  return json(200, {
    code, link: `${config.siteUrl}/portal.html?ref=${code}`,
    rewardUsd: config.referralRewardCents / 100, cap: config.referralCap,
    rewardedCount: stats.rewardedCount, pendingCount: stats.pendingCount,
    invitedCount: stats.invitedCount,
    creditsEarnedUsd: stats.creditsEarnedMillicents / 100000, referrals: stats.referrals,
  });
});
route("GET", "/v1/web/waitlist", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const surfaces = await repo.listWaitlistSurfaces();
  const joined = new Set((await repo.waitlistsForUser(user.id)).map((w: any) => w.surface));
  return json(200, {
    surfaces: surfaces.map((s: any) => ({ surface: s.surface, label: s.label, joined: joined.has(s.surface) })),
  });
});
route("POST", "/v1/web/waitlist", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const surface = ctx.body?.surface;
  const known = await repo.listWaitlistSurfaces();
  if (!surface || !known.some((s: any) => s.surface === surface)) {
    return json(400, { error: "unknown surface", surfaces: known.map((s: any) => s.surface) });
  }
  const created = await repo.joinWaitlist(user.id, surface);
  return json(200, { ok: true, surface, joined: true, alreadyJoined: !created });
});
route("POST", "/v1/web/referrals/invite", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const email = String(ctx.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
    return json(400, { error: "You can't refer your own email" });
  }
  const code = await repo.getOrCreateReferralCode(user.id);
  const link = `${config.siteUrl}/portal.html?ref=${code}`;
  const invite = await repo.createReferralInvite(user.id, email, code);
  // The invite row above is the onboarding gate and the source of truth: a
  // friend never has to act for the inviter to progress. Delivering the email
  // is best-effort — if the mail provider rejects it (e.g. an unverified
  // sending domain), record it for the admin diag but don't fail the request,
  // or the user is stranded on onboarding behind an "internal error" for an
  // invite that was actually saved.
  let sent = true;
  try {
    await mailer.sendReferralInviteEmail(email, { inviterEmail: user.email, link, rewardUsd: config.referralRewardCents / 100 });
  } catch (err: any) {
    sent = false;
    console.error("[dwell] referral invite email failed:", err?.message);
    try {
      await pool.query(
        "insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)",
        ["POST", "/v1/web/referrals/invite", String(err?.message || err), String(err?.stack || "")]
      );
    } catch (_e) { /* logging is best-effort too */ }
  }
  return json(200, { ok: true, sent, invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at } });
});
// ── affiliate program ──
route("GET", "/v1/web/affiliate", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  // Self-serve: everyone is an affiliate. Ensure enrollment, then read details.
  await repo.getOrCreateAffiliate(user.id);
  const data = await repo.affiliateForUser(user.id);
  const app = data.application;
  // Influencer upgrade = a higher rate or a raised people cap above the base config.
  const upgraded = app.rewardBps > config.affiliateRewardBps || app.capPeople > config.affiliateCapPeople;
  // Upgrade requested = the user attached socials (auto-enrolled rows have none).
  const upgradeRequested = !!(app.socials.instagram || app.socials.linkedin || app.socials.twitter);
  return json(200, {
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
route("POST", "/v1/web/affiliate/invite", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const email = String(ctx.body?.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "valid email required" });
  if (email.toLowerCase() === String(user.email || "").toLowerCase()) {
    return json(400, { error: "you can't invite your own email" });
  }
  const aff = await repo.getOrCreateAffiliate(user.id);
  const link = `${config.siteUrl}/portal.html?ref=${aff.code}`;
  const invite = await repo.createReferralInvite(user.id, email, aff.code);
  // The invite row above is the onboarding gate and the source of truth: a
  // friend never has to act for the inviter to progress. Delivering the email
  // is best-effort — if the mail provider rejects it (e.g. an unverified
  // sending domain), record it for the admin diag but don't fail the request,
  // or the user is stranded on onboarding behind an "internal error" for an
  // invite that was actually saved.
  let sent = true;
  try {
    await mailer.sendCrewInviteEmail(email, { inviterEmail: user.email, link, rewardPct: config.affiliateRewardBps / 100 });
  } catch (err: any) {
    sent = false;
    console.error("[dwell] crew invite email failed:", err?.message);
    try {
      await pool.query(
        "insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)",
        ["POST", "/v1/web/affiliate/invite", String(err?.message || err), String(err?.stack || "")]
      );
    } catch (_e) { /* logging is best-effort too */ }
  }
  return json(200, { ok: true, sent, invite: { email: invite.email, status: invite.status, createdAt: invite.sent_at } });
});
// Influencer upgrade application: attach socials to request a custom rate /
// uncapped earnings. Keeps the user's active base 10% — no status downgrade.
route("POST", "/v1/web/affiliate/apply", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const parsed = parseAffiliateSocials(ctx.body);
  if (parsed.error) return json(400, { error: parsed.error });
  await repo.requestAffiliateUpgrade(user.id, parsed.socials);
  return json(200, { ok: true });
});
route("POST", "/v1/web/affiliate-code", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const code = String(ctx.body?.code || "").trim();
  if (!code) return json(400, { error: "code required" });
  const result = await repo.applyAffiliateCodeForUser(user.id, code);
  if (result.ok) return json(200, { ok: true });
  const msg = ({
    already_affiliated: "your account already has an affiliate code",
    has_referrer: "your account was referred, so an affiliate code can't be added",
    invalid_code: "that affiliate code isn't valid",
  } as any)[result.reason] || "couldn't apply that code";
  return json(400, { error: msg, reason: result.reason });
});
// First-login onboarding survey: which AI models the user uses and where, both
// multi-select. Saved before the refer-a-friend step; clears the needsSurvey gate.
route("POST", "/v1/web/onboarding/survey", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const MODELS = ["claude", "chatgpt", "gemini", "other"];
  const SURFACES = ["browser_chrome", "browser_other", "desktop_app", "cursor", "terminal", "other"];
  const body = ctx.body || {};
  const models = [...new Set((Array.isArray(body.models) ? body.models : []).filter((m: any) => MODELS.includes(m)))];
  const surfaces = [...new Set((Array.isArray(body.surfaces) ? body.surfaces : []).filter((s: any) => SURFACES.includes(s)))];
  if (!models.length || !surfaces.length) return json(400, { error: "select at least one model and one surface" });
  const surfaceOther = surfaces.includes("other") ? (String(body.surfaceOther || "").trim().slice(0, 200) || null) : null;
  await repo.saveOnboardingSurvey(user.id, { models, surfaces, surfaceOther });
  return json(200, { ok: true });
});
// First-login onboarding post: the user confirms they posted the prebuilt DWELL
// note to their X timeline. Self-attested — clears the needsPost gate so the
// dashboard unlocks. Idempotent. Accounts that never post may have their payouts
// delayed or withheld (see terms.html).
route("POST", "/v1/web/onboarding/post", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  await repo.markOnboardingPosted(user.id);
  return json(200, { ok: true });
});
route("POST", "/v1/web/redemptions", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const body = ctx.body || {};
  const plan = GIFT_PLANS[body.plan];
  const months = parseInt(body.months, 10);
  const amountCents = plan ? giftPriceCents(plan.id, months) : null;
  if (!amountCents) return json(400, { error: "plan must be pro/max5x/max20x and months 1/3/6/12" });
  // Tokenomics v2: Claude credits redeem at a BOOST — dwells are worth
  // (1 + boost) of face value on this path, so a $22 credit costs $20.00 of
  // balance at a 10% boost. When redemptionBoostBps is 0, legacy fee-on-top
  // pricing applies.
  const boostBps = config.redemptionBoostBps || 0;
  let feeCents: number, totalCents: number;
  if (boostBps > 0) {
    feeCents = 0;
    totalCents = Math.ceil((amountCents * 10000) / (10000 + boostBps));
  } else {
    feeCents = Math.ceil((amountCents * config.redemptionFeeBps) / 10000);
    totalCents = amountCents + feeCents;
  }
  // Gift cards go only to the account's own email — never a request-supplied
  // address — so a stolen session can't redirect a cash-out to an attacker inbox.
  const recipientEmail = user.email;
  if (!recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) return json(400, { error: "your account needs a verified email to redeem" });
  const balance = await repo.balanceForUser(user.id);
  if (balance.balanceMillicents < totalCents * 1000) return json(403, { error: "insufficient credits", balanceUsd: balance.balanceMillicents / 100000, requiredUsd: totalCents / 100, amountUsd: amountCents / 100, feeUsd: feeCents / 100 });
  const redemptionId = crypto.randomUUID();
  await mailer.sendGiftRedemptionEmail(config.giftFulfillmentEmail, { redemptionId, planName: plan.name, months, amountUsd: amountCents / 100, recipientEmail });
  const recorded = await repo.recordGiftRedemptionForUser({
    id: redemptionId, userId: user.id, plan: plan.id, months, amountCents, feeCents,
    debitCents: totalCents, recipientEmail,
  });
  if (!recorded) return json(409, { error: "insufficient credits" });
  // User-facing emails are best-effort — a mail hiccup must never fail a
  // redemption that's already committed to the ledger.
  try {
    await mailer.sendRedemptionConfirmationEmail(recipientEmail, { planName: plan.name, months, amountUsd: amountCents / 100 });
  } catch (err: any) { console.error("[dwell] redemption confirmation email failed:", err?.message); }
  if (recorded.reward?.referrerEmail) {
    try {
      await mailer.sendReferralRewardEmail(recorded.reward.referrerEmail, { rewardUsd: recorded.reward.rewardMillicents / 100000, link: `${config.siteUrl}/portal.html` });
    } catch (err: any) { console.error("[dwell] referral reward email failed:", err?.message); }
  }
  const after = await repo.balanceForUser(user.id);
  return json(200, { ok: true, redemptionId, plan: plan.id, months, amountUsd: amountCents / 100, feeUsd: feeCents / 100, totalUsd: totalCents / 100, balanceUsd: after.balanceMillicents / 100000, deliveryWindowHours: 48 });
});

// ── web payouts: on-demand cash out (Stripe Connect) ──
// Mirrors the redemption trust model: money out only behind a web session.
// Debit-first — the balance is charged inside a transaction before the Stripe
// transfer fires, and reversed if the transfer fails, so a crash between the
// two can never pay twice. The protocol keeps payoutFeeBps of the gross.
route("POST", "/v1/web/connect/onboard", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  if (!user.email_verified) return json(403, { error: "verify your email first" });
  let accountId = user.stripe_account_id;
  if (!accountId) {
    const account = await stripe.createAccount({ type: "express", email: user.email, capabilities: { transfers: { requested: true } }, business_type: "individual" });
    accountId = account.id;
    await repo.setStripeAccount(user.id, accountId);
  }
  const link = await stripe.createAccountLink({
    account: accountId, type: "account_onboarding",
    refresh_url: `${config.siteUrl}/portal.html?onboarding=retry`,
    return_url: `${config.siteUrl}/portal.html?onboarding=done`,
  });
  return json(200, { onboardingUrl: link.url });
});

route("GET", "/v1/web/payouts", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  const balance = await repo.balanceForUser(user.id);
  return json(200, {
    payoutsEnabled: !!user.payouts_enabled,
    hasStripeAccount: !!user.stripe_account_id,
    stripePayoutsEnabled: config.stripePayoutsEnabled !== false,
    wallet: user.wallet_address || null,
    thresholdUsd: config.payoutThresholdCents / 100,
    payoutFeeBps: config.payoutFeeBps,
    balanceUsd: balance.balanceMillicents / 100000,
    payouts: await repo.payoutsForUser(user.id),
  });
});

// One attempt per user per minute, in-process. Belt-and-braces only (edge
// isolates don't share this map) — the debit-first transaction in
// recordPayoutRequest is the real double-spend guard.
// Tokenomics v2: the payout rail. Debit-first, 10% fee, $10 minimum; the
// payouts row is queued 'pending' with the linked wallet as destination and a
// licensed partner executes the USDC transfer (ops marks it paid with the
// transfer signature). The company never holds or transmits the funds itself.
const lastUsdcPayoutAttempt = new Map<string, number>();
route("POST", "/v1/web/payouts/usdc", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  if (!user.wallet_address) return json(403, { error: "link a Solana wallet first" });
  const last = lastUsdcPayoutAttempt.get(user.id) || 0;
  if (Date.now() - last < 60000) return json(429, { error: "try again in a minute" });
  lastUsdcPayoutAttempt.set(user.id, Date.now());

  const balance = await repo.balanceForUser(user.id);
  const grossCents = Math.floor(balance.balanceMillicents / 1000); // pay whole cents only
  if (grossCents < config.payoutThresholdCents) {
    return json(403, {
      error: "balance below payout threshold",
      thresholdUsd: config.payoutThresholdCents / 100,
      balanceUsd: balance.balanceMillicents / 100000,
    });
  }
  const feeCents = Math.ceil((grossCents * config.payoutFeeBps) / 10000);
  const netCents = grossCents - feeCents;
  if (netCents <= 0) return json(403, { error: "balance too small to pay out" });

  const requested = await repo.recordPayoutRequest({
    userId: user.id, grossCents, feeCents, method: "usdc", destination: user.wallet_address,
  });
  if (!requested) return json(409, { error: "insufficient credits" });

  const after = await repo.balanceForUser(user.id);
  return json(200, {
    ok: true,
    queued: true,
    grossUsd: grossCents / 100,
    feeUsd: feeCents / 100,
    netUsd: netCents / 100,
    destination: user.wallet_address,
    balanceUsd: after.balanceMillicents / 100000,
  });
});

// Ops queue for the partner-executed transfers.
route("GET", "/v1/admin/payouts/usdc", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { payouts: await repo.pendingUsdcPayouts() });
});
route("POST", "/v1/admin/payouts/usdc/:id/paid", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const sig = String(ctx.body?.txSignature || "").trim();
  if (!sig) return json(400, { error: "txSignature required" });
  const ok = await repo.markUsdcPayoutPaid(ctx.params.id, sig);
  if (!ok) return json(404, { error: "no pending usdc payout with that id" });
  return json(200, { ok: true });
});

const lastPayoutAttempt = new Map<string, number>();
route("POST", "/v1/web/payouts/request", async (ctx: any) => {
  const user = await repo.userForSession(sessionFrom(ctx));
  if (!user) return json(401, { error: "not signed in" });
  if (config.stripePayoutsEnabled === false) {
    return json(410, { error: "cash payouts moved to USDC — link a wallet and use the USDC payout" });
  }
  if (!user.stripe_account_id || !user.payouts_enabled) {
    return json(403, { error: "set up payouts with Stripe first" });
  }
  const last = lastPayoutAttempt.get(user.id) || 0;
  if (Date.now() - last < 60000) return json(429, { error: "try again in a minute" });
  lastPayoutAttempt.set(user.id, Date.now());

  const balance = await repo.balanceForUser(user.id);
  const grossCents = Math.floor(balance.balanceMillicents / 1000); // pay whole cents only
  if (grossCents < config.payoutThresholdCents) {
    return json(403, {
      error: "balance below payout threshold",
      thresholdUsd: config.payoutThresholdCents / 100,
      balanceUsd: balance.balanceMillicents / 100000,
    });
  }
  const feeCents = Math.ceil((grossCents * config.payoutFeeBps) / 10000);
  const netCents = grossCents - feeCents;
  if (netCents <= 0) return json(403, { error: "balance too small to pay out" });

  // Manual model: queue the request (funds held) and stop. No transfer fires
  // until an admin approves; the response says nothing about how it's reviewed.
  const requested = await repo.recordPayoutRequest({ userId: user.id, grossCents, feeCents });
  if (!requested) return json(409, { error: "insufficient credits" });

  const after = await repo.balanceForUser(user.id);
  return json(200, {
    ok: true,
    requested: true,
    grossUsd: grossCents / 100,
    feeUsd: feeCents / 100,
    netUsd: netCents / 100,
    balanceUsd: after.balanceMillicents / 100000,
  });
});

// ── moderation ──
route("GET", "/v1/admin/campaigns", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { campaigns: await repo.pendingReviewCampaigns() });
});
// Approve. Card/USDC campaigns activate directly. SOL/$DWELL campaigns held
// their crypto during review — approval executes the hedge: swap the held
// amount to USDC at the acceptance-time rate and fund the campaign with the
// REALIZED USDC (effective CPM/impressions may differ from the checkout
// quote). A failed swap leaves the campaign in pending_swap; approving again
// retries it.
route("POST", "/v1/admin/campaigns/approve", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.approveCampaign(ctx.body?.campaignId);
  if (!result) return json(404, { ok: false });

  let swapExtras: any = {};
  let impressionsTotal = (result as any).impressionsTotal;
  if ((result as any).needsSwap) {
    if (!config.treasurySignerSecret) {
      return json(409, { ok: false, retryable: true, error: "TREASURY_SIGNER_SECRET isn't configured — the held funds can't be swapped; campaign stays pending_swap" });
    }
    let swap: any;
    try {
      swap = await executeTreasurySwap({
        payCurrency: (result as any).order.pay_currency,
        amountRaw: String((result as any).order.received_amount_raw),
      });
    } catch (err: any) {
      console.error("[dwell] acceptance hedge swap failed:", err?.message);
      return json(502, { ok: false, retryable: true, error: "swap failed — campaign stays pending_swap; approve again to retry" });
    }
    const fin = await repo.finalizeAcceptedSwap({
      orderId: (result as any).order.id,
      swapSignature: swap.signature,
      realizedMicroUsdc: swap.realizedMicroUsdc,
      tokenSplit,
      dwellPayBoostBps: config.dwellPayBoostBps,
    });
    impressionsTotal = fin ? fin.impressionsTotal : impressionsTotal;
    swapExtras = {
      settlement: "usdc-at-acceptance",
      swapSignature: swap.signature,
      realizedUsdc: Number(swap.realizedMicroUsdc) / 1e6,
      impressionsTotal,
      budgetCents: fin ? fin.budgetCents : null,
    };
  }
  // Tell the advertiser their ad is live. Wrapped so a mail failure never
  // fails the approval (already committed above).
  try {
    await mailer.sendCampaignLiveEmail((result as any).email, {
      campaignId: ctx.body?.campaignId,
      brand: (result as any).brand,
      adLine: (result as any).adLine,
      impressionsTotal,
    });
  } catch (err: any) {
    console.error("[dwell] live email failed:", err.message);
  }
  return json(200, { ok: true, ...swapExtras });
});
// Retry the on-chain refund for a rejected crypto campaign whose held funds
// didn't go back at reject time (RPC hiccup, missing $DWELL account, or the
// signer wasn't configured yet).
route("POST", "/v1/admin/orders/refund", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const order = await repo.getRefundableOrder(ctx.body?.orderId);
  if (!order) return json(404, { ok: false, error: "no refundable order (must be a held SOL/$DWELL order on a rejected campaign)" });
  try {
    const r = await executeRefund({
      payCurrency: order.pay_currency,
      destination: order.payer_address,
      amountRaw: String(order.received_amount_raw),
    });
    await repo.markOrderRefunded(order.id, r.signature);
    return json(200, { ok: true, refundSignature: r.signature });
  } catch (err: any) {
    console.error("[dwell] refund retry failed:", err?.message);
    return json(502, { ok: false, retryable: true, error: err?.message || "refund failed" });
  }
});
route("POST", "/v1/admin/campaigns/reject", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.rejectCampaign(ctx.body?.campaignId, ctx.body?.note);
  if (!result) return json(404, { ok: false });
  if (result.paymentIntentId) {
    try { await stripe.createRefund({ payment_intent: result.paymentIntentId }); }
    catch (err: any) { console.error("[dwell] refund failed:", err.message); }
  }
  // Held SOL/$DWELL goes back in-kind on-chain. Two-phase: the campaign is
  // already rejected; the order stays 'confirmed' until the refund lands, so
  // a failure here is visible and retryable via /v1/admin/orders/refund.
  let cryptoRefundSignature: string | null = null, cryptoRefundError: string | null = null;
  if ((result as any).heldOrder) {
    const held = (result as any).heldOrder;
    try {
      const r = await executeRefund({
        payCurrency: held.pay_currency,
        destination: held.payer_address,
        amountRaw: String(held.received_amount_raw),
      });
      await repo.markOrderRefunded(held.id, r.signature);
      cryptoRefundSignature = r.signature;
    } catch (err: any) {
      console.error("[dwell] crypto refund failed (retry via /v1/admin/orders/refund):", err?.message);
      cryptoRefundError = err?.message || "refund failed";
    }
  }
  // Tell the advertiser their campaign was rejected + refunded. Wrapped so a
  // mail failure never fails the moderation action (already committed above).
  try {
    await mailer.sendCampaignRejectedEmail((result as any).email, {
      campaignId: ctx.body?.campaignId,
      brand: (result as any).brand,
      adLine: (result as any).adLine,
      budgetCents: (result as any).budgetCents,
      note: (result as any).note,
    });
  } catch (err: any) {
    console.error("[dwell] rejection email failed:", err.message);
  }
  return json(200, {
    ok: true,
    refunded: !!result.paymentIntentId || !!cryptoRefundSignature,
    ...((result as any).heldOrder ? {
      orderId: (result as any).heldOrder.id,
      refundSignature: cryptoRefundSignature,
      ...(cryptoRefundError ? { refundError: cryptoRefundError, retryable: true } : {}),
    } : {}),
  });
});
// ── affiliate review ──
route("GET", "/v1/admin/affiliates", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { affiliates: await repo.listAffiliateApplications() });
});
route("POST", "/v1/admin/affiliates/approve", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.approveAffiliate(ctx.body?.affiliateId);
  return json(result ? 200 : 404, result ? { ok: true, code: result.code } : { ok: false });
});
route("POST", "/v1/admin/affiliates/reject", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.rejectAffiliate(ctx.body?.affiliateId, ctx.body?.note);
  return json(result ? 200 : 404, { ok: !!result });
});
route("POST", "/v1/admin/affiliates/grant", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const b = ctx.body || {};
  const rewardBps = Number(b.rewardBps);
  const capPeople = Number(b.capPeople);
  if (!Number.isInteger(rewardBps) || rewardBps < 1 || rewardBps > 10000) return json(400, { error: "rewardBps must be 1–10000 (0.01%–100%)" });
  if (!Number.isInteger(capPeople) || capPeople < 0) return json(400, { error: "capPeople must be a whole number ≥ 0" });
  const result = await repo.grantAffiliateUpgrade(b.affiliateId, { rewardBps, capPeople, code: b.code });
  return json(result.ok ? 200 : (result.error === "not found" ? 404 : 400), result);
});
route("GET", "/admin", async (ctx: any) => {
  if (!adminOk(ctx)) return htmlResp(401, "<h1>401</h1><p>Append ?adminKey=…</p>");
  const list = await repo.pendingReviewCampaigns();
  const rows = list.map((c: any) => `
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
  return htmlResp(200, `<!doctype html><meta charset=utf-8><title>DWELL moderation</title>
<style>body{font:14px system-ui;margin:40px;max-width:900px}table{width:100%;border-collapse:collapse}
td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}.line{font-family:monospace}
button{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
button.rej{border-color:#e33;color:#e33}h1{font-size:20px}</style>
<h1>Pending review (${list.length})</h1>
<table><tr><th>Brand</th><th>Ad line</th><th>URL</th><th>Bid</th><th></th></tr>${rows || '<tr><td colspan=5>Nothing to review 🎉</td></tr>'}</table>
<script>
const KEY=${JSON.stringify(ctx.query.get("adminKey") || "")};
const API=${JSON.stringify(config.apiBaseUrl)};
async function act(kind,id){
  const note = kind==='reject' ? prompt('Reason (optional):') || '' : '';
  await fetch(API+'/v1/admin/campaigns/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminKey:KEY,campaignId:id,note})});
  location.reload();
}
</script>`);
});

// ── killswitch & payouts ──
route("POST", "/v1/admin/killswitch", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.serving !== "boolean") return json(400, { error: "serving (boolean) required" });
  serving = ctx.body.serving;
  servingSyncedAt = Date.now();
  try { await repo.setSetting("serving", serving); } // persist across isolates
  catch (err: any) { console.error("[dwell] killswitch persist failed:", err?.message); }
  return json(200, { ok: true, serving });
});
route("POST", "/v1/admin/earnings-killswitch", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.enabled !== "boolean") return json(400, { error: "enabled (boolean) required" });
  earningsEnabled = ctx.body.enabled;
  servingSyncedAt = Date.now();
  try { await repo.setSetting("earnings_enabled", earningsEnabled); } // persist across isolates
  catch (err: any) { console.error("[dwell] earnings killswitch persist failed:", err?.message); }
  return json(200, { ok: true, earningsEnabled });
});
route("POST", "/v1/admin/payouts", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, await runPayouts());
});

// ── manual payout approval (admin) ──
route("GET", "/v1/admin/payouts/requests", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.listPayoutRequests();
  return json(200, { requests: rows.map(payoutRequestView) });
});
route("POST", "/v1/admin/payouts/verify-post", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const u = await repo.userForAdmin(ctx.body?.userId);
  if (!u) return json(404, { error: "user not found" });
  return json(200, await verifyOnboardingPost(u));
});
route("POST", "/v1/admin/payouts/requests/approve", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const claimed = await repo.claimPayoutRequest(ctx.body?.payoutId);
  if (!claimed) return json(409, { error: "request not found or already handled" });
  if (!claimed.stripeAccountId || !claimed.payoutsEnabled) {
    await repo.releasePayoutClaim(claimed.id);
    return json(409, { error: "user has no active Stripe payouts account" });
  }
  try {
    const transfer = await stripe.createTransfer({
      amount: claimed.netCents, currency: "usd", destination: claimed.stripeAccountId,
      transfer_group: `payout_${claimed.userId}_${claimed.id}`,
    });
    await repo.finalizePayout(claimed.id, { transferId: transfer.id });
  } catch (err: any) {
    console.error("[dwell] payout approve transfer failed:", err?.message);
    await repo.finalizePayout(claimed.id, { failed: true, userId: claimed.userId, grossCents: claimed.grossCents, feeCents: claimed.feeCents });
    return json(502, { error: "transfer failed — the request was reversed and the balance restored" });
  }
  return json(200, { ok: true, netUsd: claimed.netCents / 100 });
});
route("POST", "/v1/admin/payouts/requests/reject", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rejected = await repo.rejectPayoutRequest(ctx.body?.payoutId);
  if (!rejected) return json(409, { error: "request not found or already handled" });
  return json(200, { ok: true, restoredUsd: rejected.grossCents / 100 });
});

// ── advertiser pricing (min / suggested / top-bid anchor) ──
route("GET", "/v1/admin/pricing", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const pricing = await repo.getPricing();
  return json(200, { ...pricing, topActiveBidCents: await repo.topActiveBidCents() });
});
route("POST", "/v1/admin/pricing", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const cur = await repo.getPricing();
  const b = ctx.body || {};
  const pick = (n: any, d: number) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : d);
  const minCpmCents = Math.max(50, pick(b.minCpmCents, cur.minCpmCents));
  const maxCpmCents = Math.max(minCpmCents, pick(b.maxCpmCents, cur.maxCpmCents));
  const minBudgetCents = Math.max(50, pick(b.minBudgetCents, cur.minBudgetCents));
  const next = {
    minCpmCents,
    suggestedCpmCents: Math.max(minCpmCents, pick(b.suggestedCpmCents, cur.suggestedCpmCents)),
    maxCpmCents,
    topCpmAnchorCents: Math.min(maxCpmCents, Math.max(0, pick(b.topCpmAnchorCents, cur.topCpmAnchorCents))),
    minBudgetCents,
    suggestedBudgetCents: pick(b.suggestedBudgetCents, cur.suggestedBudgetCents),
    maxBudgetCents: Math.max(minBudgetCents, pick(b.maxBudgetCents, cur.maxBudgetCents)),
  };
  await repo.setPricing(next);
  return json(200, next);
});

// ── admin dashboard (read + management) ──
// Money helpers: ledger is millicents, gift_redemptions is cents.
const mcUsd = (v: any) => Number(v || 0) / 100000;
const cUsd = (v: any) => Number(v || 0) / 100;
// Realized per-campaign/advertiser metrics from raw ledger sums. eCPM/CTR use
// impressions *shown* (impression_credit.meta.billed), never budget units — a
// clicks no longer bill (recorded as a zero-value click_event); spend is impression
// money, and clicks are counted separately for CTR/CPC.
const adMetrics = (spendMc: any, impressionsShown: any, clicks: any) => {
  const spendUsd = mcUsd(spendMc), imp = Number(impressionsShown || 0), clk = Number(clicks || 0);
  return { spendUsd, impressionsShown: imp, clicks: clk,
    ctr: imp > 0 ? clk / imp : null,
    cpcUsd: clk > 0 ? spendUsd / clk : null,
    ecpmUsd: imp > 0 ? (spendUsd / imp) * 1000 : null };
};
// Advertiser-facing receipt stats for one campaignReceiptData row. Total spent =
// budget_cents when present (budget+CPM campaigns), else legacy price*blocks.
const receiptStats = (row: any) => {
  const m = adMetrics(row.recognized_millicents, row.impressions_shown, row.clicks);
  const totalPaidUsd = row.budget_cents != null
    ? Number(row.budget_cents) / 100
    : (Number(row.price_per_block_cents) * Number(row.blocks)) / 100;
  return { campaignId: row.id, brand: row.brand, adLine: row.ad_line, url: row.url, status: row.status,
    impressionsShown: m.impressionsShown, clicks: m.clicks, ctr: m.ctr, cpcUsd: m.cpcUsd, ecpmUsd: m.ecpmUsd,
    spendUsd: m.spendUsd, totalPaidUsd, impressionsTotal: Number(row.impressions_total),
    advertiserEmail: row.advertiser_email, completionEmailSentAt: row.completion_email_sent_at,
    createdAt: row.created_at, activatedAt: row.activated_at };
};

route("GET", "/v1/admin/overview", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const o = await repo.adminOverview();
  const m = o.money, t = o.moneyTest;
  return json(200, {
    revenue: {
      // "Real" = backed by an actual Stripe charge. Test/seed-funded campaigns
      // (paid_at set but no stripe_payment_intent_id) are subtracted out here
      // and broken out separately below, so this never blends fake money into
      // what looks like real advertiser revenue.
      adsPurchasedUsd: mcUsd(m.campaign_credit - t.campaign_credit),
      refundedUsd: -mcUsd(m.campaign_refund),
      platformFeeUsd: mcUsd(m.platform_fee - t.platform_fee),
      developerCreditUsd: mcUsd(m.dev_credit),
      referralCreditUsd: mcUsd(m.referral_credit),
      affiliateCreditUsd: mcUsd(m.affiliate_credit),
      paidOutUsd: -mcUsd(m.payout_debit),
      redeemedUsd: -mcUsd(m.redemption_debit),
      adminAdjustUsd: mcUsd(m.admin_adjust),
      outstandingLiabilityUsd: mcUsd(m.liability - t.liability),
    },
    testMoney: {
      adsPurchasedUsd: mcUsd(t.campaign_credit),
      platformFeeUsd: mcUsd(t.platform_fee),
      liabilityUsd: mcUsd(t.liability),
      campaigns: o.testCampaigns.map((c: any) => ({
        id: c.id, brand: c.brand, budgetUsd: cUsd(c.budget_cents), status: c.status, paidAt: c.paid_at,
      })),
    },
    counts: o.counts,
    campaignsByStatus: o.campaignsByStatus,
    pendingRedemptionsUsd: cUsd(o.counts.redemptions_pending_cents),
    serving,
    earningsEnabled,
  });
});

route("GET", "/v1/admin/metrics/daily", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const days = parseInt(ctx.query.get("days") || "30", 10);
  const raw = await repo.adminDailyMetrics(days);
  const key = (d: any) => new Date(d).toISOString().slice(0, 10);
  const map = new Map<string, any>();
  const ensure = (k: string) => {
    if (!map.has(k)) map.set(k, { date: k, impressions: 0, clicks: 0, adsPurchasedUsd: 0, platformFeeUsd: 0, developerCreditUsd: 0, recognizedUsd: 0, effectiveCpmUsd: 0, newUsers: 0, newDevices: 0, redemptions: 0, redemptionsUsd: 0 });
    return map.get(k);
  };
  for (const r of raw.events) { const o = ensure(key(r.d)); o.impressions = Number(r.imp); o.clicks = Number(r.clk); }
  for (const r of raw.ledger) { const o = ensure(key(r.d)); o.adsPurchasedUsd = mcUsd(r.bought); o.platformFeeUsd = mcUsd(r.fee); o.developerCreditUsd = mcUsd(r.dev); o.recognizedUsd = mcUsd(r.dev) + mcUsd(r.fee); }
  for (const r of raw.users) { ensure(key(r.d)).newUsers = Number(r.n); }
  for (const r of raw.devices) { ensure(key(r.d)).newDevices = Number(r.n); }
  for (const r of raw.redemptions) { const o = ensure(key(r.d)); o.redemptions = Number(r.n); o.redemptionsUsd = cUsd(r.cents); }
  // Fill the full window so every day shows, even with no activity.
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const series: any[] = [];
  for (let i = raw.days - 1; i >= 0; i--) {
    const dt = new Date(today); dt.setUTCDate(dt.getUTCDate() - i);
    const o = ensure(dt.toISOString().slice(0, 10));
    o.effectiveCpmUsd = o.impressions > 0 ? (o.recognizedUsd / o.impressions) * 1000 : 0;
    series.push(o);
  }
  return json(200, { days: raw.days, series });
});

route("GET", "/v1/admin/campaigns/all", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  try { await repo.expireStalePendingPayments(); } // best-effort lazy sweep; never block the list on it
  catch (err: any) { console.error("[dwell] expireStalePendingPayments failed:", err?.message); }
  const rows = await repo.adminCampaigns({
    status: ctx.query.get("status") || null,
    limit: ctx.query.get("limit"), offset: ctx.query.get("offset"),
  });
  return json(200, { campaigns: rows.map((c: any) => {
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
route("GET", "/v1/admin/advertisers", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminAdvertisers({ limit: ctx.query.get("limit"), offset: ctx.query.get("offset") });
  return json(200, { advertisers: rows.map((a: any) => {
    const m = adMetrics(a.spend_millicents, a.impressions_shown, a.clicks);
    return { id: a.id, email: a.email, createdAt: a.created_at,
      campaigns: Number(a.campaigns), activeCampaigns: Number(a.active_campaigns),
      spendUsd: m.spendUsd, impressionsShown: m.impressionsShown, clicks: m.clicks,
      ctr: m.ctr, cpcUsd: m.cpcUsd, ecpmUsd: m.ecpmUsd };
  }) });
});

// Transactions view: crypto orders (DB, every rail + status) merged with card
// charges (pulled live from Stripe). Independent rails — a Stripe outage must
// never blank the crypto side — so the card fetch is best-effort.
route("GET", "/v1/admin/transactions", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const limit = ctx.query.get("limit");

  // Each rail is fetched independently and its failure is confined to its own
  // table — one broken rail must never blank the whole transactions view. (A
  // missing usdc_orders column once 500'd the entire page; see the
  // usdc_orders_payment_verifier_columns migration.)
  const realEmail = (e: any) => (e && !e.endsWith("@wallet.invalid") ? e : null);
  let cryptoTx: any[] = [], cryptoError: string | null = null;
  try {
    const orders = await repo.listCryptoOrders({ limit, status: ctx.query.get("status") || null });
    cryptoTx = orders.map((o: any) => ({
      id: o.id, rail: o.pay_currency, status: o.status, failReason: o.fail_reason,
      priceUsd: Number(o.price_micro_usdc) / 1e6,
      payTotalUnits: o.pay_total_units, payFeeUnits: o.pay_fee_units,
      reference: o.reference_pubkey, txSignature: o.tx_signature,
      brand: o.brand, adLine: o.ad_line, advertiserEmail: realEmail(o.advertiser_email),
      createdAt: o.created_at, expiresAt: o.expires_at,
    }));
  } catch (err: any) {
    cryptoError = "couldn't load crypto orders: " + (err?.message || "unknown error");
  }

  const stripeLive = !!config.stripeSecretKey && config.stripeSecretKey !== "sk_test_devnet";
  let card: any[] = [], cardError: string | null = null;
  if (stripeLive) {
    try {
      const charges = await stripe.listCharges({ limit: parseInt(limit, 10) || 25 });
      card = (charges.data || []).map((ch: any) => ({
        id: ch.id, amountUsd: (ch.amount || 0) / 100, currency: ch.currency,
        status: ch.status, refunded: !!ch.refunded,
        brand: ch.payment_method_details?.card?.brand || null,
        last4: ch.payment_method_details?.card?.last4 || null,
        email: ch.billing_details?.email || ch.receipt_email || null,
        receiptUrl: ch.receipt_url || null,
        campaignId: ch.metadata?.campaign_id || null,
        createdAt: ch.created ? new Date(ch.created * 1000).toISOString() : null,
      }));
    } catch (err: any) {
      cardError = "couldn't reach Stripe: " + (err?.message || "unknown error");
    }
  }
  return json(200, { crypto: cryptoTx, cryptoError, card, cardError, stripeLive });
});

// ── completion-receipt preview (no stamp) + manual once-only send (+ force resend) ──
route("GET", "/v1/admin/campaigns/receipt-preview", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const row = await repo.campaignReceiptData(ctx.query.get("campaignId"));
  if (!row) return json(404, { error: "campaign not found" });
  const stats = receiptStats(row);
  const { subject, html } = mailer.buildCampaignCompletedEmail(stats);
  return json(200, { subject, html, stats, alreadySent: !!row.completion_email_sent_at });
});
route("POST", "/v1/admin/campaigns/send-receipt", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const campaignId = ctx.body?.campaignId;
  const row = await repo.campaignReceiptData(campaignId);
  if (!row) return json(404, { error: "campaign not found" });
  if (row.status !== "exhausted") return json(400, { error: "campaign not finished" });
  if (ctx.body?.force) await repo.clearCampaignReceipt(campaignId);
  const claim = await repo.claimCampaignReceipt(campaignId);
  if (!claim) return json(200, { ok: true, alreadySent: true });
  try {
    await mailer.sendCampaignCompletedEmail(row.advertiser_email, receiptStats(row));
  } catch (err) {
    await repo.clearCampaignReceipt(campaignId); // roll back so the admin can retry
    return json(502, { error: "send failed" });
  }
  return json(200, { ok: true, sentAt: claim.sentAt });
});

// ── auto-send toggle + batched sweep (a no-op while off unless { force:true }) ──
// Public "Live bid market" leaderboard visibility (off by default).
route("GET", "/v1/admin/leaderboard-visibility", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  let isPublic = false;
  try { isPublic = (await repo.getSetting("leaderboard_public")) === true; } catch { /* settings absent */ }
  return json(200, { public: isPublic });
});
route("POST", "/v1/admin/leaderboard-visibility", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.public !== "boolean") return json(400, { error: "public (boolean) required" });
  await repo.setSetting("leaderboard_public", ctx.body.public);
  leaderboardPublic = ctx.body.public;
  servingSyncedAt = Date.now(); // reflect immediately in /v1/config without waiting on the sync window
  return json(200, { ok: true, public: ctx.body.public });
});
// Whether the CPM slider's "top bid" ghost tracks the live marketplace top (off by default).
route("GET", "/v1/admin/live-top-cpm", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  let enabled = false;
  try { enabled = (await repo.getSetting("live_top_cpm")) === true; } catch { /* settings absent */ }
  return json(200, { enabled });
});
route("POST", "/v1/admin/live-top-cpm", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.enabled !== "boolean") return json(400, { error: "enabled (boolean) required" });
  await repo.setSetting("live_top_cpm", ctx.body.enabled);
  liveTopCpm = ctx.body.enabled;
  servingSyncedAt = Date.now(); // reflect immediately in /v1/config without waiting on the sync window
  return json(200, { ok: true, enabled: ctx.body.enabled });
});
// Whether the portal shows the "Not serving ads until after launch." banner (off by default).
route("GET", "/v1/admin/ad-notice", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  let visible = false;
  try { visible = (await repo.getSetting("ad_notice_visible")) === true; } catch { /* settings absent */ }
  return json(200, { visible });
});
route("POST", "/v1/admin/ad-notice", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.visible !== "boolean") return json(400, { error: "visible (boolean) required" });
  await repo.setSetting("ad_notice_visible", ctx.body.visible);
  adNoticeVisible = ctx.body.visible;
  servingSyncedAt = Date.now(); // reflect immediately in /v1/config without waiting on the sync window
  return json(200, { ok: true, visible: ctx.body.visible });
});
// Whether clients show the non-billable house ad when the auction is empty (ON by default).
route("GET", "/v1/admin/house-ad", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  let enabled = true;
  try { enabled = (await repo.getSetting("house_ad_enabled")) !== false; } catch { /* settings absent → default on */ }
  return json(200, { enabled });
});
route("POST", "/v1/admin/house-ad", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.enabled !== "boolean") return json(400, { error: "enabled (boolean) required" });
  await repo.setSetting("house_ad_enabled", ctx.body.enabled);
  houseAdEnabled = ctx.body.enabled;
  servingSyncedAt = Date.now(); // reflect immediately in /v1/config without waiting on the sync window
  return json(200, { ok: true, enabled: ctx.body.enabled });
});
route("GET", "/v1/admin/campaigns/receipts-auto", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  let enabled = false;
  try { enabled = (await repo.getSetting("receipts_auto_send")) === true; } catch { /* settings absent */ }
  return json(200, { enabled });
});
route("POST", "/v1/admin/campaigns/receipts-auto", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  if (typeof ctx.body?.enabled !== "boolean") return json(400, { error: "enabled (boolean) required" });
  await repo.setSetting("receipts_auto_send", ctx.body.enabled);
  return json(200, { enabled: ctx.body.enabled });
});
route("POST", "/v1/admin/campaigns/receipts-sweep", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  let enabled = false;
  try { enabled = (await repo.getSetting("receipts_auto_send")) === true; } catch { /* settings absent */ }
  if (!enabled && !ctx.body?.force) return json(200, { enabled: false, sent: 0, candidates: 0 });
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
      console.error("[dwell] receipt sweep send failed", err);
    }
  }
  return json(200, { enabled: true, sent, failed, candidates: ids.length });
});
route("POST", "/v1/admin/campaigns/cancel", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const ok = await repo.cancelCampaign(ctx.body?.campaignId);
  return json(ok ? 200 : 404, { ok });
});

route("GET", "/v1/admin/redemptions", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminRedemptions({ status: ctx.query.get("status") || null, limit: ctx.query.get("limit") });
  return json(200, { redemptions: rows.map((r: any) => ({
    id: r.id, plan: GIFT_PLANS[r.plan]?.name || r.plan, planId: r.plan, months: r.months,
    amountUsd: r.amount_cents / 100, recipientEmail: r.recipient_email, userEmail: r.user_email,
    status: r.status, createdAt: r.created_at,
  })) });
});
route("POST", "/v1/admin/redemptions/status", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const result = await repo.setRedemptionStatus(ctx.body?.id, ctx.body?.status, !!ctx.body?.refund);
  if (!result) return json(400, { ok: false, error: "invalid id or status" });
  return json(200, { ok: true, status: result.status, refunded: result.refunded });
});

route("GET", "/v1/admin/users", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminUsers({ search: ctx.query.get("search") || null, limit: ctx.query.get("limit"), offset: ctx.query.get("offset") });
  return json(200, { users: rows.map((u: any) => ({
    id: u.id, email: u.email, emailVerified: u.email_verified, payoutsEnabled: u.payouts_enabled,
    stripeLinked: !!u.stripe_account_id, referralCode: u.referral_code, referredBy: u.referred_by,
    devices: u.devices, balanceUsd: mcUsd(u.balance_millicents), earnedUsd: mcUsd(u.earned_millicents), createdAt: u.created_at,
  })) });
});

route("GET", "/v1/admin/emails", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminEmails();
  if ((ctx.query.get("format") || "") === "csv") {
    const esc = (s: any) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const body = ["email,source,created_at", ...rows.map((r: any) => [esc(r.email), esc(r.source), esc(r.created_at)].join(","))].join("\n");
    return new Response(body, { status: 200, headers: { ...CORS, "Access-Control-Allow-Origin": resolveOrigin(ctx.req), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="dwell-emails.csv"' } });
  }
  return json(200, { emails: rows });
});

route("GET", "/v1/admin/income", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminIncome();
  return json(200, { byType: rows.map((r: any) => ({ entryType: r.entry_type, count: r.n, totalUsd: mcUsd(r.total) })) });
});

route("GET", "/v1/admin/payouts", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const list = await repo.adminPayoutsList();
  const payable = await repo.payableUsers(config.payoutThresholdCents * 1000);
  return json(200, {
    payouts: list.map((p: any) => ({ id: p.id, email: p.email, userId: p.user_id, amountUsd: p.amount_cents / 100, status: p.status, transferId: p.stripe_transfer_id, createdAt: p.created_at })),
    payable: { count: payable.length, totalUsd: payable.reduce((s: number, u: any) => s + u.balance / 100000, 0), thresholdUsd: config.payoutThresholdCents / 100 },
  });
});

route("GET", "/v1/admin/referrals", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const r = await repo.adminReferrals();
  return json(200, {
    byStatus: r.byStatus.map((s: any) => ({ status: s.status, count: s.n, rewardUsd: mcUsd(s.reward) })),
    top: r.top.map((t: any) => ({ email: t.email, userId: t.referrer_user_id, referred: t.referred, rewarded: t.rewarded, rewardUsd: mcUsd(t.reward_millicents) })),
  });
});

route("GET", "/v1/admin/devices", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const d = await repo.adminDevices(config.dailyImpressionCap, config.dailyClickCap);
  return json(200, {
    totals: d.totals,
    caps: { dailyImpressionCap: config.dailyImpressionCap, dailyClickCap: config.dailyClickCap },
    heavyDevices: d.heavyDevices.map((x: any) => ({ deviceId: x.device_id, impressions: Number(x.imp), clicks: Number(x.clk) })),
    heavyIps: d.heavyIps.map((x: any) => ({ ipHash: x.ip_hash, devices: x.devices, impressions: Number(x.imp) })),
  });
});

route("GET", "/v1/admin/schema", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, { tables: await repo.adminSchema() });
});

route("POST", "/v1/admin/ledger/adjust", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const id = await repo.adminLedgerAdjust({
    userId: ctx.body?.userId || null, deviceId: ctx.body?.deviceId || null,
    amountCents: ctx.body?.amountCents, direction: ctx.body?.direction, note: ctx.body?.note,
  });
  if (!id) return json(400, { ok: false, error: "need userId or deviceId, a non-zero amountCents, and direction credit|debit" });
  return json(200, { ok: true, ledgerId: id });
});

route("GET", "/v1/admin/invites", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const d = await repo.adminInvites();
  return json(200, {
    byStatus: d.byStatus.map((s: any) => ({ status: s.status, count: s.n })),
    invites: d.recent.map((r: any) => ({
      email: r.email, status: r.status, code: r.code, referrerEmail: r.referrer_email,
      createdAt: r.created_at, sentAt: r.sent_at, joinedAt: r.joined_at, rewardedAt: r.rewarded_at,
    })),
  });
});

// Read-only view of the economic knobs that drive the marketplace + gift catalog.
route("GET", "/v1/admin/config", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  return json(200, {
    revenueSharePct: displayRevenueShare * 100,
    grossCpmUsd: config.grossCpmCents / 100,
    dailyImpressionCap: config.dailyImpressionCap,
    ipDailyImpressionCap: config.ipDailyImpressionCap,
    dailyClickCap: config.dailyClickCap,
    payoutThresholdUsd: config.payoutThresholdCents / 100,
    referralRewardUsd: config.referralRewardCents / 100,
    referralCap: config.referralCap,
    affiliateRewardPct: config.affiliateRewardBps / 100,
    affiliateCapPeople: config.affiliateCapPeople,
    giftFulfillmentEmail: config.giftFulfillmentEmail,
    giftPlans: Object.values(GIFT_PLANS).map((p: any) => ({ id: p.id, name: p.name, monthlyUsd: p.monthlyCents / 100 })),
    serving,
  });
});

route("GET", "/v1/admin/waitlist", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const d = await repo.adminWaitlist();
  return json(200, {
    bySurface: d.bySurface.map((s: any) => ({ surface: s.surface, label: s.label, count: s.n })),
    signups: d.recent.map((r: any) => ({ surface: r.surface, email: r.email, createdAt: r.created_at })),
  });
});

route("GET", "/v1/admin/errors", async (ctx: any) => {
  if (!adminOk(ctx)) return json(401, { error: "bad admin key" });
  const rows = await repo.adminErrors();
  return json(200, { errors: rows.map((r: any) => ({ id: String(r.id), method: r.method, path: r.path, message: r.message, createdAt: r.created_at })) });
});

// ─────────────────────────────── dispatch ──────────────────────────────────
function stripPrefix(pathname: string) {
  let path = pathname.replace(/^\/functions\/v1/, ""); // defensive: platform prefix
  path = path.replace(/^\/dwell-api(?=\/|$)/, "");      // our function slug
  return path === "" ? "/" : path;
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const allowOrigin = resolveOrigin(req);
  // Stamp the per-request allowed origin onto every response we return.
  const withCors = (res: Response) => {
    res.headers.set("Access-Control-Allow-Origin", allowOrigin);
    res.headers.set("Vary", "Origin");
    return res;
  };
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Origin": allowOrigin, "Vary": "Origin" } });
  }

  const url = new URL(req.url);
  const path = stripPrefix(url.pathname);

  let handler = exact.get(`${req.method} ${path}`);
  const params: any = {};
  if (!handler) {
    for (const r of paramRoutes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.regex);
      if (m) { handler = r.handler; r.keys.forEach((k: string, i: number) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
    }
  }
  if (!handler) return withCors(json(404, { error: "not found" }));

  // read + size-cap the body
  const rawBody = await req.text();
  if (rawBody && Buffer.byteLength(rawBody) > config.maxBodyBytes) return withCors(json(413, { error: "payload too large" }));
  let body: any = null;
  if (rawBody) { try { body = JSON.parse(rawBody); } catch { return withCors(json(400, { error: "invalid json" })); } }

  const ctx = { req, headers: req.headers, body, rawBody, query: url.searchParams, params };
  try {
    return withCors(await handler(ctx));
  } catch (err: any) {
    console.error(`[dwell] ${req.method} ${path} failed:`, err?.message);
    // Best-effort: persist the failure for the admin dashboard. Never let
    // logging break the error response.
    try { await pool.query("insert into diag_errors (method, path, message, stack) values ($1,$2,$3,$4)", [req.method, path, String(err?.message || err), String(err?.stack || "")]); } catch (_e) { /* ignore */ }
    return withCors(json(500, { error: "internal error" }));
  } finally {
    console.log(`[dwell] ${req.method} ${path} ${Date.now() - started}ms`);
  }
});
