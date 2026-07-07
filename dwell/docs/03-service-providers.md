# Service providers

The stack, one provider per job, each with a named fallback. Research date:
July 2026 — re-verify pricing before contracts are signed.

| Job | Pick | Fallback |
|---|---|---|
| Chain | Base | Solana (only if fees ever dominate; loses ERC-20 tooling) |
| USD → USDC (live-phase buys) | Coinbase Advanced Trade | Bridge (Stripe-owned) |
| USDC → DWELL routing | 0x Swap API | Direct Aerodrome router |
| Liquidity venue | Aerodrome Slipstream | Uniswap v4 |
| User wallets | Privy | Coinbase CDP Embedded Wallets |
| User cash-out (offramp) | Zero Hash or MoonPay | Coinbase Offramp, Bridge |
| Job automation (later) | Gelato | Chainlink Automation; plain cron is fine at launch |

> **star.fun path:** if the token launches on star.fun
> ([07-starfun-launch.md](07-starfun-launch.md)) the chain is **Solana** and
> three rows change: routing = **Jupiter swap API**, liquidity = **Meteora**
> (seeded by the launchpad, no self-seed cost), treasury multisig = **Squads**.
> Privy, Coinbase (fiat→USDC), and the offramp partners are unchanged — Privy
> and the offramps support Solana.

## Base (chain)

Coinbase's L2. Sub-cent transactions, native Coinbase onramp integration, the
strongest 2026 consumer-app ecosystem (Blackbird's Flynet is a Base L3), and
standard Solidity/ERC-20 tooling — which is what `../contracts` targets.
Canonical USDC on Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
Env: `BASE_RPC_URL`.

## Coinbase Advanced Trade (fiat → USDC, live-phase conversion)

Business account via Coinbase Developer Platform. USD→USDC conversion is
free/near-free; API-driven; feeds the live-phase campaign buys (there is no
points-phase cash reserve — the 90% tranche is a ledger earmark until token
launch). Trading fees only matter if we ever trade beyond conversion
(0.60%/1.20% maker/taker at low volume, falling with volume). Buying crypto
for the company's own account is "user" activity under FinCEN guidance — not
money transmission (see [05-legal-structure.md](05-legal-structure.md)).
Env: `COINBASE_API_KEY`, `COINBASE_API_SECRET`.
Fallback: **Bridge** (Stripe-owned, ~0.4–0.8% on conversions) keeps the whole
fiat leg inside the Stripe ecosystem — attractive if Stripe ships deeper
stablecoin payouts.

## 0x Swap API (USDC → DWELL)

Aggregated routing with firm quotes — the keeper fetches a quote, derives
`minDwellOut`, and passes the route calldata to `CampaignFunder.swapAndFund`.
Free tier suffices at launch. Env: `ZEROX_API_KEY`, `MAX_SLIPPAGE_BPS`.
Fallback: call the Aerodrome router directly (one pool, less optimal routing,
zero external dependency).

## Aerodrome Slipstream (liquidity)

The dominant concentrated-liquidity venue on Base (~90% of CL volume). Seed an
DWELL/USDC pool with **$25–100K+** initial depth — this is the biggest hidden
capital cost and the main defense against buy/sell whipsaw
([01-tokenomics.md](01-tokenomics.md) ▸ Risks). Start with a wide-range
position owned by the treasury Safe. Fallback: Uniswap v4 (its Liquidity
Launcher bundles token launch + LBP-style discovery if we want price discovery
at TGE).

## Privy (user wallets)

Email-based embedded wallets: TEE key management, user-controlled (the company
never has unilateral control — a legal load-bearing wall), user-initiated
export, and **wallet pregeneration from an email address** — which maps
perfectly onto the platform's magic-link accounts: every user can have a wallet
waiting before they ever touch crypto. Free to 10K MAU (~$299–499/mo beyond).
Stripe-owned since 2025 — same vendor family as payments. Env: `PRIVY_APP_ID`,
`PRIVY_APP_SECRET`. Fallback: Coinbase CDP Embedded Wallets (Base-native,
per-operation pricing).

## Zero Hash / MoonPay (cash-out)

Users swap DWELL→USDC on the DEX (self-custody, permissionless), then offramp
USDC→bank through a licensed partner **who is the counterparty of record**:
they run KYC, hold the state MTLs + NY BitLicense, and carry the 1099-DA
broker reporting duty (confirm contractually). The company never touches this
leg — see [05-legal-structure.md](05-legal-structure.md) hard rules. Zero Hash
and MoonPay have the strongest full-stack US coverage; Coinbase Offramp and
Bridge are credible alternates. Integration is a hosted widget/redirect from
the portal's cash-out tab.

## Gelato (automation, later)

At launch the keeper jobs are a cron'd Node process (see
[04-backend-adaptation.md](04-backend-adaptation.md) §E). If/when ops should
be trust-minimized, move `swapAndFund` triggering and root publishing to
Gelato Web3 Functions (fallback: Chainlink Automation). Not a launch
requirement.

## Advertiser USDC checkout

Planned in [08-usdc-checkout.md](08-usdc-checkout.md): crypto-native
advertisers pay in USDC from their own wallet via one atomic Solana
transaction — 10% to the treasury, 90% Jupiter-swapped into DWELL straight to
the distributor vault, no funds ever held by our system. Same 90/10 split as
the card path (this supersedes the earlier ~97.5%-to-token-side sketch). Card
checkout remains the default; this is an additive option, not a migration.
Providers: Jupiter Swap API, Solana Pay, Helius, deBridge (cross-chain),
TRM (screening) — see the plan doc's table.
