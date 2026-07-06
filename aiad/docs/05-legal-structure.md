# Legal posture and corporate structure

> **This is engineering-facing orientation, not legal advice.** The one
> non-negotiable spend before TGE is US securities + tax counsel reviewing the
> token, the copy, and the entity structure. Research date: July 2026 — the
> regulatory ground is moving (in a favorable direction); re-verify at TGE.

## Corporate structure

```
Phase 1 (now)                    Phase 2 (TGE)
─────────────                    ─────────────
Florida LLC (opco)               Florida LLC or DE C-corp (opco)
 · runs the ad marketplace        · unchanged
 · holds the USDC reserve        US issuer subsidiary
 · points on the ledger           · deploys + owns AIAD contracts
                                  · holds token allocations (treasury, team vesting)
                                  · operates CampaignFunder buys
```

- **Florida LLC is viable** for the opco: post-HB 273 (eff. 2023), Florida's
  money-transmitter law (Ch. 560) covers only *intermediaries* with unilateral
  control over third-party transactions — two-party compensation payments are
  outside it, and Florida's statute **explicitly excludes closed-loop reward
  credits** from its "virtual currency" definition, so the points phase isn't
  even arguably covered. Florida's 2026 posture is actively pro-crypto.
- **Delaware C-corp instead** only if institutional fundraising is planned —
  investors effectively require it. Conversion later is routine.
- **US issuer subsidiary at TGE** — liability isolation (token-holder suits hit
  the issuer, not the company holding IP and bank accounts), tax ring-fencing,
  clean cap table. **No offshore foundation**: the 2026 consensus is that
  securities law no longer forces it; residual offshore arguments are tax ones
  for large treasuries — a counsel question at TGE, not a default.
- **Not** a Wyoming DUNA (it wraps decentralized nonprofit communities; a
  company-controlled token has no DAO to wrap).

## The hard rules (architecture-level, non-negotiable)

1. **Never sell or redeem AIAD for value, as a business.** FinCEN treats a
   token issuer who sells or redeems its token as an "administrator" = money
   transmitter — and declining to exercise redemption authority doesn't matter
   if the business does it in practice. No token sale, no ICO, no in-app
   "sell back to us" desk, no company-run redemptions. Distribution as
   compensation + open-market buys for the company's own account are "user"
   activity (FIN-2019-G001; FIN-2014-R002) — that's the safe side of the line,
   and the architecture must stay on it.
2. **Never custody user tokens with unilateral control.** Privy wallets are
   user-controlled by design; the backend never holds user funds it can move
   alone. This keeps the company outside Florida Ch. 560 and most states' MTL
   statutes — and outside the 1099-DA "broker" definition.
3. **The swap/offramp leg always belongs to licensed partners** (Zero Hash /
   MoonPay / Coinbase / Bridge) as counterparty of record — they carry the
   MTLs, the BitLicense, KYC, and broker tax reporting.
4. **Geofence New York and Canada at TGE.** NY's BitLicense uniquely covers
   "issuing a virtual currency" to NY residents even without an exchange leg.
   Canada applies its securities test more broadly than the US, treats in-app
   swap/offramp as a registrable trading platform, and is geofenced by
   essentially every comparable app. (If Canadian users ever matter: pay them
   in USDC — Circle filed the required Canadian undertaking — or points, not
   AIAD.)

## Securities analysis (US, mid-2026)

- **The favorable ground**: SEC Release 33-11412 (Mar 17, 2026) — Howey
  applies to the *transaction and promises*, not the token; utility/reward
  tokens are a recognized non-security category ("digital tools"); and
  **distributions to people who didn't pay** (earned rewards, airdrops) lack
  an "investment of money" and sit outside the securities laws. AIAD users
  never buy the token from us — they earn it. This is the load-bearing wall.
- **The risk is the marketing, not the mechanics.** Publicly promising that
  revenue buys will make the price rise is precisely the "explicit and
  unambiguous" value-accrual representation that forms an investment contract
  around an otherwise non-security token. Hence the copy rules below and the
  protocol-automated (contract-driven, non-discretionary) buy design.
- **SEC v. LBRY is still good law** and is the on-point cautionary case:
  reward distributions were swept into an unregistered offering because of
  promotional value statements plus a large retained founder allocation. Its
  lessons are encoded here as: factual copy, disclosed + vested team
  allocation, no team sales into protocol buys without a pre-announced plan.
- **Do not build on pending law**: the CLARITY Act had no Senate floor vote
  and the SEC's token safe-harbor rule was still pre-proposal as of early
  July 2026. The interpretive release is the solid ground.
- Comfort precedents: Permission.io (US company paying US users its own token
  for ad-watching since ~2018, never enforced against); Brave/BAT (Delaware,
  2017); Zora (2025, US-facing, "no rights" disclaimers). Caution precedents:
  LBRY; Reddit MOON (killed by its own regulatory overhead — a live tradeable
  token cannot be gracefully un-shipped, which is half the argument for
  points-first).

## Copy rules by phase (extends AGENTS.md ▸ Voice & copy)

**Always (every public surface, including this repo):**
- State mechanics as facts ("90% of every ad dollar buys AIAD on the open
  market; 50% of the pool goes to the viewer"). Never say or imply the price
  will rise, that buys are "price support," or that holding is an investment.
- Banned words/framings: "moon," "price will," "appreciate," "going up,"
  "invest," "returns," "passive income," APY-anything.
- The earn framing is compensation: "get paid for your attention."

**Points phase:** points are described as what they are — a dollar-denominated
earned balance, 1:1 backed by the escrowed reserve, convertible at TGE under
published rules. No token ticker hype, no countdowns framed as buying
opportunities (there is nothing to buy — ever).

**Live phase:** claims, locked rates, and pool splits are shown as data
(amounts, tx links). The cash-out path is presented as the stability option,
without advice in either direction.

## Tax operations

- **Users**: token/points rewards are ordinary income at fair market value on
  receipt — but only once the user has dominion and control. **Locked,
  non-withdrawable points defer the taxable event**, so the points phase
  creates no user tax reporting. Live phase: collect W-9s before a user
  crosses **$2,000/year** (the 2026 1099-MISC threshold, indexed) and file
  1099-MISC box 3; without a certified TIN, 24% backup withholding applies.
- **Company**: payouts are deductible §162 compensation at FMV. Buying tokens
  and distributing them immediately keeps basis ≈ FMV, so no meaningful gain
  on the payout leg (warehousing bought tokens would create one — don't).
- **1099-DA (broker) stays with the offramp partner** as long as hard rules
  2–3 hold. Confirm the partner's reporting duty contractually.
- Issuer-side treatment of the retained allocations (vesting, 83(b)-analog
  questions, treasury sales) — dedicated tax counsel at TGE.

## Phase gates

Points → TGE is a one-way door. Gate criteria and the ordered runbook live in
[06-launch-checklist.md](06-launch-checklist.md); the legal entries there
(counsel sign-off on copy + structure, geofences tested, W-9 pipeline live)
are hard gates, not suggestions.
