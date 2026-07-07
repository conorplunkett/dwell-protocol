// Mailer verification — every outbound email, driven through the REAL Resend
// transport with a captured fetch. Boots createMailer({ mailProvider: "resend" })
// so the production send path (POST https://api.resend.com/emails) is exercised
// for each of the 11 email types, then asserts the request Resend would receive
// is well-formed: right sender + reply-to per audience, a subject, non-empty
// HTML with valid links, and that advertiser-supplied fields are escaped.
//
// No database or network needed — the whole thing runs offline. Renders each
// email to test/email-previews/*.html so the actual markup can be eyeballed.
//
// Usage: node test/mailer.test.js

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createMailer } = require("../src/mailer");

const TO = process.env.TEST_EMAIL || "conor.p43@gmail.com";
const API_KEY = "re_test_key_1234567890";
const RESEND_URL = "https://api.resend.com/emails";

// Senders the mailer is configured with (mirrors mailer.js defaults). Outbound
// mail runs through the legacy Resend-verified contact.freeai.fyi domain that
// DWELL inherited from freeai.fyi, so every From/reply-to is on freeai.fyi.
const USER_FROM = "DWELL <hello@contact.freeai.fyi>";
const ADS_FROM = "DWELL <ads@contact.freeai.fyi>";
const SUPPORT_REPLY = "support@contact.freeai.fyi";
const ADS_REPLY = "ads@contact.freeai.fyi";

// Captured Resend requests. Each send() should push exactly one.
const sent = [];
const captureFetch = async (url, opts) => {
  sent.push({ url, opts });
  return { ok: true, status: 200, json: async () => ({ id: "resend_test_id" }) };
};

const mailer = createMailer({
  mailProvider: "resend",
  resendApiKey: API_KEY,
  fetchImpl: captureFetch,
  siteUrl: "https://dwellprotocol.com",
});

const previewDir = path.join(__dirname, "email-previews");
fs.rmSync(previewDir, { recursive: true, force: true });
fs.mkdirSync(previewDir, { recursive: true });

// Pull the single Resend request the last send produced and do the checks every
// email must pass, then hand the parsed payload back for per-email assertions.
function lastPayload() {
  assert.strictEqual(sent.length, 1, `expected exactly one Resend request, got ${sent.length}`);
  const { url, opts } = sent.pop();
  assert.strictEqual(url, RESEND_URL, "must POST to the Resend emails endpoint");
  assert.strictEqual(opts.method, "POST");
  assert.strictEqual(opts.headers.Authorization, `Bearer ${API_KEY}`, "must send the API key as a Bearer token");
  assert.strictEqual(opts.headers["Content-Type"], "application/json");
  const p = JSON.parse(opts.body);
  assert.strictEqual(p.to, TO, "recipient must be the address under test");
  assert.ok(typeof p.subject === "string" && p.subject.length > 0, "subject must be present");
  assert.ok(typeof p.html === "string" && p.html.length > 200, "html body must be substantial");
  // Every anchor must have a real, non-empty href — a broken CTA is a dead email.
  for (const m of p.html.matchAll(/href="([^"]*)"/g)) {
    assert.ok(m[1] && m[1] !== "undefined" && m[1] !== "null", `empty/invalid href in ${p.subject}`);
  }
  return p;
}

// Renders the email offline (console transport, no fetch) so we can save the
// exact HTML for visual inspection alongside the transport assertions.
const htmlByName = {};

const cases = [
  {
    name: "01-verify-email",
    desc: "Verify your email (user · sign-up)",
    run: () => mailer.sendVerifyEmail(TO, "https://dwellprotocol.com/verify?token=verify_tok_abc"),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.strictEqual(p.reply_to, SUPPORT_REPLY);
      assert.match(p.subject, /verify/i);
      assert.ok(p.html.includes("https://dwellprotocol.com/verify?token=verify_tok_abc"), "must embed the verify link");
    },
  },
  {
    name: "02-web-login",
    desc: "Magic-link sign-in (user)",
    run: () => mailer.sendWebLoginEmail(TO, "https://dwellprotocol.com/login?token=login_tok_xyz"),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.strictEqual(p.reply_to, SUPPORT_REPLY);
      assert.match(p.subject, /sign-in/i);
      assert.ok(p.html.includes("login?token=login_tok_xyz"), "must embed the login link");
    },
  },
  {
    name: "03-advertiser-receipt",
    desc: "Campaign payment receipt (advertiser)",
    run: () => mailer.sendAdvertiserReceiptEmail(TO, {
      campaignId: "camp_1a2b3c", brand: "Linear", adLine: "Linear — issue tracking built for speed",
      pricePerBlockCents: 4900, blocks: 5,
    }),
    check(p) {
      assert.strictEqual(p.from, ADS_FROM, "advertiser mail must come from the ads sender");
      assert.strictEqual(p.reply_to, ADS_REPLY, "advertiser mail replies to ads@");
      assert.match(p.subject, /receipt/i);
      assert.ok(p.html.includes("camp_1a2b3c"), "must show the campaign id");
      assert.ok(p.html.includes("US$245.00"), "total = 4900c * 5 / 100 = $245.00");
    },
  },
  {
    name: "04-campaign-rejected",
    desc: "Campaign rejected + refunded (advertiser)",
    run: () => mailer.sendCampaignRejectedEmail(TO, {
      campaignId: "camp_9z8y7x", brand: "Acme", adLine: "Acme — buy now",
      pricePerBlockCents: 4900, blocks: 3, note: "Ad copy needs a clearer disclosure.",
    }),
    check(p) {
      assert.strictEqual(p.from, ADS_FROM);
      assert.strictEqual(p.reply_to, ADS_REPLY);
      assert.match(p.subject, /refund/i);
      assert.ok(p.html.includes("US$147.00"), "refund = 4900c * 3 / 100 = $147.00");
      assert.ok(p.html.includes("Ad copy needs a clearer disclosure."), "must include the reviewer note");
    },
  },
  {
    name: "05-campaign-completed",
    desc: "Campaign wrapped up — final numbers (advertiser)",
    run: () => mailer.sendCampaignCompletedEmail(TO, {
      campaignId: "camp_done01", brand: "Fluidstack",
      adLine: 'Fluidstack <script>alert(1)</script>', // hostile input — must be escaped
      impressionsShown: 12000, clicks: 84, ctr: 0.007, cpcUsd: 1.75, ecpmUsd: 12.25, totalPaidUsd: 147,
    }),
    check(p) {
      assert.strictEqual(p.from, ADS_FROM);
      assert.strictEqual(p.reply_to, ADS_REPLY);
      assert.ok(p.html.includes("12,000"), "impressions must be locale-formatted");
      assert.ok(!p.html.includes("<script>alert(1)</script>"), "advertiser ad line must be HTML-escaped");
      assert.ok(p.html.includes("&lt;script&gt;"), "escaped ad line should appear");
    },
  },
  {
    name: "06-gift-redemption",
    desc: "Gift-card redemption order (fulfillment inbox)",
    run: () => mailer.sendGiftRedemptionEmail(TO, {
      redemptionId: "redm_abc123", planName: "Claude Pro", months: 3, amountUsd: 60, recipientEmail: TO,
    }),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.strictEqual(p.reply_to, SUPPORT_REPLY);
      assert.match(p.subject, /redemption/i);
      assert.ok(p.html.includes("redm_abc123") && p.html.includes("Claude Pro"), "must include order details");
    },
  },
  {
    name: "07-referral-invite",
    desc: "Refer a friend (user → invitee)",
    run: () => mailer.sendReferralInviteEmail(TO, {
      inviterEmail: "friend@example.com", link: "https://dwellprotocol.com/?ref=CODE123", rewardUsd: 20,
    }),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.ok(p.html.includes("friend@example.com"), "must name the inviter");
      assert.ok(p.html.includes("?ref=CODE123"), "must carry the referral code link");
    },
  },
  {
    name: "08-crew-invite",
    desc: "Crew invite from the extension (user → invitee)",
    run: () => mailer.sendCrewInviteEmail(TO, {
      inviterEmail: "buddy@example.com", link: "https://dwellprotocol.com/?crew=CREW99", rewardPct: 10,
    }),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.ok(p.html.includes("buddy@example.com"), "must name the inviter");
      assert.ok(p.html.includes("?crew=CREW99"), "must carry the crew link");
    },
  },
  {
    name: "09-redemption-confirmation",
    desc: "Redemption confirmation (user)",
    run: () => mailer.sendRedemptionConfirmationEmail(TO, { planName: "Claude Max", months: 1, amountUsd: 100 }),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.match(p.subject, /gift card is on the way/i);
      assert.ok(p.html.includes("Claude Max"), "must name the plan");
    },
  },
  {
    name: "10-referral-reward",
    desc: "Referral bonus unlocked (user)",
    run: () => mailer.sendReferralRewardEmail(TO, { rewardUsd: 20, link: "https://dwellprotocol.com/dashboard" }),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.ok(p.subject.includes("$20"), "subject should carry the reward amount");
      assert.ok(p.html.includes("dashboard"), "must link to the dashboard");
    },
  },
  {
    name: "11-waitlist-confirmation",
    desc: "Waitlist confirmation (pre-account)",
    run: () => mailer.sendWaitlistConfirmationEmail(TO),
    check(p) {
      assert.strictEqual(p.from, USER_FROM);
      assert.match(p.subject, /waitlist/i);
    },
  },
];

async function main() {
  console.log(`mailer verification — Resend transport, ${cases.length} email types → ${TO}\n`);
  let pass = 0;
  for (const c of cases) {
    await c.run();
    const p = lastPayload();
    c.check(p);
    fs.writeFileSync(path.join(previewDir, `${c.name}.html`), p.html);
    htmlByName[c.name] = { subject: p.subject, from: p.from };
    console.log(`  ✓ ${c.name.padEnd(28)} ${c.desc}`);
    console.log(`      from ${p.from}  ·  “${p.subject}”`);
    pass++;
  }

  // Transport-contract guards, exercised once so a Resend outage/misconfig can't
  // pass silently: a non-2xx response must throw, and a missing key must NOT hit
  // the network (it falls back to the console transport instead).
  const failMailer = createMailer({
    mailProvider: "resend", resendApiKey: API_KEY,
    fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({}) }),
  });
  await assert.rejects(() => failMailer.sendWaitlistConfirmationEmail(TO), /resend send failed: 422/,
    "a failed Resend call must throw");
  console.log(`  ✓ ${"resend-failure-throws".padEnd(28)} non-2xx Resend response propagates as an error`);
  pass++;

  let hitNetwork = false;
  const noKeyMailer = createMailer({
    mailProvider: "resend", resendApiKey: "", // no key configured
    fetchImpl: async () => { hitNetwork = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  await noKeyMailer.sendWaitlistConfirmationEmail(TO);
  assert.strictEqual(hitNetwork, false, "with no API key the mailer must not call Resend");
  console.log(`  ✓ ${"no-key-no-network".padEnd(28)} missing key falls back to console, never calls Resend`);
  pass++;

  assert.strictEqual(sent.length, 0, "all captured Resend requests must be consumed by assertions");

  console.log(`\n${pass} checks passed. Rendered previews → ${path.relative(process.cwd(), previewDir)}/`);
}

main().catch((e) => { console.error("\n✗ mailer verification FAILED\n", e); process.exit(1); });
