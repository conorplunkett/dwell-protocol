// Unit tests for src/ticker.js — the cached DexScreener proxy behind
// /v1/ticker. Pure: fetch and the clock are injected, no network/database.
// Run: node test/ticker.test.js
const assert = require("node:assert");
const { parseTickerTokens, createTicker, bestPairByMint, pairToChanges } = require("../src/ticker");

let passed = 0;
function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`  ✓ ${name}`);
  });
}

const pair = (mint, liqUsd, priceChange, extra = {}) => ({
  baseToken: { address: mint },
  liquidity: { usd: liqUsd },
  priceChange,
  priceUsd: "0.01",
  url: `https://dexscreener.com/solana/${mint}`,
  ...extra,
});

(async () => {
  console.log("ticker — DexScreener proxy\n");

  await check("parseTickerTokens: symbol=mint pairs, empty mints kept, junk dropped", () => {
    assert.deepStrictEqual(parseTickerTokens("$fwog=MINT1, $pepe=MINT2 ,$troll=,, =x,broken"), [
      { symbol: "$fwog", mint: "MINT1" },
      { symbol: "$pepe", mint: "MINT2" },
      { symbol: "$troll", mint: "" },
    ]);
    assert.deepStrictEqual(parseTickerTokens(""), []);
    assert.deepStrictEqual(parseTickerTokens(undefined), []);
  });

  await check("pairToChanges: maps m5/h1/h24 → 5m/1h/1d, drops h6 and non-finite", () => {
    assert.deepStrictEqual(pairToChanges(pair("m", 1, { m5: 1.5, h1: -3, h6: 40, h24: 88 })), { "5m": 1.5, "1h": -3, "1d": 88 });
    assert.deepStrictEqual(pairToChanges(pair("m", 1, { m5: "2.5", h24: null })), { "5m": 2.5 }); // numeric strings ok, null dropped
    assert.deepStrictEqual(pairToChanges(pair("m", 1, {})), {});
  });

  await check("bestPairByMint: keeps the most liquid pair per mint", () => {
    const best = bestPairByMint([pair("A", 100, {}), pair("A", 5000, {}), pair("B", 1, {}), { junk: true }]);
    assert.strictEqual(best.get("A").liq, 5000);
    assert.strictEqual(best.get("B").liq, 1);
  });

  await check("getTicker: fetches, shapes tokens, then serves from cache within the TTL", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const t = createTicker(
      { tickerTokens: [{ symbol: "$fwog", mint: "FW" }, { symbol: "$troll", mint: "" }], tickerCacheTtlMs: 60000 },
      {
        now: () => clock,
        fetchImpl: async (url) => {
          calls++;
          assert.ok(url.endsWith("/solana/FW"), "empty mints are excluded from the batch URL");
          return { ok: true, json: async () => [pair("FW", 10, { m5: 3, h1: 15, h24: 88 })] };
        },
      }
    );
    const r1 = await t.getTicker();
    assert.deepStrictEqual(r1.tokens, [{ symbol: "$fwog", changes: { "5m": 3, "1h": 15, "1d": 88 }, priceUsd: "0.01", url: "https://dexscreener.com/solana/FW" }]);
    clock += 30000;
    assert.strictEqual(await t.getTicker(), r1, "within TTL: cached object, no refetch");
    assert.strictEqual(calls, 1);
    clock += 60001;
    await t.getTicker();
    assert.strictEqual(calls, 2, "past TTL: refetches");
  });

  await check("getTicker: stale-on-error, then { tokens: [] } when nothing was ever cached", async () => {
    let fail = false;
    let clock = 0;
    const cfg = { tickerTokens: [{ symbol: "$fwog", mint: "FW" }], tickerCacheTtlMs: 1000 };
    const t = createTicker(cfg, {
      now: () => clock,
      fetchImpl: async () => {
        if (fail) throw new Error("network down");
        return { ok: true, json: async () => [pair("FW", 10, { h24: 42 })] };
      },
    });
    const good = await t.getTicker();
    fail = true;
    clock += 5000; // past the TTL, upstream now failing
    assert.strictEqual(await t.getTicker(), good, "stale cache beats an error");

    const cold = createTicker(cfg, { now: () => 0, fetchImpl: async () => { throw new Error("down"); } });
    assert.deepStrictEqual(await cold.getTicker(), { tokens: [], updatedAt: null }, "no cache yet: empty tokens, never throws");
    const http500 = createTicker(cfg, { now: () => 0, fetchImpl: async () => ({ ok: false, status: 500 }) });
    assert.deepStrictEqual(await http500.getTicker(), { tokens: [], updatedAt: null });
  });

  await check("getTicker: unconfigured (no mints) short-circuits to { tokens: [] } with no fetch", async () => {
    const t = createTicker({ tickerTokens: [{ symbol: "$fwog", mint: "" }] }, {
      fetchImpl: async () => { throw new Error("must not be called"); },
    });
    assert.deepStrictEqual(await t.getTicker(), { tokens: [], updatedAt: null });
  });

  await check("getTicker: a mint with no pairs or no usable windows is omitted", async () => {
    const t = createTicker(
      { tickerTokens: [{ symbol: "$fwog", mint: "FW" }, { symbol: "$ghost", mint: "GH" }, { symbol: "$blank", mint: "BL" }], tickerCacheTtlMs: 1000 },
      { now: () => 0, fetchImpl: async () => ({ ok: true, json: async () => [pair("FW", 10, { h1: 7 }), pair("BL", 10, {})] }) }
    );
    const r = await t.getTicker();
    assert.deepStrictEqual(r.tokens.map((x) => x.symbol), ["$fwog"]);
    assert.deepStrictEqual(r.tokens[0].changes, { "1h": 7 });
  });

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
