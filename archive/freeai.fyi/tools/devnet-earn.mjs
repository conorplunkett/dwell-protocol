// devnet-earn — drive a real earning session against a LOCAL FreeAI API so you
// can watch a portal balance climb in real time. Dev-only; talks to the Node
// reference server (`make devnet`) and the local Postgres.
//
//   make devnet         # terminal 1: db + migrate + seed + API on :8787
//   make devnet-earn    # terminal 2: this simulator
//
// It does exactly what a real surface (extension / terminal / macOS) does:
//   1. POST /v1/devices/register                      → a device identity
//   2. POST /v1/auth/request-link + GET /v1/auth/verify → link device → account
//   3. POST /v1/events (impressions) + click token    → accrue 50% credits
// then prints the magic-link to sign in to the portal and watch it live.
//
// No real money moves: a local seed campaign funds the impressions and Stripe
// is never touched. This is the "mock money" path.
//
// Env: API_BASE (default http://localhost:8787), DATABASE_URL (for reading the
// dev magic-link tokens the console mailer prints), EARN_EMAIL, BATCH_IMPRESSIONS,
// TICK_MS, TICKS (0 = run forever).

import { createRequire } from "node:module";
// `pg` is a dependency of the reference server; resolve it from there so this
// root-level dev tool needs no install of its own.
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { Client } = require("pg");

const API = process.env.API_BASE || "http://localhost:8787";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/freeai";
const EMAIL = process.env.EARN_EMAIL || `devnet@example.com`;
const BATCH = parseInt(process.env.BATCH_IMPRESSIONS || "100", 10);
const TICK_MS = parseInt(process.env.TICK_MS || "2000", 10);
const TICKS = parseInt(process.env.TICKS || "0", 10); // 0 = forever

const post = (p, b) =>
  fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
    .then((r) => r.json());
const j = (p, opts) => fetch(API + p, opts).then((r) => r.json());

async function latestToken(db, email) {
  const r = await db.query(
    "select token from email_tokens where email = $1 order by expires_at desc limit 1",
    [email]
  );
  if (!r.rows[0]) throw new Error("no email token found — is the API running with the console mailer?");
  return r.rows[0].token;
}

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  // health + an active campaign to bill against
  const health = await j("/healthz").catch(() => null);
  if (!health?.ok) throw new Error(`API not reachable at ${API} — run \`make devnet\` first`);
  const ads = await j("/v1/ads?n=1");
  if (!ads.ads?.length) throw new Error("no active campaign — run `make seed`");
  const campaignId = ads.ads[0].id;

  // 1. a fresh device (what every surface does on first run)
  const dev = await post("/v1/devices/register", {});

  // 2. link the device to an account, exactly like the surface's connect-email step
  await post("/v1/auth/request-link", { deviceId: dev.deviceId, deviceKey: dev.deviceKey, email: EMAIL });
  await fetch(`${API}/v1/auth/verify?token=${await latestToken(db, EMAIL)}`, { redirect: "manual" });

  // 3. open a portal session so we can read the climbing balance + print the link
  await post("/v1/web/login", { email: EMAIL });
  const loginToken = await latestToken(db, EMAIL);
  const portalLink = `${API}/v1/web/session?token=${loginToken}`;
  const resp = await fetch(portalLink, { redirect: "manual" });
  const loc = resp.headers.get("location") || "";
  const session = new URL(loc.replace("#", "?"), API).searchParams.get("session");

  const usd = (n) => `$${(n ?? 0).toFixed(6)}`;
  const balance = async () => j("/v1/web/earnings", { headers: { authorization: `Bearer ${session}` } });

  console.log("─".repeat(64));
  console.log(`  devnet-earn → ${API}`);
  console.log(`  account:   ${EMAIL}`);
  console.log(`  device:    ${dev.deviceId}`);
  console.log(`  campaign:  ${campaignId}`);
  console.log("");
  console.log("  Open the portal and watch this same balance climb live:");
  console.log(`  ${portalLink}`);
  console.log("  (or sign in at /redeem.html with the email above)");
  console.log("─".repeat(64));
  console.log(`  start: ${usd((await balance()).balanceUsd)}   (serving ${BATCH} impressions / ${TICK_MS}ms)`);

  let n = 0;
  const tick = async () => {
    n += 1;
    await post("/v1/events", {
      deviceId: dev.deviceId,
      deviceKey: dev.deviceKey,
      batchKey: `devnet-${dev.deviceId}-${Date.now()}-${n}`,
      events: [{ campaignId, impressions: BATCH, clicks: 0 }],
    });
    const b = await balance();
    process.stdout.write(`\r  tick ${String(n).padStart(4)} → balance ${usd(b.balanceUsd)}  today ${usd(b.todayUsd)}  lifetime ${usd(b.lifetimeUsd)}   `);
    if (TICKS && n >= TICKS) {
      console.log("\n  done.");
      await db.end();
      process.exit(0);
    }
  };
  await tick();
  setInterval(tick, TICK_MS);
}

main().catch((err) => {
  console.error("devnet-earn failed:", err.message);
  process.exit(1);
});
