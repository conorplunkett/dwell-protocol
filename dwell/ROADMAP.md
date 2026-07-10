# Roadmap

Near-term work that is modeled in the codebase but not yet fully live.

## Ad performance % — live market data

Every ad now carries a **recent-change %** badge (the crypto-ticker figure next
to the token, e.g. `(+235%)` green / `(-12%)` red) and an advertiser-selectable
**performance window** (5m / 15m / 1h / 4h / 1d, plus an internal `auto` that
renders whichever window is biggest and is hidden from the public ad form).

Today the numbers are **demo/illustrative only**:

- The example tokens ($ansem, $troll, $pepe, $chillguy) and the dev seed carry
  hardcoded per-window `changes` maps across the web, extension, terminal, and
  desktop surfaces.
- Real advertiser campaigns store their chosen `change_timescale` (via
  `/v1/checkout`) but have a null `changes` map, so they render **no badge**.

**Next:** wire a live market-data source (e.g. DexScreener / pump.fun) keyed on
the campaign's token to populate `campaigns.changes` per window on a schedule.
Once populated, `resolveChangePct` (`server/src/util.js`, mirrored in
`supabase/functions/dwell-api/index.ts`) already turns the map + timescale into
the single number the `/v1/ads`, `/v1/leaderboard`, and `/v1/impressions/serve`
responses expose as `change`, and every client already renders it — so this is a
data-population job, not a UI change.

Formatting is fixed by `formatChangePct`: signed, at most 3 significant
digit-characters, leading zero dropped (`0.5 → .5`), magnitude clamped to 999.
