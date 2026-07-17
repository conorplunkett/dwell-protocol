# Robinhood Chain launch exploration ("v3")

> **Status: exploratory. Not the live design. Do not ship, announce, or link
> from any public surface.**
>
> This folder sketches an alternative token launch — $DWELL as an ERC-20 on
> Robinhood Chain with a points-earned seasonal airdrop — and it **directly
> conflicts with the repo's canonical tokenomics**
> ([`dwell/docs/01-tokenomics.md`](../dwell/docs/01-tokenomics.md)) and the
> securities framework
> ([`dwell/docs/09-securities-framework.md`](../dwell/docs/09-securities-framework.md)).
> The v2 design's central defensibility claim is that **no earner ever
> receives the token** — points ("dwells") are dollar credits with *"no
> snapshot, no conversion price, and no airdrop claim."* This folder
> reintroduces exactly that claim. Adopting it means revising docs 01/05/07/09,
> and nothing here goes near a user or a chain before securities counsel has
> reviewed the whole shape. See "Decision gates" below.

## What's in here

| File | What it is |
|---|---|
| [`TOKENOMICS.md`](TOKENOMICS.md) | Allocation (25/30/10/20/15), season structure, unclaimed-rollover policy, points→token conversion |
| [`POINTS.md`](POINTS.md) | The pre-launch points program: earning actions, anti-sybil, snapshot mechanics |
| [`LAUNCH-PLAN.md`](LAUNCH-PLAN.md) | Phased plan from points campaign through TGE and season 1 |
| [`db/points-schema.sql`](db/points-schema.sql) | Postgres schema for the points ledger, seasons, and snapshots (fits the existing Supabase backend) |
| [`contracts/`](contracts/) | Foundry project: fixed-supply ERC-20, seasonal Merkle distributor with 3-month windows + rollover, cliff vesting wallets |

## Decision gates (all open)

1. **Counsel review of the whole model.** Earners receiving a floating token
   for points is the v1 exposure the repo deliberately deleted. It is not a
   detail; it is the design. Nothing ships before counsel signs off on the
   structure, the copy, and the claim flow (including US-person geofencing at
   claim, which docs/09 already recommends for the raise).
2. **Advertiser points are the most radioactive piece** (tokens awarded for
   paying money is functionally a token sale). Recommendation in
   [`POINTS.md`](POINTS.md): settle advertiser rewards in dollar-denominated
   ad credits instead, and keep the airdrop earner-side only.
3. **Chain choice.** This plan replaces, not supplements, the star.fun/Solana
   launch in [`dwell/docs/07-starfun-launch.md`](../dwell/docs/07-starfun-launch.md)
   — the same token cannot credibly launch twice. Choosing Robinhood Chain
   also means losing the Bedrock structure that doc 09 leans on; what replaces
   it is an open question.
4. **dwells stay untouched.** The dollar-denominated dwells ledger, its USDC/
   Claude-credit redemption, and every promise already made about it are out
   of scope here. Airdrop points are a separate ledger
   ([`db/points-schema.sql`](db/points-schema.sql)); no dwells conversion.

## Why Robinhood Chain

Robinhood Chain (mainnet July 1, 2026) is a permissionless Ethereum L2 on the
Arbitrum Orbit stack: ETH gas, ~100ms blocks, full EVM equivalence, standard
tooling (Foundry works as-is), and Uniswap deployed at launch as the primary
public liquidity venue. No launchpad is required or used: the token contract,
distribution, vesting, and liquidity are all first-party, from
[`contracts/`](contracts/). Docs: <https://docs.robinhood.com/chain/>.
