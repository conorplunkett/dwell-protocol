// Payout sweep: every user with payouts enabled and a ledger balance at or
// above the threshold gets a Stripe Connect transfer. The protocol keeps
// payoutFeeBps of the gross — the user's balance is debited in full and the
// net is transferred. Admin-only: run via POST /v1/admin/payouts or
// `npm run payouts`. The portal's on-demand path (/v1/web/payouts/request)
// is the user-facing route; this sweep would drain balances people may be
// holding for the $DWELL claim, so never cron it without a deliberate call.

const crypto = require("node:crypto");

async function runPayouts({ repo, stripe, config }) {
  const users = await repo.payableUsers(config.payoutThresholdCents * 1000);
  const results = [];
  for (const user of users) {
    const grossCents = Math.floor(user.balance / 1000); // pay whole cents only
    if (grossCents < config.payoutThresholdCents) continue;
    const feeCents = Math.ceil((grossCents * config.payoutFeeBps) / 10000);
    const netCents = grossCents - feeCents;
    if (netCents <= 0) continue;
    try {
      const transfer = await stripe.createTransfer({
        amount: netCents,
        currency: "usd",
        destination: user.stripe_account_id,
        transfer_group: `payout_${user.id}_${crypto.randomUUID()}`,
      });
      await repo.recordPayout(user.id, grossCents, netCents, feeCents, transfer.id);
      results.push({ userId: user.id, grossCents, netCents, feeCents, transferId: transfer.id, ok: true });
    } catch (err) {
      results.push({ userId: user.id, grossCents, netCents, feeCents, ok: false, error: err.message });
    }
  }
  return { paid: results.filter((r) => r.ok).length, results };
}

module.exports = { runPayouts };
