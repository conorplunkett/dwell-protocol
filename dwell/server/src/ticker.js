// Live market data for the lander's ticker %-change badges — a thin cached
// proxy over DexScreener (free, keyless) so the site shows real numbers
// instead of the hardcoded demo `changes` in web/script.js.
//
// DexScreener's pair objects carry priceChange for m5/h1/h6/h24 only, so we
// map honestly onto the site's windows — "5m", "1h", "1d" — and omit
// 15m/4h rather than fake them. resolveChangePct (util.js) already skips
// missing windows, so "auto" badges become the max of the three we serve.
//
// Failure posture: cache (TTL) → stale-on-error → { tokens: [] }. An empty
// tokens list tells the frontend to keep its built-in demo values, so the
// badges never go blank.

const DEXSCREENER_BASE = "https://api.dexscreener.com/tokens/v1/solana";

// TICKER_TOKENS="$ansem=<mint>,$troll=<mint>,..." — symbol=solana-mint pairs.
// Entries with an empty mint are kept (they document intent) but skipped at
// fetch time, so an unconfigured deployment serves { tokens: [] }.
function parseTickerTokens(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      if (i < 1) return null;
      return { symbol: pair.slice(0, i).trim(), mint: pair.slice(i + 1).trim() };
    })
    .filter((t) => t && t.symbol);
}

// pairs → per-token changes: keep the most liquid pair for each mint (meme
// tokens list on many DEXes; the deep pool is the honest price source).
function bestPairByMint(pairs) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const mint = p && p.baseToken && p.baseToken.address;
    if (!mint) continue;
    const liq = Number(p.liquidity && p.liquidity.usd) || 0;
    const cur = best.get(mint);
    if (!cur || liq > cur.liq) best.set(mint, { liq, pair: p });
  }
  return best;
}

function pairToChanges(pair) {
  const pc = (pair && pair.priceChange) || {};
  const changes = {};
  // DexScreener window → site window; h6 has no honest home (no 4h/15m).
  for (const [from, to] of [["m5", "5m"], ["h1", "1h"], ["h24", "1d"]]) {
    const raw = pc[from];
    if (raw == null || raw === "") continue; // Number(null) is 0 — not "no data"
    const v = Number(raw);
    if (Number.isFinite(v)) changes[to] = v;
  }
  return changes;
}

// Factory (matches createStripe/createMailer): holds the in-memory cache and
// takes an injectable fetch/clock for tests.
function createTicker(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const ttl = config.tickerCacheTtlMs > 0 ? config.tickerCacheTtlMs : 60000;
  let cache = { at: 0, data: null };

  async function getTicker() {
    if (cache.data && now() - cache.at < ttl) return cache.data;
    const tokens = (config.tickerTokens || []).filter((t) => t.mint);
    if (!tokens.length) return { tokens: [], updatedAt: null };
    try {
      // Batch endpoint: one request for all mints (≤30, well within limits).
      const url = `${DEXSCREENER_BASE}/${tokens.map((t) => t.mint).join(",")}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`dexscreener ${res.status}`);
      const best = bestPairByMint(await res.json());
      const out = tokens
        .map(({ symbol, mint }) => {
          const hit = best.get(mint);
          if (!hit) return null;
          const changes = pairToChanges(hit.pair);
          if (!Object.keys(changes).length) return null;
          return { symbol, changes, priceUsd: hit.pair.priceUsd, url: hit.pair.url };
        })
        .filter(Boolean);
      cache = { at: now(), data: { tokens: out, updatedAt: new Date(now()).toISOString() } };
      return cache.data;
    } catch (err) {
      if (cache.data) return cache.data; // stale beats blank
      return { tokens: [], updatedAt: null }; // frontend keeps its demo values
    }
  }

  return { getTicker };
}

module.exports = { parseTickerTokens, createTicker, bestPairByMint, pairToChanges };
