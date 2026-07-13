// Wires real dependencies from environment config.

const { createRepo } = require("./repo");
const { createStripe } = require("./stripe");
const { createMailer } = require("./mailer");
const { createRateLimiter } = require("./ratelimit");
const { createSolana } = require("./solana");

function loadConfig(env = process.env) {
  const siteUrl = env.SITE_URL || "https://dwellprotocol.com";
  return {
    port: parseInt(env.PORT || "8787", 10),
    databaseUrl: env.DATABASE_URL,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    siteUrl,
    apiBaseUrl: env.API_BASE_URL || `http://localhost:${env.PORT || 8787}`,
    corsOrigin: env.CORS_ORIGIN || siteUrl,
    adminKey: env.ADMIN_KEY,
    killswitch: env.KILLSWITCH === "1", // start with ad serving disabled

    revenueShare: parseFloat(env.REVENUE_SHARE || "0.5"), // user's cut, paid out as Claude credits
    grossCpmCents: parseInt(env.GROSS_CPM_CENTS || "1200", 10),
    dailyImpressionCap: parseInt(env.DAILY_IMPRESSION_CAP || "5000", 10),
    ipDailyImpressionCap: parseInt(env.IP_DAILY_IMPRESSION_CAP || "5000", 10), // per source IP per UTC day; 0 disables (for shared-NAT/CGNAT audiences)
    // Killswitch for the legacy self-reported /v1/events credit path (the open
    // forgery surface — see FORGERY-SURFACE.md). Default on during the client
    // transition; set LEGACY_EVENTS_CREDIT=0 once token-path adoption is high
    // and forged batches credit nothing.
    legacyEventsCredit: env.LEGACY_EVENTS_CREDIT !== "0",
    dailyClickCap: parseInt(env.DAILY_CLICK_CAP || "100", 10), // verified clicks per device per UTC day
    leadDailyCap: parseInt(env.LEAD_IP_DAILY_CAP || "100", 10), // bare-email waitlist captures per source IP per UTC day; 0 disables
    payoutThresholdCents: parseInt(env.PAYOUT_THRESHOLD_CENTS || "10000", 10), // $100
    payoutFeeBps: parseInt(env.PAYOUT_FEE_BPS || "1000", 10), // protocol's cut of a cash payout, basis points (1000 = 10%)
    redemptionFeeBps: parseInt(env.REDEMPTION_FEE_BPS || "1000", 10), // legacy fee-on-top for Claude-credit redemptions; superseded by redemptionBoostBps when set
    redemptionBoostBps: parseInt(env.REDEMPTION_BOOST_BPS || "1000", 10), // tokenomics v2: dwells buy Claude credits at a boost (1000 = your balance is worth 110% on this path); replaces the fee when > 0
    stripePayoutsEnabled: env.STRIPE_PAYOUTS_ENABLED === "true", // tokenomics v2: cash payouts retired in favor of USDC; legacy Stripe rail is opt-in only
    referralRewardCents: parseInt(env.REFERRAL_REWARD_CENTS || "2000", 10), // $20 to the referrer
    referralCap: parseInt(env.REFERRAL_CAP || "10", 10), // max rewarded referrals per user
    affiliateRewardBps: parseInt(env.AFFILIATE_REWARD_BPS || "1000", 10), // affiliate's cut of an affiliated user's earnings, basis points (1000 = 10%)
    affiliateCapPeople: parseInt(env.AFFILIATE_CAP_PEOPLE || "10", 10), // max attributed friends per affiliate (dollar earnings uncapped)
    giftFulfillmentEmail: env.GIFT_FULFILLMENT_EMAIL || "hello@dwellprotocol.com", // manual gift card fulfillment inbox
    emailTokenTtlMs: parseInt(env.EMAIL_TOKEN_TTL_MS || "1800000", 10), // 30 min
    emailCooldownMs: parseInt(env.EMAIL_COOLDOWN_MS || "60000", 10), // min gap between magic-link sends per email; 0 disables
    emailIpDailyCap: parseInt(env.EMAIL_IP_DAILY_CAP || "50", 10), // magic-link/login email sends per source IP per UTC day; 0 disables (shared-NAT/CGNAT)
    webSessionTtlMs: parseInt(env.WEB_SESSION_TTL_MS || "2592000000", 10), // 30 days
    clickTokenTtlMs: parseInt(env.CLICK_TOKEN_TTL_MS || "120000", 10), // 2 min
    impressionTokenTtlMs: parseInt(env.IMPRESSION_TOKEN_TTL_MS || "120000", 10), // 2 min: enough to dwell + redeem a served impression
    impressionMinDwellMs: parseInt(env.IMPRESSION_MIN_DWELL_MS || "2000", 10), // server backstop: min ms between serve and a billable redeem. The client's on-screen qualifying view (~2s) is the real gate; this just rejects a too-fast redeem. 0 disables
    maxBodyBytes: parseInt(env.MAX_BODY_BYTES || "65536", 10), // 64 KB
    // OAuth
    googleClientId: env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    appleClientId: env.APPLE_CLIENT_ID || "",
    appleTeamId: env.APPLE_TEAM_ID || "",
    appleKeyId: env.APPLE_KEY_ID || "",
    applePrivateKey: (env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    // X sign-in uses OAuth 2.0 Authorization Code + PKCE. These are the OAuth 2.0
    // Client ID and Client Secret from the X developer portal's "User
    // authentication settings" (NOT the OAuth 1.0a API key/secret pair).
    twitterClientId: env.TWITTER_CLIENT_ID || "",
    twitterClientSecret: env.TWITTER_CLIENT_SECRET || "",
    // App-only bearer token used to verify a user's onboarding post is live on
    // their X timeline (admin payout review only). Absent → verification is a
    // no-op that reports "unconfigured".
    twitterBearerToken: env.TWITTER_BEARER_TOKEN || "",
    // mail
    mailProvider: env.MAIL_PROVIDER || "console",
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
    mailFromAds: env.MAIL_FROM_ADS,
    // rate limit
    rateLimitCapacity: parseInt(env.RATE_LIMIT_CAPACITY || "120", 10),
    rateLimitRefillPerSec: parseFloat(env.RATE_LIMIT_REFILL_PER_SEC || "5"),

    // ---- DWELL token mode (dwell/docs/04) — one codebase, two deployments ----
    // '' (default) keeps the legacy DWELL behavior byte-identical: two-way
    // revenueShare split, no token machinery, token routes 404. The DWELL
    // deployment defaults to points (accrual phase); TOKEN_MODE=live post-TGE,
    // TOKEN_MODE=off for a legacy two-way-split instance (not used by DWELL).
    tokenMode: ["points", "live"].includes(env.TOKEN_MODE) ? env.TOKEN_MODE : (env.TOKEN_MODE === "off" ? "" : "points"),
    viewerShareBps: parseInt(env.VIEWER_SHARE_BPS || "6000", 10), // viewer's share of the reserve tranche
    referrerShareBps: parseInt(env.REFERRER_SHARE_BPS || "1000", 10), // referrer's share (falls to protocol when unreferred)
    reserveTrancheBps: parseInt(env.RESERVE_TRANCHE_BPS || "9000", 10), // slice of gross routed to the token side

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
    dwellMint: env.DWELL_MINT || "",
    usdcMint: env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // canonical USDC on Solana mainnet (6 dp)
    solanaRpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    jupiterBaseUrl: env.JUPITER_BASE_URL || "https://lite-api.jup.ag/swap/v1", // pricing quotes at checkout; /swap executes ONLY the acceptance-time hedge
    treasuryUsdcAta: env.TREASURY_USDC_ATA || "",           // company treasury USDC account — the protocol-fee leg
    revenueUsdcAta: env.REVENUE_USDC_ATA || "",             // company revenue USDC account — the rewards-pool leg (funds dwell payouts)
    treasurySolAccount: env.TREASURY_SOL_ACCOUNT || "",     // treasury address for native-SOL fee legs; empty = SOL rail off
    revenueSolAccount: env.REVENUE_SOL_ACCOUNT || "",       // revenue address for native-SOL rewards-pool legs
    treasuryDwellAta: env.TREASURY_DWELL_ATA || "",         // treasury $DWELL account — the whole $DWELL-rail payment lands here, held (docs/01)
    dwellDecimals: parseInt(env.DWELL_DECIMALS || "6", 10), // display only — raw DWELL units ÷ 10^decimals for the "≈ pay in $DWELL" figure
    dwellPayBoostBps: parseInt(env.DWELL_PAY_BOOST_BPS || "1000", 10), // paying in $DWELL boosts a campaign's impressions by this (1000 = +10%)
    maxSlippageBps: parseInt(env.MAX_SLIPPAGE_BPS || "100", 10), // slippageBps param on pricing quotes (checkout never swaps)
    treasurySignerSecret: env.TREASURY_SIGNER_SECRET || "",      // base58 64-byte ed25519 keypair; swap-on-accept + refund-on-reject ONLY
    swapSlippageBps: parseInt(env.SWAP_SLIPPAGE_BPS || "100", 10), // execution slippage bound on the acceptance-time hedge swap
    usdcOrderTtlMinutes: parseInt(env.USDC_ORDER_TTL_MINUTES || "30", 10), // price validity window; each built tx is only ~60s (blockhash)

    // ---- brand — the DWELL deployment bills and writes copy under its own name ----
    brandName: env.BRAND_NAME || "DWELL",
    stripeProductName: env.STRIPE_PRODUCT_NAME || "DWELL spinner block — 1,000 impressions",
    stripeProductImage: env.STRIPE_PRODUCT_IMAGE || "https://dwellprotocol.com/og.png",
  };
}

// Postgres pool options. Managed providers (Supabase, Neon, …) require TLS;
// turn it on for them automatically while leaving local/plaintext dev untouched.
// Set DATABASE_SSL=1 to force TLS for any other managed host (RDS, etc.).
function pgPoolConfig(env = process.env) {
  const connectionString = env.DATABASE_URL || "";
  // DWELL lives in its own Postgres schema (DB_SCHEMA, default 'dwell') so it
  // can share a database server with other products while staying fully
  // isolated at the top level — every connection pins search_path on startup.
  const schema = env.DB_SCHEMA || "dwell";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("DB_SCHEMA must be a plain identifier");
  const needsSsl =
    env.DATABASE_SSL === "1" ||
    /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString) ||
    /\.supabase\.(co|com)\b/.test(connectionString) ||
    /\.neon\.tech\b/.test(connectionString);
  return { connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, options: `-c search_path=${schema}` };
}

async function boot(env = process.env) {
  const config = loadConfig(env);
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  // Token-mode split sanity (dwell/docs/04 §C): the pool must cover both shares.
  if (config.viewerShareBps + config.referrerShareBps > 10000) {
    throw new Error("VIEWER_SHARE_BPS + REFERRER_SHARE_BPS must be <= 10000");
  }
  if (config.reserveTrancheBps > 10000) throw new Error("RESERVE_TRANCHE_BPS must be <= 10000");
  // Stripe is only exercised by advertiser checkout / webhooks — never by the
  // earning loop. In a local devnet (DEVNET=1) we let the API boot without it
  // so you can test devices → ledger → portal end-to-end with no Stripe account;
  // checkout simply isn't part of that flow. Production still requires the key.
  if (!config.stripeSecretKey) {
    if (env.DEVNET === "1") {
      config.stripeSecretKey = "sk_test_devnet";
      console.warn("[dwell] DEVNET=1 — no STRIPE_SECRET_KEY; advertiser checkout is disabled, earning loop works.");
    } else {
      throw new Error("STRIPE_SECRET_KEY is required");
    }
  }

  // Crypto checkout (dwell/docs/08 v2): half-configured rails would build
  // transactions that can never verify — require account pairs together.
  // These are config MISTAKES in an optional feature, not reasons to refuse
  // to boot: a bad crypto env var must not take down checkout, login, ads,
  // and every other unrelated route. Collect the problem into
  // config.cryptoConfigError instead of throwing; requireSigner() (the only
  // place that actually spends from the treasury) refuses with this message
  // until it's fixed, and everything else keeps working.
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
      const { signerPubkeyFromSecret } = require("./solana");
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
  } catch (err) {
    config.cryptoConfigError = err.message;
    console.error(`[dwell] crypto config error (SOL/USDC/DWELL rails disabled until fixed): ${err.message}`);
  }

  const { Pool } = require("pg");
  const pool = new Pool(pgPoolConfig(env));
  const repo = createRepo(pool);
  const stripe = createStripe(config.stripeSecretKey);
  const mailer = createMailer(config);
  const solana = createSolana({ config });
  const rateLimiter = createRateLimiter({
    capacity: config.rateLimitCapacity,
    refillPerSec: config.rateLimitRefillPerSec,
  });
  return { deps: { repo, stripe, mailer, solana, rateLimiter, config }, pool };
}

module.exports = { boot, loadConfig, pgPoolConfig };
