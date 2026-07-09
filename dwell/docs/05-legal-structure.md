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
 · runs the ad marketplace        · unchanged; keeps ALL rewards operations
 · dollar-denominated dwells      Bedrock BVI entity (token side only)
   on the ledger, paid out in     · the star.fun raise + token allocations
   USDC / Claude credits          · never touches the dwells ledger
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

1. **Never sell or redeem DWELL for value, as a business.** FinCEN treats a
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
   DWELL.)

## Securities analysis (US, mid-2026)

- **The favorable ground got simpler under tokenomics v2**: earners never
  receive a token at all — dwells are dollar-denominated reward credits
  settled in USDC or Claude credits. There is no distribution to analyze
  under SEC Release 33-11412; the rewards side is a cash-back program
  (Swagbucks/kickbacks shape), not a crypto distribution. The remaining
  securities question lives entirely with the $DWELL raise
  ([09-securities-framework.md](09-securities-framework.md)).
- **The risk is the marketing, not the mechanics.** Any statement linking ad
  revenue, buybacks, or company success to the token's price is the
  "explicit and unambiguous" value-accrual representation that forms an
  investment contract around an otherwise non-security token. Under v2 there
  are no revenue→token flows to mis-describe — keep it that way: no leg of
  any payment buys $DWELL, and the copy rules below enforce the silence.
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
  2017); Zora (2025, US-facing, "no rights" disclaimers); **Fuse no-action
  letter (Dec 2025)** — in-ecosystem earned rewards are "a type of rebate,"
  not profits (accord TurnKey Jet and Pocketful of Quarters, 2019) — the
  consumptive framing that backstops the earn side if "prospective
  earn-for-services" is ever argued to be consideration. Caution precedents:
  LBRY; Reddit MOON (killed by its own regulatory overhead — a live tradeable
  token cannot be gracefully un-shipped, which is half the argument for
  points-first).
- **No buys exist to defend.** v2 removed every revenue→token flow, so the
  buyback line of attack (2019 framework "efforts of others"; Terraform;
  Coinbase ecosystem approach) has no target. The company also does not
  route ad payments through the token or instantly sell received $DWELL —
  manufactured volume is wash-trading-adjacent and stays out of the design.

## Copy rules by phase (extends AGENTS.md ▸ Voice & copy)

**Always (every public surface, including this repo):**
- State mechanics as facts ("each campaign's rewards pool splits 60% to the
  viewer, 10% to their referrer, 30% to the company — in dollars"). Never
  say or imply the token price will rise or that holding is an investment.
  Shares are configuration, described as "currently," changeable at any
  time; discretion to change the split, fees, or redemption menu is
  reserved in the terms.
- Banned words/framings: "moon," "price will," "appreciate," "going up,"
  "invest," "returns," "passive income," APY-anything — plus "buyback,"
  "price support," "value accrual," "deflationary," "scarcity," burn framing,
  and **any forward-looking statement about future buys**.
- **dwells are dollar-denominated (v2)**: the legend "1,000 dwells = $1.00
  of earned ad value" is factual and allowed. What is banned is any link
  from dwells to the token: no "convert to $DWELL," no snapshot, no
  conversion price, ever.
- **Never describe DWELL as ownership, equity, or a claim on the company**
  (the Bedrock structure separates token and equity — see
  [09-securities-framework.md](09-securities-framework.md)).
- The earn framing is compensation: "get paid for your attention."
- No quantified earnings claims ("earn up to $X/mo") — FTC
  deceptive-earnings-claims exposure, separate from securities.

**dwells (always):** described as what they are — dollar-denominated earned
reward credits (1,000 dwells = $1.00), redeemable for USDC (10% fee) or
Claude credits (10% boost), backed by the earmarked rewards-pool ledger. No
token ticker anywhere near earn copy; dwells never convert to $DWELL.

**$DWELL surfaces (tokenomics page, raise page):** facts only — supply,
allocation, Bedrock constraints, what the token is not. Never "ownership,"
never a percentage of the company, never a buyback or revenue link.

## Tax operations

- **Users**: token/points rewards are ordinary income at fair market value on
  receipt — but only once the user has dominion and control. **Locked,
  non-withdrawable points defer the taxable event**, so the points phase
  creates no user tax reporting. Live phase: collect W-9s before a user
  crosses **$2,000/year** (the 2026 1099-MISC threshold, indexed) and file
  1099-MISC box 3; without a certified TIN, 24% backup withholding applies.
- **Company**: payouts are deductible §162 compensation at face value; USDC
  bought to fund payouts and paid out promptly creates no meaningful gain.
  $DWELL received as ad payment is income at FMV on receipt and sits in
  treasury (disposition later is a separate taxable event — part of the
  treasury-sale counsel gate).
- **1099-DA (broker) stays with the offramp partner** as long as hard rules
  2–3 hold. Confirm the partner's reporting duty contractually.
- Issuer-side treatment of the retained allocations (vesting, 83(b)-analog
  questions, treasury sales) — dedicated tax counsel at TGE.

## If launching via star.fun — read this first

A star.fun raise ([07-starfun-launch.md](07-starfun-launch.md)) is a public
sale of tokens for money — hard rule 1 does not cover it, and no
documentation can. The framework treats the populations separately
([09-securities-framework.md](09-securities-framework.md)): the
**earned-rewards shelter covers earners only**; the **raise is its own
securities event**, mitigated by (a) the **Bedrock structure** — the token
carries zero equity rights; ownership framing is banned — replacing the old
fractional-company-ownership framing this section previously warned about,
(b) a facts-only raise page with no managerial-effort or value-accrual
representations, and (c) the **geofence/KYC decision** (recommended: exclude
US persons from the raise + KYC, the pump.fun mitigation — US users can still
earn even where they cannot buy). Under v2 the raise no longer touches the
rewards program at all — dwells are dollar-denominated and never convert, so
there is no snapshot and no one-way door for earners; the token going live
changes nothing on the earn side. **Counsel sign-off is a pre-raise hard
gate** — on the raise,
the Bedrock constitutional documents, the copy, and the geofence decision.
Hard rules 2–4 (no custody, partner offramps, geofences) apply unchanged on
Solana.

## Phase gates

Points → TGE is a one-way door. Gate criteria and the ordered runbook live in
[06-launch-checklist.md](06-launch-checklist.md); the legal entries there
(counsel sign-off on copy + structure, geofences tested, W-9 pipeline live)
are hard gates, not suggestions.
