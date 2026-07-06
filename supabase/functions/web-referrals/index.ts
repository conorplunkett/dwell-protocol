// Proof-of-concept: the `GET /v1/web/referrals` route, ported from the Node
// `node:http` server (`server/src/app.js` + `server/src/repo.js`) to a Supabase
// Edge Function. Purpose is to validate the "rewrite the backend onto Supabase
// Edge Functions" path before porting the money-handling routes — specifically
// that an Edge Function can talk to the production Postgres through the
// connection pooler and reproduce our hand-written SQL verbatim.
//
// Faithful to the Fly route:
//   - same auth (app session token via Authorization: Bearer / ?session=),
//   - same response shape,
//   - same SQL for userForSession / getOrCreateReferralCode / referralStats.
//
// Deliberately NOT a Supabase-JWT endpoint: it authenticates with our own
// web_sessions tokens, so it is deployed with verify_jwt=false (custom auth).
//
// Connection: uses the auto-injected SUPABASE_DB_URL (Supavisor pooler).
// prepare:false is required under transaction-mode pooling.
import postgres from "npm:postgres@3.4.4";

// Mirror of server/src/repo.js — unambiguous base32, no O/0/I/1.
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
// Mirror of server/src/boot.js loadConfig defaults.
const SITE_URL = Deno.env.get("SITE_URL") || "https://dwell-protocol.vercel.app";
const REFERRAL_REWARD_CENTS = parseInt(Deno.env.get("REFERRAL_REWARD_CENTS") || "2000", 10);
const REFERRAL_CAP = parseInt(Deno.env.get("REFERRAL_CAP") || "10", 10);

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

const corsHeaders = {
  "Access-Control-Allow-Origin": SITE_URL,
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function generateReferralCode(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return out;
}

// app.js sessionFrom(): Authorization: Bearer <token> or ?session=<token>.
function sessionFrom(req: Request, query: URLSearchParams): string | null {
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
  return bearer || query.get("session") || null;
}

// repo.userForSession()
async function userForSession(token: string | null) {
  if (!token) return null;
  const rows = await sql.unsafe(
    `select u.id, u.email from web_sessions s join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token],
  );
  return rows[0] || null;
}

// repo.getOrCreateReferralCode() — lazily backfills a code for existing users.
async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await sql.unsafe(
    "select referral_code from users where id = $1",
    [userId],
  );
  if (existing[0]?.referral_code) return existing[0].referral_code;
  for (let i = 0; i < 6; i++) {
    const code = generateReferralCode();
    try {
      const r = await sql.unsafe(
        "update users set referral_code = $2 where id = $1 and referral_code is null returning referral_code",
        [userId, code],
      );
      if (r[0]) return r[0].referral_code;
      const re = await sql.unsafe(
        "select referral_code from users where id = $1",
        [userId],
      );
      if (re[0]?.referral_code) return re[0].referral_code;
    } catch (_err) {
      // unique violation on a code collision — retry with a fresh code
    }
  }
  throw new Error("could not allocate a referral code");
}

// repo.referralStats()
async function referralStats(userId: string) {
  const stats = await sql.unsafe(
    `select
       count(*) filter (where status = 'rewarded')::int as rewarded,
       count(*) filter (where status = 'pending')::int as pending,
       count(*) filter (where status = 'capped')::int as capped,
       coalesce(sum(reward_millicents), 0)::bigint as earned_millicents
     from referrals where referrer_user_id = $1`,
    [userId],
  );
  const list = await sql.unsafe(
    `select status, created_at from referrals
      where referrer_user_id = $1 order by created_at desc limit 50`,
    [userId],
  );
  const s = stats[0];
  return {
    rewardedCount: s.rewarded,
    pendingCount: s.pending,
    cappedCount: s.capped,
    creditsEarnedMillicents: Number(s.earned_millicents),
    referrals: list.map((r: { status: string; created_at: string }) => ({
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json(405, { error: "method not allowed" });

  const query = new URL(req.url).searchParams;
  try {
    const user = await userForSession(sessionFrom(req, query));
    if (!user) return json(401, { error: "not signed in" });

    const code = await getOrCreateReferralCode(user.id);
    const stats = await referralStats(user.id);
    return json(200, {
      code,
      link: `${SITE_URL}/redeem.html?ref=${code}`,
      rewardUsd: REFERRAL_REWARD_CENTS / 100,
      cap: REFERRAL_CAP,
      rewardedCount: stats.rewardedCount,
      pendingCount: stats.pendingCount,
      creditsEarnedUsd: stats.creditsEarnedMillicents / 100000,
      referrals: stats.referrals,
    });
  } catch (err) {
    console.error("web-referrals error:", err);
    return json(500, { error: "internal error" });
  }
});
