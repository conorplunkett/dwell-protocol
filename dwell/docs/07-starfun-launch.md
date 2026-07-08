# star.fun launch — assessment and adaptation

> **Update (July 2026): Bedrock structure adopted — verified against
> Bedrock's published materials** (bedrock.meteora.ag/learn; Bedrock is a
> Meteora × GVRN AI venture launched Mar 2026; star.fun is a confirmed
> integrated launchpad, alongside Bags and Collateralize). The equity terms
> below are superseded:
>
> - DWELL confers **zero equity rights** — Bedrock's docs verbatim: "Holding
>   tokens from a project that has opted into the Bedrock framework confers
>   zero equity rights."
> - The independent **Bedrock Foundation** holds preference equity (10–30%,
>   founder's election) + a golden share in the BVI project company; founders
>   retain ≥70% ordinary shares and full operational control. Enforcement
>   fund up to US$2M; activates only for fraud/bad-faith/unauthorized value
>   extraction, not failure.
> - Token→equity path: ≥30% of supply may trigger the constitutional buyout
>   of remaining tokens at (100% − % surrendered) × supply × (7-day TWAP ×
>   1.30); **only at 100% of supply** may the acquirer seek the Foundation's
>   preference equity, via SPA — a "standing invitation to treat" (not a
>   binding offer), gated on accredited-investor status + KYC/AML/CTF. A
>   token holder has a *path* to equity, not a *right* to equity.
> - References below to "$1M company valuation / tokens = 8.3% of the
>   company" describe the prior star.fun-native structure and **no longer
>   apply**; that framing is banned on all surfaces.
> - Raise-mitigation decisions + counsel gate:
>   [08-securities-framework.md](08-securities-framework.md). ✎ Before the
>   raise: confirm the executed constitutional documents match the published
>   framework, the Foundation's directors, and the star.fun × Bedrock
>   integration mechanics in writing; record the raise geofence/KYC decision
>   (recommended: exclude US persons).

Decision doc for launching DWELL on [star.fun](https://star.fun) instead of the
self-directed Base TGE in [06-launch-checklist.md](06-launch-checklist.md).
Research date: July 2026 — the platform is ~13 months old and its mechanics
have already changed once; **confirm everything marked ✎ with the star.fun
team before committing.**

## What star.fun is

A Solana fundraising launchpad run by Serious Fun Labs, Inc. (Delaware).
Positioned as "Kickstarter + Twitch + NASDAQ": a project raises money by
selling its token — via a bonding curve, or on a **curated raise** (our path)
at a founder-set valuation with escrowed deposits — framed as fractionalized
ownership of the company via a BVI project company + Cayman SPC wrapper
(Delaware C-Corp alternative on request ✎).

| Fact | Detail |
|---|---|
| Chain | Solana (SPL token), liquidity on Meteora, USDC-denominated |
| Supply | 1B fixed; curated raises set custom valuation and allocation buckets (the old fixed 60/20/20 preset no longer applies) |
| Our raise (⚠ equity terms superseded by the Bedrock update above) | ~~**$1M company valuation**; the 1B tokens represent **8.3% of the company**~~ — now: $1M launch valuation, zero-equity token under Bedrock. Total target ~$115K: ~$50K founder proceeds / ~$65K pool liquidity / ~$7.5K BVI setup ✎ exact split from star. Buckets: 60% initial liquidity / 10% ad-rewards airdrop / 10% structured sell orders (execute at preset market-cap levels) / 20% team (3-mo cliff + 9-mo vest) |
| Raise mechanics | 5-day deposit window, funds in escrow; full refund if the target isn't met; the Meteora pool is seeded with 60% of supply plus the pool leg of the raise proceeds |
| Fees | 1% of in-raise trades; 0.5% post-launch — and **the founder earns 0.5% of every trade, forever** |
| Failure mode | Refunds if the raise misses thresholds |
| KYC / geofence | None documented; US **not** excluded |
| ToS | English law, LCIA arbitration (London), no class actions |
| Track record | 4 completed raises, ~$1.3M lifetime; flagship consumer comp (SurfCash) −95% from ATH |
| API | **None** — the docs' API reference is an unfilled placeholder; pre-graduation programmatic buys unsupported |

## Does the raise break the reward model? No.

Ongoing rewards are bought on the open market with ad revenue, campaign by
campaign (buy-and-distribute, [01-tokenomics.md](01-tokenomics.md)):

1. star.fun mints 1B per the bucket setup above; the Meteora pool is funded
   from the raised USDC.
2. Advertiser pays $100 → the $90 tranche buys DWELL **from that market**
   (Jupiter-routed into the Meteora pool).
3. The bought tokens split 60/10/30 (viewer / referrer / protocol treasury,
   held) at the campaign's locked rate.
4. Sellers return tokens to the pool; the next campaign's buy picks them up.

The one exception is the **10% ad-rewards airdrop**: it covers the past
(pre-launch points convert from it at the fixed $1M-valuation price,
instantly at token launch) and launch boosts. Revenue covers the future — every campaign after
the pool is live is buy-and-distribute. The protocol treasury self-builds at
30–40% of every campaign buy (held, never sold); the 10% structured-sell
bucket and the founder's 0.5% of all trading volume sit on top.

## Blockers, ranked

1. **Securities posture flips — hard gate.** The entire legal design rested on
   *earned, never sold* ([05-legal-structure.md](05-legal-structure.md)). A
   star.fun raise publicly sells supply, framed as equity-like ownership, on a
   platform with **no KYC and no US geofence**. That is an offering in
   substance, and it also reintroduces the offshore wrapper (BVI/Cayman) the
   structure deliberately avoided. **Securities counsel sign-off moves from a
   TGE gate to a before-you-touch-it gate.** Declining the extra-equity
   sweetener and keeping the raise page facts-only are harm reduction, not a
   cure. The points phase now ends at the raise snapshot (a live token can't
   be "points").
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
3. **Buybacks start once the pool is live.** The revenue flywheel switches on
   when the token is in the Meteora pool — with 60% of supply seeding it at
   launch, that is day one, not a later graduation event. Points earned before
   launch convert at the fixed $1M-valuation price from the airdrop bucket
   (instant at token launch).
4. **Short team vest.** 3-month cliff + 9-month linear is far shorter than our
   specced 1-year cliff + 4-year vest — exactly the optics
   [05-legal-structure.md](05-legal-structure.md) warns about. ✎ Ask whether
   custom vesting is possible. (The old fixed-allocation blocker is resolved:
   curated raises take custom buckets, and ours are set in
   [01-tokenomics.md](01-tokenomics.md).)
5. **Venue maturity.** 4 raises ever, thin/changing docs, no analytics, −95%
   flagship comp. Being early to the venue is its own risk.

## What improves

- **$50K raised upfront** + liquidity bootstrapped from the raised USDC
  (replaces the $25–100K self-seed line item).
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
- [ ] Raise terms re-confirmed with star under Bedrock (supersedes the earlier
      confirmation of $1M company valuation / token = 8.3% of the company):
      $1M launch valuation, zero-equity token, Bedrock preference percentage
      elected, 60/10/10/20 buckets, points convert at the fixed
      $1M-launch-valuation price ($0.0000833/DWELL) from the airdrop.
- [ ] Accept the Solana port scope: Jupiter keeper + Solana Merkle
      distributor + Squads treasury ([04-backend-adaptation.md](04-backend-adaptation.md)
      knobs gain `SOLANA_RPC_URL` / `JUPITER_API` variants).
- [ ] Keep the copy rules regardless of venue: the raise page and every DWELL
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
