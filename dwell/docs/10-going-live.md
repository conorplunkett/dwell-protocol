# Going live with crypto checkout — operator runbook

> **Status:** the code is done and merged. USDC and SOL advertiser payments work
> today, with **no dependency on the $DWELL token existing** (tokenomics v2 —
> see [01-tokenomics.md](01-tokenomics.md) and [08-usdc-checkout.md](08-usdc-checkout.md)).
> The only thing standing between "merged" and "taking payments" is four wallet
> addresses in the deployment's environment. This is that checklist.

The backend never holds a private key. It builds *unsigned* Solana transactions
that the advertiser's own wallet signs (Solana Pay), and it reads the chain
read-only to verify a payment landed. So "going live" is a config task, not a
key-custody task — you are only ever pasting **public addresses**.

---

## 1. What you're creating

Two wallets, four addresses. Each payment splits into two on-chain legs:

| Leg | Goes to | Purpose |
| --- | --- | --- |
| **Fee (10%)** | **Treasury** wallet | the protocol's cut / company profit |
| **Rewards (90%)** | **Rewards Pool** wallet | funds the USDC you pay viewers when they redeem dwells |

Each wallet yields two of the four env values:

| Env var | Value | Notes |
| --- | --- | --- |
| `TREASURY_SOL_ACCOUNT` | Treasury wallet's **public address** | the wallet itself |
| `REVENUE_SOL_ACCOUNT` | Rewards wallet's **public address** | the wallet itself |
| `TREASURY_USDC_ATA` | Treasury wallet's **USDC token account (ATA)** | **not** the wallet address |
| `REVENUE_USDC_ATA` | Rewards wallet's **USDC token account (ATA)** | **not** the wallet address |

> ⚠️ **The single biggest gotcha.** The SOL vars take the plain wallet address.
> The USDC vars take that wallet's **Associated Token Account** — a *different*
> address derived from `(wallet, USDC mint)`. Put a plain wallet address in a
> `*_USDC_ATA` slot and USDC payments will fail on-chain verification.

**Network: Solana mainnet-beta.** One chain, no bridging. The backend defaults
to the canonical mainnet USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
(6 decimals). You can rehearse the whole thing on devnet first with devnet USDC.

---

## 2. Get the addresses

### 2a. Make two wallets

- **Fast path (hot wallets):** in Phantom or Solflare, create two accounts,
  label them "DWELL Treasury" and "DWELL Rewards." Copy each public address —
  those are `TREASURY_SOL_ACCOUNT` and `REVENUE_SOL_ACCOUNT`.
- **Recommended for real money (Squads multisig):** create two Squads vaults
  (e.g. 2-of-3) so a single leaked key can't drain the treasury. The vault
  address plugs into the exact same env vars. Especially worth it for the
  Rewards wallet, which holds the float you owe viewers.

### 2b. Derive each USDC ATA

Easiest, no tooling — **send $1 of USDC to each wallet.** Phantom auto-creates
the ATA on first receipt. Then in Solana Explorer, open the wallet → *Tokens* →
click the USDC line → copy that account's address. That is the `*_USDC_ATA`.

Or with the Solana CLI:

```bash
spl-token address \
  --owner <TREASURY_WALLET_PUBKEY> \
  --token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --verbose
# repeat with the rewards wallet pubkey for REVENUE_USDC_ATA
```

---

## 3. Where to store them / what to do

The four addresses are **public — not secrets.** Set them as environment
variables on the Supabase edge function (`dwell-api`) and redeploy:

```bash
supabase secrets set \
  TREASURY_SOL_ACCOUNT=<pubkey> \
  REVENUE_SOL_ACCOUNT=<pubkey> \
  TREASURY_USDC_ATA=<ata> \
  REVENUE_USDC_ATA=<ata>
supabase functions deploy dwell-api
```

(Or paste them in the Supabase dashboard → Edge Functions → Secrets.)

**Checkout stays keyless** — the advertiser's wallet is the only signer on any
payment, and the treasury/revenue *addresses* are public, not secrets. The one
key the backend does hold is the **treasury signer** below; keep every other
private key / seed phrase in a hardware wallet, Squads, or a password manager.

### The treasury signer (hedging: swap-on-accept / refund-on-reject)

SOL/$DWELL payments are held during review, swapped to USDC when the ad is
accepted (the realized USDC at the acceptance-time rate funds the campaign),
and refunded in-kind if it's rejected. Both actions are signed server-side:

- **`TREASURY_SIGNER_SECRET`** — base58 64-byte ed25519 keypair (what
  `solana-keygen` exports). Used ONLY by the accept-swap and reject-refund
  paths; never by checkout. Treat it like `STRIPE_SECRET_KEY`.
- Its pubkey **must equal `TREASURY_SOL_ACCOUNT`** (boot refuses otherwise)
  and must own `TREASURY_USDC_ATA` and `TREASURY_DWELL_ATA`. Set
  `REVENUE_SOL_ACCOUNT` to the same key — swaps/refunds move the FULL
  received amount from the signer account.
- **`SWAP_SLIPPAGE_BPS`** (default 100) — execution slippage bound on the
  acceptance-time Jupiter swap.
- Without the signer, SOL/$DWELL rails still take payments, but accepting or
  rejecting those campaigns fails (loudly, retryably) until it is set — boot
  warns about this state.

### Also worth setting

- **`SOLANA_RPC_URL`** — the default is the public `api.mainnet-beta.solana.com`,
  which is rate-limited and makes payment detection flaky under load. Use a
  dedicated endpoint (Helius / Triton / QuickNode).
- **`STRIPE_SECRET_KEY`** — already set if card checkout works; it also powers
  the admin *Transactions* → *Card charges* table.

---

## 4. Boot-time safety rails

`server/src/boot.js` will refuse to start half-configured, so you can't leave
the rail in a broken partial state:

- `TREASURY_USDC_ATA` and `REVENUE_USDC_ATA` must be set **together** (or neither).
- `TREASURY_SOL_ACCOUNT` and `REVENUE_SOL_ACCOUNT` must be set **together**.
- `DWELL_MINT` (post-launch only) requires `TREASURY_DWELL_ATA`.
- `TREASURY_SIGNER_SECRET`'s pubkey must equal `TREASURY_SOL_ACCOUNT`; SOL or
  $DWELL rails configured without a signer boot with a loud warning (accepts
  and rejects on those rails will fail until it's set).

Until the USDC pair is set, the lander's crypto button says "not live here yet"
and falls back to card. The moment both are set and deployed, it goes live.

---

## 5. Verify it works

1. **Lander:** open the advertiser section — the payment slider shows
   *Pay with USDC/SOL* (active), *Pay with $DWELL* (disabled until token launch),
   *Credit card*.
2. **Real order:** fill the form, pick USDC, open the Solana Pay link in your
   wallet, and pay a small budget. The wallet signs one transaction; both legs
   land in your treasury + rewards ATAs.
3. **Admin → Transactions:** the order appears under *Crypto orders*, flipping
   `awaiting_signature → confirmed` with a Solscan link once the chain confirms.
   Card purchases show under *Card charges*, pulled live from Stripe.

---

## 6. Tracking purchases

- **Admin → Transactions** (added alongside this rail): crypto orders from the
  `usdc_orders` table (every rail and status, with on-chain signature links)
  plus recent Stripe card charges side by side.
- **Confirmed** crypto orders also create a funded campaign, so they roll up
  into *Ads*, *Advertisers*, and *Income* exactly like card-paid campaigns.
- The raw ledger of record is the `usdc_orders` table: `reference_pubkey`
  (Solana Pay detection handle), `tx_signature`, `status`, `fail_reason`, and
  the amounts per leg.
