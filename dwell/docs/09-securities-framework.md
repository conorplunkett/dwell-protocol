# Securities defensibility framework (tokenomics v2)

> **Purpose and status.** Working framework for the v2 (fully decoupled)
> design — engineering-facing orientation **for securities counsel to
> review, not a legal opinion**. Nothing here concludes that $DWELL "is not
> a security"; the design goal is that no Howey element is clearly satisfied
> for any population and every public statement is true. Research date:
> July 2026. Bedrock is untested in any court or enforcement action —
> "defensible" means exactly that, not "cleared."

## The v2 model in one paragraph

Two systems, no bridge. **dwells** are dollar-denominated earned reward
credits (1,000 = $1.00), funded by ad revenue, redeemable for USDC to a
linked wallet (10% fee) or Claude credits (10% boost). **$DWELL** is a
separate SPL token (star.fun raise under Bedrock) that trades and can pay
for ad campaigns at a spot quote (received tokens held in treasury). Ad
revenue never buys the token; dwells never convert to it; the token is
redeemable for nothing.

## The three populations

| Population | Analysis |
|---|---|
| **Earners** | Not a securities question at all. They invest no money, receive no token, and hold dollar-denominated compensation for attention redeemable at face value (Swagbucks/kickbacks.ai shape; *Forman* consumptive logic; Fuse no-action letter's rebate framing as backstop). The v1 edge case — earned distributions of a floating token — no longer exists. |
| **Raise buyers** | The conceded risk, now carrying the entire Howey exposure. They invest money in a token whose value narratives are the Bedrock structure and secondary trading. Defenses: zero equity/profit/redemption rights; no revenue linkage of any kind; no managerial-effort or value-accrual representations anywhere; Bedrock framed as constraints-on-founder, not rights-for-holders. **Open decision (strongly recommended): exclude US persons + KYC the raise** — the pump.fun mitigation. US users can still earn; they just can't buy from us. |
| **Secondary buyers** | 33-11412's narrowed common-enterprise and representation-centered analysis; *Ripple*/*Binance* help, *Terraform*/*Coinbase* cut the other way. Mitigation identical: total public silence on price, value accrual, and revenue linkage — courts read the whole ecosystem of statements. |

## Why v2 is structurally stronger than v1

- **No revenue→token flow exists.** The buyback/price-support attack (SEC
  2019 framework "efforts of others" factors; *Terraform* post-hoc
  statements; *Coinbase* ecosystem approach) has no target. Nothing needs a
  "settlement, not buyback" defense because there are no buys.
- **No earner ever receives the token**, so no distribution analysis, no
  conversion promise, no snapshot, no prospective-earn-for-services edge.
- **No forced routing / manufactured volume.** Ad payments are USD/USDC;
  $DWELL is one optional payment method at a spot quote, and received
  tokens are **held**, not insta-sold. Routing payments through the token to
  generate volume was considered and rejected: it creates wash-trading-
  adjacent optics, breaches hard rule 1 (the business selling its token,
  repeatedly), and re-links revenue to the token.

## Residual risk register

1. **Raise-buyer exposure** — a public sale for money happened; if profit
   expectation from our efforts is found despite the zero-rights token,
   buyers have rescission claims. Geofencing US persons from the raise is
   the strongest available mitigation; without it this is the #1 risk. Note
   honestly: with the rewards linkage gone, the token's *dominant* value
   narrative is the Bedrock expectancy — an instrument whose value story is
   "constraints on the founder of this company" still points at the
   company. Counsel must look at this squarely.
2. **Treasury sales** — the 10% treasury allocation plus ad-payment tokens
   are disclosed as sellable. Discipline (encoded in
   [01-tokenomics.md](01-tokenomics.md)): pre-announced schedule/plan only,
   no sales while promotional statements run, counsel review before the
   first sale. Discretionary issuer selling into our own market is the
   LBRY pattern; disclosure alone does not cure it.
3. **Marketing** (*SEC v. LBRY*) — one tweet linking the token to revenue
   or price undoes the structure. Copy rules + CI grep are load-bearing.
4. **Money transmission (rewards side)** — dwells are cash-redeemable, so
   the loyalty exemption in most states' money-transmitter law is
   unavailable; USDC payout is CVC delivery (FIN-2019-G001). Mitigation:
   the payout/offramp leg always belongs to licensed partners as
   counterparty of record (hard rules 2–3 in
   [05-legal-structure.md](05-legal-structure.md)); the company never holds
   user funds for retransmission. Claude credits remain the closed-loop
   safe harbor — and the 10% boost deliberately steers users there.
5. **Reserve adequacy (new in v2)** — outstanding dwells are genuine
   dollar-denominated liabilities. The earmarked rewards-pool ledger must
   cover outstanding dwells at all times, publicly (`/v1/reserve`). An
   underfunded reserve is a consumer-protection problem independent of
   securities law.
6. **Grandfathering** — users who earned under the old "1,000 dwells =
   12,000 $DWELL at launch" copy are settled at face value in USDC/credits;
   **no token claim is grandfathered** (that would reimport the deleted
   instrument). The change is announced plainly; terms updated in the same
   release.
7. **FTC** — no quantified earnings claims; sponsored lines identifiable as
   ads (Endorsement Guides).
8. **Pending law is not law** — CLARITY Act and the SEC innovation-exemption
   rulemaking would help; do not build on them until final.
9. **No founder-liability elimination.** Sections 5/12(a)(1), state blue-sky,
   and control-person liability survive all structuring. This framework
   reduces the probability of a violation; it indemnifies no one.

## Counsel gate (pre-raise, blocking)

- [ ] Securities counsel reviews: this memo, the raise (star.fun × Bedrock),
      the constitutional documents, every public copy surface, the treasury-
      sale plan, and the raise geofence/KYC decision (recommended: exclude
      US persons).
- [ ] Bedrock diligence: executed docs match the published framework;
      Foundation directors identified; star.fun integration confirmed in
      writing.
- [ ] Money-transmission review of the USDC payout rail (partner as
      counterparty of record; company fund-flow).
- [ ] Tax: W-9/1099 pipeline (unchanged); treasury/ad-payment token
      treatment.
- [ ] CI banned-language grep green on every public surface.

## Sources

Same research base as v1 (retained for counsel): SEC/CFTC Release 33-11412
(Mar 17, 2026) via WilmerHale/Mintz/Morgan Lewis/Paul Weiss alerts; Fuse
no-action letter (Dec 2025); TurnKey Jet; Pocketful of Quarters; SEC 2019
framework; *Ripple*; *Terraform*; *Coinbase*; *Binance*; *LBRY*; *Forman*;
*Edwards*; *Tomahawk*; Hyperliquid docs + ASXN; pump.fun PUMP sale coverage;
Bedrock (bedrockfndn.org, bedrock.meteora.ag/learn) + Pine Analytics;
FinCEN FIN-2019-G001 / FIN-2014-R002 / 31 CFR 1010.100; CSBS MTMA;
CLARITY Act H.R. 3633 (not law).
