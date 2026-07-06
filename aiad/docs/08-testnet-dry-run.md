# Base Sepolia dry-run — the executable plan

This is the concrete runbook for **launch-checklist Phase 2, items 1 & 3**
([06-launch-checklist.md](06-launch-checklist.md)): compile and test the
contracts on the pinned toolchain, then run the **entire money loop on Base
Sepolia** — a real Stripe **test-mode** purchase, the fiat sweeper, the
on-chain campaign buy, 60/10/30 earnings accrual, a published Merkle root, a
user claim, and the failure drills — with every transaction hash recorded.

It is written to be executed **autonomously by the agent in the remote
sandbox** (Claude Code on the web). The sandbox has been probed and can do
all of it: the Base Sepolia public RPC answers (`eth_chainId = 0x14a34`),
the Foundry installer and `api.stripe.com` are reachable through the egress
proxy, Docker + Postgres 16 are installed for the backend, Node 22 runs the
keeper scripts, and the pre-installed headless Chromium (Playwright) can
complete a hosted Stripe Checkout page with the standard test card.

No real money moves at any point: Stripe runs in **test mode** (card
`4242 4242 4242 4242`), the chain is a **testnet** (gas from a faucet), and
the dollar leg on-chain is a test USDC. This run does **not** discharge the
audit gate — it precedes it.

---

## Inputs required before the run (the only human steps)

| # | Input | Why | How |
|---|---|---|---|
| 1 | **Stripe test-mode secret key** (`sk_test_…` or a restricted key with Checkout write) | The advertiser buy must be a real Stripe Checkout session, paid with the test card, delivering a real `checkout.session.completed` webhook | Stripe Dashboard → Developers → API keys (test mode). Provide as `STRIPE_SECRET_KEY` (session secret / env), never committed |
| 2 | **~0.05 Base Sepolia ETH** to the deployer address the agent prints in Stage 1 | Gas for every transaction below. Faucets (Coinbase CDP, Alchemy, Circle) are CAPTCHA/account-gated, so the agent cannot self-serve | Any Base Sepolia faucet, or send from an existing testnet wallet. Alternatively provide a funded throwaway private key |
| 3 | *(optional)* Etherscan/BaseScan API key | `--verify` on deploy so the contracts are readable on sepolia.basescan.org | Skippable — verification is cosmetic for a dry run |

Everything else — keys, USDC, liquidity, the backend, the buyer — the agent
creates itself.

## Cast of keys (generated fresh, testnet-only, throwaway)

On testnet, single EOAs stand in for the mainnet roles (the real key ceremony
is checklist item 4, out of scope here):

| Key | Stands in for | Signs |
|---|---|---|
| `deployer` / `treasury` | Issuer treasury Safe | Deploys, owns Funder + Distributor, receives the 1B mint and the 30% legs, funds epochs |
| `rootSetter` | Backend root-publisher KMS key | `setRoot` |
| `keeper` | Backend sweeper KMS key | `swapAndFund` |
| `viewer` | An earning user's wallet (referred) | `claim` |
| `referrer` | The referrer's wallet | `claim` |
| `viewer2` | An earning user with **no** referrer | accrues only — proves the 40% unreferred path and the treasury shortfall leaf |

Private keys live only in the sandbox session; addresses and tx hashes are
the recorded output.

---

## Stage 0 — toolchain + the merge gate (checklist item 1)

1. Install Foundry (`foundryup`); pin `solc 0.8.26` per `foundry.toml`.
2. `git submodule update --init --recursive` — OZ v5.6.1
   (`5fd1781b…`) and forge-std v1.16.2, as pinned.
3. `cd aiad/contracts && forge build && forge test -vv`.

**Gate:** the contracts were authored without a Solidity toolchain
([contracts/README.md](../contracts/README.md)); a red build or test stops
the run here and the fixes become their own reviewed commit before anything
touches a network.

## Stage 1 — keys and gas

1. `cast wallet new` × 6 → the cast above; print all addresses.
2. **Pause for input 2**: user funds `deployer` with ~0.05 ETH.
3. Deployer disperses 0.005 ETH each to `rootSetter`, `keeper`, `viewer`,
   `referrer` (4 txs).

## Stage 2 — the testnet dollar and the swap venue

Two AIAD-side test contracts, deployed under `contracts/test/` sources so
they can never ship to mainnet by accident:

- **TestUSDC** — 6-decimal mintable mock. (Circle's real Base Sepolia USDC
  `0x036C…F7e` is CAPTCHA-faucet-gated; a mock keeps the run autonomous. If
  the user prefers, they can faucet real testnet USDC and the run uses that
  address instead — nothing else changes.)
- **FixedRateSwapRouter** — a minimal swap target: pulls the approved USDC,
  pays out AIAD at a configured rate from its own balance. The treasury
  pre-funds it with AIAD (its stand-in for DEX liquidity). This exercises
  **exactly** the properties `swapAndFund` guards: arbitrary calldata against
  an owner-set target, exact approval + reset, balance-delta measurement,
  `minAiadOut` slippage floor, and the "route may not raid queued tranches"
  check. (A 0x-quoted route is untestable here — 0x has no AIAD liquidity on
  Sepolia; routing fidelity is a mainnet-canary concern, not a dry-run one.
  Optional stretch: seed a Uniswap v3 AIAD/TestUSDC pool on Base Sepolia and
  route through the real SwapRouter02.)

## Stage 3 — deploy and wire (checklist item 5's rehearsal)

`forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org
--broadcast` with `TREASURY_SAFE=treasury`, `ROOT_SETTER`, `KEEPER`,
`USDC=TestUSDC`, `SWAP_TARGET=FixedRateSwapRouter`, then the post-deploy
wiring from the treasury key. On-chain transactions:

| Tx | What | Verify |
|---|---|---|
| T1 | Deploy `AIAD` | 1B minted to treasury; no owner, no mint function |
| T2 | Deploy `MerkleRewardsDistributor` | owner = treasury, rootSetter set, epoch 0 |
| T3 | Deploy `CampaignFunder` | usdc/aiad/distributor/treasury immutables correct |
| T4 | Deploy `TestUSDC` | — |
| T5 | Deploy `FixedRateSwapRouter` | rate set |
| T6 | treasury → router: AIAD liquidity transfer | router AIAD balance |
| T7 | `funder.setSwapTarget(router)` | `SwapTargetUpdated` |
| T8 | `funder.setKeeper(keeper, true)` | `KeeperUpdated` |

## Stage 4 — the backend and the Stripe buy (points mode, checklist Phase 1 item 3's chain-side sibling)

1. **Backend up**: Postgres 16 in Docker, `server/db/schema.sql` +
   migrations, seed, run the reference Node server on :8787 with the
   user's `STRIPE_SECRET_KEY` (test mode) — i.e. `make server-up` *without*
   `DEVNET=1`, so the real Stripe path is live.
2. **The buy**: `POST /v1/checkout` creates the campaign
   (`pending_payment`) and a real test-mode Checkout Session; the agent
   opens `session.url` in headless Chromium and pays with
   `4242 4242 4242 4242`, any future expiry, any CVC.
3. **The webhook**: two paths, in preference order —
   - Stripe CLI (single Go binary): `stripe listen --forward-to
     localhost:8787/v1/stripe/webhook`, with the CLI's `whsec_…` as
     `STRIPE_WEBHOOK_SECRET`;
   - fallback if the CLI binary can't be fetched through the proxy: fetch
     the completed session via the Stripe API, wrap it in the
     `checkout.session.completed` envelope, and sign it with the locally
     configured `STRIPE_WEBHOOK_SECRET` (Stripe's `t=…,v1=HMAC-SHA256`
     scheme) — the server-side verification code path still runs in full.
4. **Verify**: `markCampaignPaid` fires; campaign → `pending_review`;
   `campaign_credit` ledger row equals the Checkout amount; admin-approve
   the campaign to `active`.

**Money math recorded here:** gross (what the test card "paid"), the 90%
tranche, the 5%+5% margin/processing remainder — the split
[01-tokenomics.md](01-tokenomics.md) states.

## Stage 5 — the sweeper and the campaign buy (live-mode leg)

The doc-04 keeper jobs are a spec, not shipped code; the dry run implements
them as standalone scripts under `aiad/tools/` (Node 22, dependency-light,
signing keys in env — never the Edge Function), which then become the seed
of the real `keeper/` process:

| Tx | Actor | What | Verify |
|---|---|---|---|
| T9 | sweeper script | Mint/transfer TestUSDC = the campaign's 90% tranche → `CampaignFunder` (stands in for Stripe payout → Coinbase USD→USDC → Base, which has no testnet equivalent) | funder USDC balance = tranche |
| T10 | keeper | `swapAndFund(campaignId-as-bytes32, tranche, minAiadOut, routerCalldata)` | `CampaignFunded` event; **70%** AIAD landed in the Distributor, **30%** in the treasury; `fundedCampaigns[id]` set |
| — | indexer script | Read `CampaignFunded` (after finality) → `token_campaign_pools` row; **locked rate** = `aiadOut ÷ campaign impressions` | rate matches event math to the wei |

## Stage 6 — earnings ("every transaction *and earnings*")

Drive the real earning loop against the local API (the `make devnet-earn`
machinery: register device → magic-link → serve/redeem impression tokens),
for three users:

- `viewer` — referred by `referrer` (real referral attribution),
- `viewer2` — unreferred,
- enough impressions on each to make the split arithmetic visible.

Then the snapshot script computes, per impression, from the ledger:
**viewer 60% / referrer 10% / protocol 30%** of the tranche (and **40%
protocol** for `viewer2`'s impressions — the unclaimed referrer leg), in
AIAD at the locked rate. Recorded invariants (doc-04 §A):

- `points + referral + protocol` = the campaign's tranche allocation,
  exactly, in millicents;
- protocol's unreferred surplus = the future **treasury shortfall leaf**.

*(Note: the production 60/10/30 split lands in `server/src` + the edge
function per doc-04 §B — both backends in one commit, per AGENTS.md. The dry
run computes the split in the snapshot script from raw ledger events so the
chain loop can be proven **before** that backend change merges; the script's
math is the reference the backend change is then tested against.)*

## Stage 7 — root, claims, second epoch

Merkle mechanics use `@openzeppelin/merkle-tree` (StandardMerkleTree —
double-hashed `(address, uint256)` leaves, sorted pairs: byte-identical to
what `MerkleRewardsDistributor.claim` verifies).

| Tx | Actor | What | Verify |
|---|---|---|---|
| T11 | treasury | Fund Distributor **for epoch 1 only** (standing rule: never in bulk) | balance = epoch-1 total |
| T12 | rootSetter | `setRoot(root₁, 1, total₁)` — leaves: viewer, referrer, **treasury shortfall leaf** | `RootUpdated`; epoch=1 |
| T13 | viewer | `claim(viewer, cumulative₁, proof)` | `Claimed`; wallet AIAD = 60% share |
| T14 | referrer | `claim(...)` | wallet AIAD = 10% share |
| T15 | anyone | Re-submit T13's proof | pays **zero delta** (cumulative design) |
| — | — | Accrue more impressions → epoch 2 snapshot | — |
| T16 | treasury | Fund epoch 2 delta | — |
| T17 | rootSetter | `setRoot(root₂, 2, total₂)` | rejects epoch ≠ current+1 first (see drills) |
| T18 | viewer | Claim again with the epoch-2 cumulative proof | pays exactly the **delta** since T13 |

Reconciliation invariant checked after every claim: on-chain
`claimed[addr] ≤` ledger cumulative entitlement, per address.

## Stage 8 — failure drills (from [02-architecture.md](02-architecture.md))

All expected to revert or recover; each outcome recorded:

1. **Bad root**: rootSetter publishes a wrong root at epoch 3 → owner
   `pause()` → corrected root at epoch 4 → un-pause → claims self-heal
   (cumulative amounts absorb the bad epoch).
2. **Slippage**: `swapAndFund` with `minAiadOut` above the router's rate →
   `InsufficientOutput` revert; retry with a fresh "quote" succeeds.
3. **Replay**: `swapAndFund` again for the same campaignId →
   `AlreadyFunded`.
4. **Auth**: `swapAndFund` from a non-keeper → `NotKeeper`; `setRoot` from
   the keeper key → revert; `setRoot` skipping an epoch → revert.
5. **Rescue blocklist**: owner `rescue(USDC…)` / `rescue(AIAD…)` →
   `RescueBlocked`; rescue of a third token succeeds.
6. **Stale proof** — already T15.

## Stage 9 — report

The run's deliverable, committed to the branch:

- a results doc: every tx hash (T1–T18 + drills) linked on
  sepolia.basescan.org, every ledger row id, the Stripe test session id,
  and the three-way reconciliation table (Stripe gross → tranche → USDC in
  → AIAD out → distributor/treasury/claimed);
- the keeper scripts under `aiad/tools/` (sweeper, indexer, snapshot/root
  publisher, claim helper) — the skeleton of the real `keeper/` process;
- any contract fixes Stage 0 forced, as their own commits.

## Order of execution and checkpoints

```
Stage 0 (forge gate) ──▶ Stage 1 (keys) ──▶ [WAIT: user funds deployer]
      ──▶ Stages 2–3 (deploy+wire) ──▶ Stage 4 [needs sk_test] (Stripe buy)
      ──▶ Stage 5 (swapAndFund) ──▶ Stage 6 (earnings) ──▶ Stage 7 (roots+claims)
      ──▶ Stage 8 (drills) ──▶ Stage 9 (report)
```

Stages 0–1 need no user input and start immediately. The single blocking
wait is testnet gas (input 2); the Stripe key (input 1) is only needed from
Stage 4, so chain-side stages proceed while it's pending. Elapsed time is
dominated by Base Sepolia block times and Foundry compile — the whole run
fits comfortably in one session, and every artifact that matters (hashes,
addresses, ledger ids) is committed so the session being ephemeral loses
nothing.

## What this run deliberately does not cover

- **Audit** (checklist gate 2) — this run precedes it.
- **Real USD→USDC** (Stripe payout → bank → Coinbase) — no testnet exists
  for banks; the sweeper's fiat leg stays simulated (T9) until the Phase 1
  points-launch item 3 (Stripe test mode → Coinbase sandbox) is run with a
  Coinbase business sandbox account.
- **0x routing / DEX liquidity** — no AIAD liquidity exists on any testnet
  aggregator; covered by the mainnet canary campaign at TGE.
- **Key ceremony, geofences, W-9 pipeline** — checklist items 4, 9, 10.
