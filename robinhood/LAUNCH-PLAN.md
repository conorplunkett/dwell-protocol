# Launch plan — Robinhood Chain

> Exploratory; see [`README.md`](README.md). Every phase below is gated on
> phase 0. Dates are placeholders on purpose — no public date exists until
> phase 0 closes.

## Phase 0 — decisions (blocks everything)

- [ ] **Securities counsel reviews the whole model** — earner airdrop,
      points program copy, advertiser rewards, claim flow. Output: go/no-go,
      required geofencing (US persons at minimum, per
      `dwell/docs/09-securities-framework.md`), and approved copy rules.
- [ ] **Advertiser rewards decision**: ad credits (recommended) vs.
      spend-weighted points ([`POINTS.md`](POINTS.md)).
- [ ] **Chain decision confirmed**: this plan supersedes the star.fun/Solana
      raise (`dwell/docs/07-starfun-launch.md`). One launch, one chain.
      Includes deciding what (if anything) replaces the Bedrock founder-
      constraint structure.
- [ ] **Docs revised**: 01/05/07/09 rewritten for the adopted model; the
      "no airdrop claim attached to points" language cannot coexist with a
      points campaign announcement.
- [ ] Treasury Safe deployed on Robinhood Chain (3+ signers, hardware keys);
      root-setter ops key provisioned separately from Safe signers.

## Phase 1 — points campaign (pre-launch, ~8–12 weeks)

- [ ] Ship `db/points-schema.sql` + ingest-path double-write (qualified view
      → dwells ledger + season points, one transaction).
- [ ] Portal: season points balance, earning schedule, referral status,
      wallet linking (the claim wallet users will prove against).
- [ ] Announce season structure with counsel-approved copy: 5 seasons × 6%,
      pro-rata pools, 3-month claim windows, rollover policy, geofence —
      all stated **before** anyone earns a point.
- [ ] Anti-fraud dashboards: per-device/IP view caps already exist; add
      sybil clustering over devices/wallets/payment fingerprints.
- [ ] Weekly publication of aggregate season points (total, per-surface) so
      pro-rata expectations stay grounded.

## Phase 2 — snapshot (season 1 close)

- [ ] Freeze `season_points_events` at the announced timestamp.
- [ ] Exclusions run → preliminary totals published → 7-day appeal window.
- [ ] Final `season_snapshots` written; Merkle tree built over
      `(seasonId, wallet, amount)` double-hashed leaves; tree input
      published for independent verification.

## Phase 3 — TGE (contracts + liquidity)

Order matters; each step is a recorded transaction from the Safe unless
noted.

1. [ ] **Audit** of `contracts/` (hard gate, same policy as
       `dwell/contracts`). The token is byte-identical to the CI-verified
       reference; the distributor and vesting wrapper are the new surface.
2. [ ] Deploy via `contracts/script/Deploy.s.sol` (token → distributor →
       vesting wallets; deployer holds nothing afterward). Verify sources on
       the explorer.
3. [ ] Safe → vesting wallets: 250M total (per-member splits recorded).
4. [ ] Safe → Uniswap DWELL/ETH pool: 100M + the ETH side (the pool ratio
       sets the launch price; size the ETH leg deliberately and state the
       resulting figures as facts, no forward-looking language). Lock the LP
       NFT in a timelock/locker; publish the lock address.
5. [ ] Safe → distributor: 60M season 1 pool; root setter calls
       `startSeason(root, 60M, now + 3 months)`.
6. [ ] Ecosystem (150M) and treasury (200M) stay in the Safe; ecosystem
       grants and any treasury sales follow the pre-announced-schedule
       discipline in [`TOKENOMICS.md`](TOKENOMICS.md).

## Phase 4 — season 1 claims (3 months)

- [ ] Claim UI: connect wallet → proof lookup from `season_snapshots` →
      `claim(seasonId, account, amount, proof)`. Geofence enforced here.
- [ ] Gas note: claims cost ETH on Robinhood Chain; decide whether the
      backend sponsors claims (the distributor allows third-party execution
      of a claim on a user's behalf, paying only to the entitled wallet).
- [ ] Monitoring: claimed % dashboards, support flow for mis-linked wallets
      (fixable only in the *next* season's root — never by re-rooting a
      live season).
- [ ] At deadline: `closeSeason(1)`; unclaimed rolls to season 2's pool.
      Publish the rollover number.

## Phase 5 — seasons 2–5 (steady state)

Quarterly cadence: earning window → snapshot + appeal → fund 60M + carryover
→ 3-month claim window → close. Earning schedules may be tuned per season
(announced at season open, never retroactively). After season 5 closes, the
program ends; any final carryover disposition (sweep vs. a bonus season) is
announced before season 5 opens.

## Open items

- Robinhood Chain specifics to pin down at phase 3: RPC endpoints, chain id,
  explorer/verification tooling, canonical bridge addresses, Uniswap
  deployment addresses, LP-locker availability. All from
  <https://docs.robinhood.com/chain/> at execution time — deliberately not
  hardcoded here while the chain is weeks old.
- CI: `robinhood/contracts` is not yet wired into
  `.github/workflows/dwell-ci.yml`; add a forge build+test job (same pinned
  toolchain as the `dwell-contracts` job) if this plan advances past
  phase 0.
