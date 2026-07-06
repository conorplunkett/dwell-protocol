# star.fun launch — assessment and adaptation

Decision doc for launching AIAD on [star.fun](https://star.fun) instead of the
self-directed Base TGE in [06-launch-checklist.md](06-launch-checklist.md).
Research date: July 2026 — the platform is ~13 months old and its mechanics
have already changed once; **confirm everything marked ✎ with the star.fun
team before committing.**

## What star.fun is

A Solana fundraising launchpad run by Serious Fun Labs, Inc. (Delaware).
Positioned as "Kickstarter + Twitch + NASDAQ": a project raises money by
selling its token on a bonding curve, framed as fractionalized ownership of
~10% of the company via a BVI project company + Cayman SPC wrapper (Delaware
C-Corp alternative on request ✎).

| Fact | Detail |
|---|---|
| Chain | Solana (SPL token), liquidity on Meteora, USDC-denominated |
| Supply preset | 1B fixed: **60% public sale / 20% team (3-mo cliff + 9-mo linear vest) / 20% liquidity pool** |
| Raise tiers | Micro $10K (graduation ~$190K MC) / Standard $25K (~$352K) / Pro $50K (~$622K); milestone unlocks to $8.6M |
| Price | Live from minute one — bonding curve reprices continuously; secondary trading immediately, Meteora pool at graduation |
| Fees | 1% of in-raise trades; 0.5% post-launch — and **the founder earns 0.5% of every trade, forever** |
| Failure mode | Refunds if the raise misses thresholds |
| KYC / geofence | None documented; US **not** excluded |
| ToS | English law, LCIA arbitration (London), no class actions |
| Track record | 4 completed raises, ~$1.3M lifetime; flagship consumer comp (SurfCash) −95% from ATH |
| API | **None** — the docs' API reference is an unfilled placeholder; pre-graduation programmatic buys unsupported |

## Does the 60% public sale break the reward model? No.

Rewards in this design **never come from an allocation** — they are bought on
the open market with ad revenue, campaign by campaign (buy-and-distribute,
[01-tokenomics.md](01-tokenomics.md)). The initial mint only determines who
holds tokens and where liquidity sits:

1. star.fun mints 1B: 60% to curve buyers, 20% team, 20% Meteora pool.
2. Advertiser pays $100 → the $90 tranche buys AIAD **from that market**
   (Jupiter-routed into the Meteora pool).
3. The bought tokens split 85/15 (viewer / referrer; unreferred 15% → treasury) at the
   campaign's locked rate.
4. Sellers return tokens to the pool; the next campaign's buy picks them up.

A large public float *helps*: deeper market → less price impact per campaign
buy → fairer locked rates. What the preset removes is the discretionary
reserve (our old 35% community + 30% ops buckets) — partially mitigated by the
treasury's accrual of unreferred 15% legs, and on this venue by the 20% team
allocation plus the founder's 0.5% of all trading volume.

## Blockers, ranked

1. **Securities posture flips — hard gate.** The entire legal design rested on
   *earned, never sold* ([05-legal-structure.md](05-legal-structure.md)). A
   star.fun raise publicly sells 60% of supply, explicitly framed as
   equity-like ownership, on a platform with **no KYC and no US geofence**.
   That is an offering in substance, and it also reintroduces the offshore
   wrapper (BVI/Cayman) the structure deliberately avoided. **Securities
   counsel sign-off moves from a TGE gate to a before-you-touch-it gate.**
   The points-first phase collapses (a live token can't be "points").
2. **Chain flip: Solana.** The token is an SPL mint created by star.fun; the
   EVM contracts in `../contracts` do not deploy there. Adaptation is smaller
   than it sounds — the architecture survives with swapped parts:
   | EVM path (built) | star.fun path |
   |---|---|
   | `CampaignFunder.sol` (0x route) | Offchain keeper buys via **Jupiter swap API**, transfers split to distributor + treasury; `token_campaign_pools` rows keyed by the buy tx |
   | `MerkleRewardsDistributor.sol` | An established **Solana Merkle-distributor program** (e.g. the Jito/Saber lineage), same cumulative-leaf design |
   | Treasury Safe (EVM multisig) | **Squads** multisig on Solana |
   | Privy (EVM wallets) | Privy supports Solana wallets — pick unchanged |
   The EVM contracts stay in-repo as the reference implementation and the
   fallback path.
3. **Buybacks start only at graduation.** No API for curve-phase buys ✎ — the
   revenue flywheel switches on once the token is in the Meteora pool. Ad
   campaigns sold before graduation accrue as dollar-value points and convert
   at the first post-graduation buys (a short, bounded points phase).
4. **Allocation preset overrides ours.** No treasury/community reserve; team
   vest is 12 months total vs. our specced 1-year cliff + 4-year vest — the
   short vest is exactly the optics [05-legal-structure.md](05-legal-structure.md)
   warns about. ✎ Ask whether custom vesting is possible.
5. **Venue maturity.** 4 raises ever, thin/changing docs, no analytics, −95%
   flagship comp. Being early to the venue is its own risk.

## What improves

- **$10–50K raised upfront** + liquidity bootstrapped for free (replaces the
  $25–100K self-seed line item).
- **Founder 0.5% of all trading volume, forever** — a third revenue stream on
  top of the 5% fiat margin and the 35–50% protocol share of campaign buys.
- Refund-if-fail derisks a flopped raise; the platform brings a launch
  audience.

## Decision checklist before committing

- [ ] Securities + tax counsel review of the raise itself (not just the
      reward mechanics): US-accessible unregistered sale, equity framing,
      BVI/Cayman wrapper, English-law ToS.
- [ ] star.fun team Q&A ✎: Delaware C-Corp alternative? Custom vesting?
      Pre-graduation buy API or supported onchain path? Current curve
      parameters (docs have changed once already)? Geofencing options?
- [ ] Decide the raise tier (Micro/Standard/Pro) — sets graduation market cap
      and therefore day-one pool depth for campaign buys.
- [ ] Accept the Solana port scope: Jupiter keeper + Solana Merkle
      distributor + Squads treasury ([04-backend-adaptation.md](04-backend-adaptation.md)
      knobs gain `SOLANA_RPC_URL` / `JUPITER_API` variants).
- [ ] Keep the copy rules regardless of venue: the raise page and every AIAD
      surface state mechanics as facts, no price promises — a launchpad
      audience makes this discipline harder and more important, not less.

## Recommendation

star.fun is viable as a **funding + liquidity + distribution shortcut**, and
the reward engine is venue-agnostic by design. The trade is legal exposure:
you exchange the cleanest available posture (earn-only, US-domiciled, no
sale) for a public, equity-framed, non-geofenced token sale on a young
platform. If the raise proceeds, it must be treated as the TGE with every
pre-launch gate from [06-launch-checklist.md](06-launch-checklist.md)
(counsel, geofence decision, W-9 pipeline, audit-equivalent review of the
Solana distributor) completed **before** the raise goes live, not after.
