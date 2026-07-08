# Securities defensibility framework

> **Purpose and status.** This is the working framework for making $DWELL
> defensible under Howey — engineering-facing orientation **for securities
> counsel to review, not a legal opinion**. Nothing here concludes that DWELL
> "is not a security"; the design goal is that no Howey element is clearly
> satisfied for any user population, and that every public statement is
> factually true. Research date: July 2026. The two structures we borrow from
> (Hyperliquid's fee-conversion documentation style and Bedrock's
> token/equity separation) are **untested in any court or enforcement
> action** — "defensible" means exactly that, not "cleared."

## The three populations

Howey applies transaction-by-transaction (economic reality: *United Housing
Found. v. Forman*, 421 U.S. 837 (1975); *SEC v. Edwards*). DWELL touches
three distinct populations and the analysis differs for each:

| Population | Investment of money? | Framework position |
|---|---|---|
| **Earners** (watch ads, earn dwells) | **No.** They never pay; they are compensated for attention. SEC Release 33-11412 (Mar 17, 2026): distributions to people who provide no bargained-for consideration lack an "investment of money." Caveat: *prospective* earn-for-services programs are the unresolved edge — services can be consideration — so we also frame earnings as consumptive rebates (Fuse no-action letter, Dec 2025: in-ecosystem earned rewards are "a type of rebate," not profits; accord TurnKey Jet and Pocketful of Quarters no-action letters, 2019). Cash-for-attention comparables (Swagbucks, Rakuten, kickbacks.ai) have never drawn a securities action. | The load-bearing wall. Protect it: earners never purchase, points are non-transferable pre-launch, and earn copy is compensation framing only. |
| **Raise buyers** (star.fun curated raise) | **Yes — conceded.** The raise is a sale for money and cannot be documented away. | Defense rests on the *other* prongs: the token carries zero equity/profit/dividend rights (Bedrock), no managerial-effort or value-accrual promises are made ("explicit and unambiguous" representations standard, 33-11412), and the raise-page copy is mechanics-as-facts. **Open decision (recommended): exclude US persons + KYC the raise** — the pump.fun mitigation, and the single largest liability reducer available while keeping the raise. US users can still *earn* even where they cannot *buy*. |
| **Secondary buyers** (Meteora pool) | Yes, but not from us. | 33-11412 narrows common enterprise and centers issuer representations at offering; *Ripple* (programmatic sales) and *Binance* (transaction-by-transaction) help; *Terraform* and *Coinbase* (ecosystem approach) cut the other way. Mitigation is the same: no public statements that create profit expectations, anywhere, ever — courts read the whole ecosystem of statements. |

## Campaign buys are settlement, not buybacks

The protocol's per-campaign market buys superficially resemble
revenue-buyback tokenomics (Hyperliquid's Assistance Fund, pump.fun's
revenue buybacks). The framework treats them differently, because they *are*
different — and the distinction is substantive, not cosmetic:

- **Purpose.** Every buy exists to acquire tokens that are immediately owed
  to identified viewers and referrers at the campaign's locked rate. It is a
  payment flow — payroll, in substance — not supply reduction, not price
  support, not value accrual to holders. Nothing is burned; the treasury leg
  is a protocol reserve, never described as scarcity.
- **Why this matters more than disclosure timing.** We researched the
  "retroactive-only buyback disclosure" theory (report past buys, promise
  nothing) and it is **weaker than commonly assumed**: the SEC's 2019
  framework lists buybacks/burning as "efforts of others" price-support
  factors *regardless of announcement*, and the caselaw (Terraform's
  post-hoc re-peg statements; Coinbase's ecosystem approach crediting
  deflationary-strategy statements) treats a publicized pattern of past
  buys as functionally an implied promise. Disclosure tense is marginal
  hygiene, not a shield. **The substantive defense is the settlement
  purpose** — the buys discharge liabilities to earners; they are not
  discretionary treasury management aimed at price.
- **Hyperliquid's replicable lesson is documentation discipline, not a
  loophole.** Its docs describe fee conversion mechanically and in the
  present tense, promise no percentage, and never use value-accrual
  language; its *actual* shield (never sold tokens, buys executed in
  consensus-level code) is not available to us. We adopt the discipline:
  - Describe the mechanic as fact: "when a campaign's payment clears, the
    token-side tranche is converted to DWELL at market and distributed at
    the campaign's locked rate."
  - **No promised percentage on any public surface.** The token-side share
    (currently 90%, `RESERVE_TRANCHE_BPS`) is configuration — describe as
    "currently," changeable, and never as a commitment.
  - **Never**: "buyback," "price support," "value accrual," "deflationary,"
    "scarcity," burn framing, or any forward-looking statement about future
    buys. Discretion to change or stop the mechanic is expressly reserved
    in the terms.
  - Retroactive transparency reporting (the campaign-buy ledger) is fine and
    good hygiene — but the memo is explicit that it is not what carries the
    argument.

## The Bedrock structure (raise leg)

Confirmed against Bedrock's published materials (bedrock.meteora.ag/learn;
Bedrock is a Meteora × GVRN venture, launched Mar 2026; star.fun is an
integrated launchpad):

- Holding DWELL confers **zero equity rights** — no dividend, no governance,
  no claim on company revenue or assets. The Bedrock Foundation holds
  preference equity (10–30%, founder's election) plus a golden share in the
  BVI project company; founders retain ≥70% ordinary shares.
- The only token→equity path: a holder of **≥30% of total supply** may
  trigger a mandatory buyout of remaining tokens at (7-day TWAP × 1.30);
  only at **100% of supply** may the acquirer seek the Foundation's
  preference equity, via SPA, subject to accredited-investor status and
  KYC/AML — and the Foundation's "standing invitation to treat" is
  **not a binding offer**. A token holder therefore has a *path* to equity,
  not a *right* to equity — no enforceable equity claim exists.
- Honest risk: a regulator could still argue the buyout floor gives the
  token "the economic characteristics of a security" (the 2026 release's
  own anti-label language), and any marketing that calls the token
  "ownership" would hand them the argument. **Never describe DWELL as
  ownership, equity, or a claim on the company.** The prior "8.3% of the
  company" framing is dead and must not reappear.

## Redemption menu ruling

| Path | Status | Why |
|---|---|---|
| **Claude credits** | Flagship redemption | Closed-loop, consumptive — the strongest ground (Fuse/TurnKey/Pocketful of Quarters no-action line; FinCEN closed-loop prepaid exclusion ≤$2,000/device; MTMA loyalty exemption). |
| **Wallet claim ($DWELL)** | Unchanged | Merkle claim to a user-controlled wallet; hard rules 2–3 of [05-legal-structure.md](05-legal-structure.md) keep custody and offramp with licensed partners. |
| **Cash via Stripe** | **Points only, never the token** | Cash-for-attention is compensation (no investment of money) — the kickbacks.ai/Swagbucks shape. But cash redemption forfeits the MTMA loyalty exemption and is the money-transmission cliff: fund flows must stay Stripe-settled (platform never holds user funds for retransmission), never cron-swept, and the company **never buys tokens back from users** (hard rule 1). Cash-out remains a feature of *points*, not of the token. |

**No dollar peg, anywhere.** Dwells/points are token-denominated. The
"1,000 dwells = $1.00" legend is removed from every surface; any dollar
figure shown is an estimate at current market price, labeled as such.
Engineering follow-up: the ledger stores USD-denominated millicents and
client code converts by ×1000 — displays must never present that math as a
guarantee; migrate display logic to token denomination.

## Residual risk register (what this framework does NOT fix)

1. **Raise-buyer exposure.** A public sale for money happened; if a court
   finds profit expectation from our efforts despite the zero-rights token,
   raise buyers have rescission claims. Geofencing US persons from the raise
   is the strongest available mitigation; without it this is the #1 risk.
2. **Bedrock is 4 months old and untested.** No court, no SEC/CFTC comment,
   no completed buyout exists. The "economic characteristics" counter-
   argument is live.
3. **Marketing is the perennial killer** (SEC v. LBRY). One tweet promising
   price appreciation can form an investment contract around an otherwise
   defensible token. The copy rules and CI grep are load-bearing.
4. **FTC exposure is separate from securities.** Quantified earnings claims
   ("earn up to $X/mo") risk deceptive-earnings-claims doctrine; sponsored
   lines must be identifiable as ads (Endorsement Guides).
5. **Money transmission** if cash redemption drifts from the Stripe-settled,
   points-only design, or if the company ever sells/redeems tokens as a
   business (FinCEN administrator status, FIN-2019-G001).
6. **Pending law is not law.** CLARITY Act (House-passed 2025; Senate
   committee 2026) and the SEC innovation-exemption rulemaking would help
   materially — do not build on them until final.
7. **No founder-liability elimination.** Sections 5 and 12(a)(1) liability,
   state blue-sky laws, and control-person liability survive every
   structuring choice here. The framework reduces the probability of a
   violation; it does not indemnify anyone.

## Counsel gate (pre-raise, blocking)

- [ ] Securities counsel reviews: this memo, the raise structure (star.fun ×
      Bedrock), the token's constitutional documents, every public copy
      surface, and the geofence/KYC decision for the raise.
- [ ] Decision recorded: US persons excluded from the raise? (Recommended:
      yes.)
- [ ] Tax counsel: issuer-side treatment of allocations; user W-9/1099
      pipeline unchanged from [05-legal-structure.md](05-legal-structure.md).
- [ ] Bedrock diligence: confirm the executed constitutional documents match
      the published framework; identify the Foundation's directors; confirm
      the star.fun integration mechanics in writing.
- [ ] CI banned-language grep extended (see [05](05-legal-structure.md)) and
      green on every public surface.

## Sources

- SEC/CFTC joint interpretive release 33-11412 (Mar 17, 2026) — via
  WilmerHale, Mintz, Morgan Lewis, Paul Weiss client alerts; primary PDF to
  be read by counsel (sec.gov/files/rules/interp/2026/33-11412.pdf).
- Fuse no-action letter (Dec 2025); TurnKey Jet (Apr 2019); Pocketful of
  Quarters (Jul 2019).
- SEC "Framework for 'Investment Contract' Analysis of Digital Assets"
  (2019) — buybacks/burns as efforts-of-others factors.
- *SEC v. Ripple* (S.D.N.Y. 2023); *SEC v. Terraform* (S.D.N.Y. 2023);
  *SEC v. Coinbase* (S.D.N.Y. 2024); *SEC v. Binance* (D.D.C. 2024);
  *SEC v. LBRY* (D.N.H. 2022); *Forman*; *Edwards*; *In re Tomahawk* (2018).
- Hyperliquid docs (hyperliquid.gitbook.io — fees/assistance fund);
  ASXN buyback data; pump.fun PUMP sale coverage (US/UK excluded, KYC) and
  Apr 2026 revenue-buyback contract (CoinDesk).
- Bedrock: bedrockfndn.org, bedrock.meteora.ag/learn; Pine Analytics,
  "What is Bedrock?"
- FinCEN: FIN-2019-G001; FIN-2014-R002; prepaid access rule (31 CFR
  1010.100); CSBS Money Transmission Modernization Act + state tracker.
- CLARITY Act: H.R. 3633 (House-passed Jul 17, 2025; Senate Banking
  advanced May 14, 2026 — **not law**).
