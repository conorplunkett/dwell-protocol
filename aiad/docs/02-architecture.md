# AIAD system architecture

Two operating modes, switched by one knob (`TOKEN_MODE=points|live`). Points
mode is the launch state; live mode activates at TGE. Both reuse freeai.fyi's
existing money core: the append-only millicent ledger, server-authoritative
impression tokens, and the dual Node-reference / Supabase-edge backend (see
[04-backend-adaptation.md](04-backend-adaptation.md)).

## Points mode (Phase 1)

```
 advertiser ──card──▶ Stripe Checkout ──webhook──▶ campaign_credit (ledger)
                                        │
                                        ├──▶ 5% business margin (fiat, stays in Stripe balance)
                                        └──▶ 90% tranche ──▶ fiat sweeper (cron)
                                                              │  Stripe payout → bank → Coinbase
                                                              │  USD → USDC (Advanced Trade API)
                                                              ▼
                                                     USDC RESERVE  (segregated Coinbase account
                                                      │             or Base Safe; company-owned)
                                                      ▼
                                            reserve_allocation rows (ledger mirror)
                                            public GET /v1/reserve attestation feed

 user views ad ──impression token serve/redeem──▶ ledger:
     points_credit            (viewer, 50% of the tranche's dollar value)
     referral_points_credit   (referrer, 15% — skipped if unreferred)
     protocol_points_credit   (protocol, 35% or 50%)
 balances = SUM(ledger)  ·  1,000 points = $1.00  ·  non-transferable, no withdrawal
```

## Live mode (Phase 2, post-TGE)

```
 advertiser ──card──▶ Stripe ──webhook──▶ campaign paid
                                  │
                                  └──▶ fiat sweeper: USD → USDC → Base
                                                        │
                                                        ▼
                              CampaignFunder.swapAndFund(campaignId, usdcIn, minOut, 0x calldata)
                                    │  swap via 0x route (slippage-guarded)
                                    ├──▶ 65% of AIAD → MerkleRewardsDistributor (user-claimable)
                                    ├──▶ 35% of AIAD → protocol treasury Safe
                                    │        └── burnBps slice → burn (default 0)
                                    └──▶ emits CampaignFunded(campaignId, usdcIn, aiadOut)
                                              │
                                              ▼
                              token_campaign_pools row → locked rate = aiadOut ÷ impressions

 user views ad ──same impression pipeline──▶ ledger accrual in AIAD units at the locked rate
 root publisher (cron): builds cumulative (address, cumulativeAmount) tree over accrued AIAD
     → MerkleRewardsDistributor.setRoot(root, epoch+1)
 user claims: portal fetches proof (GET /v1/web/token/claim-proof) → claim() → wallet
 cash-out: user swaps AIAD→USDC on the DEX and offramps via licensed partner
           (Zero Hash / MoonPay / Coinbase) — the company never touches this leg
```

## Campaign lifecycle

`pending_payment → pending_review → active → exhausted` (unchanged from
freeai.fyi), with one added transition: on `markCampaignPaid`, the 90% tranche
is committed — points mode records `reserve_allocation`; live mode enqueues the
`swapAndFund` keeper job. A rejected campaign refunds via Stripe as today; its
tranche is released from the reserve (points) or its pool is returned to the
treasury before any impressions were served (live).

## Key custody

| Key / account | Holds | Holder | Blast radius if lost/compromised |
|---|---|---|---|
| Issuer treasury Safe (multisig) | AIAD allocations, protocol treasury | 2-of-3: founder + 2 trusted signers (hardware) | Whole treasury — highest protection |
| Distributor `owner` | pause/unpause, set rootSetter | The Safe | Can pause claims; cannot take funds |
| `rootSetter` ops key | publishes Merkle roots | Backend keeper (KMS/env) | Capped at the Distributor's current balance — fund per-epoch, not in bulk |
| Keeper key | calls `swapAndFund` | Backend keeper (KMS/env) | Capped at USDC in flight for one campaign |
| Coinbase API credentials | USD→USDC conversion, reserve | Ops, IP-allowlisted, withdrawal-address-locked to the Safe | Reserve — mitigate with address allowlisting |
| Stripe | fiat in | Existing | Same as today |

Users custody their own tokens (Privy embedded wallets — user-controlled TEE
keys, exportable). The company never holds user tokens with unilateral control
— this is a legal load-bearing wall, not just UX
([05-legal-structure.md](05-legal-structure.md)).

## Epoch / root lifecycle (live mode)

`accruing → snapshot → root_published → claimable`

- Roots are **cumulative**: each leaf is `(address, lifetime cumulativeAmount)`;
  the contract pays `cumulative − claimed[address]`. A stale proof can never
  double-pay; a missed epoch self-heals at the next root.
- `setRoot` requires `epoch == current + 1` — no replays or rollbacks.
- Cadence: weekly at launch (gas on Base is sub-cent; cadence is an ops choice,
  not a cost one).

## Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Bad Merkle root published | Reconciliation job: onchain root vs. rebuilt tree | `pause()`, publish corrected root at `epoch+1`; cumulative amounts self-heal |
| Swap fails / reverts (slippage, 0x outage) | Keeper job alert | Retry with fresh quote; campaign stays unfunded and unserved until funded |
| Coinbase outage | Sweeper alert | Tranches queue in Stripe balance; points accrual is unaffected (ledger-only) |
| Reserve ↔ points drift (points mode) | Daily attestation job: reserve balance vs. `SUM(reserve_allocation)` | Halt new campaign approvals until reconciled |
| Chain reorg | Indexer waits for finality (Base ~minutes) before writing `token_campaign_pools` / claim rows | Re-index from last finalized block |
| Distributor bug post-deploy | Audit + Base Sepolia dry-run gate ([06-launch-checklist.md](06-launch-checklist.md)) | `pause()`; deploy fixed distributor; re-publish cumulative root there |

## Trust boundaries

- **Ledger is authoritative** for what users are owed; the chain is
  authoritative for what has been claimed. The reconciliation invariant:
  onchain `claimed[addr] ≤` ledger cumulative entitlement, per address.
- The backend never signs user transactions; it only publishes roots and funds
  campaigns. Anyone can execute `claim()` *for* an address (gas sponsorship),
  but funds only ever go *to* the entitled address.
- Public transparency surfaces: `GET /v1/reserve` (points), `CampaignFunded`
  events + `GET /v1/token/pools` (live) — the same numbers users see in the
  portal.
