# Launch thread — the direct shot, loaded

The sequence from the launch-copy work, with every bracket filled from the
code instead of guessed. Sources for each number are cited inline so the
copy can be re-verified before posting if a default changes. Companion to
[`LAUNCH.md`](LAUNCH.md) (go/no-go checklist); this file is the copy.

## The numbers (from the code, not vibes)

| Claim | Value | Source |
| --- | --- | --- |
| User revenue share | **50%** | `REVENUE_SHARE=0.5` default, `server/src/boot.js` |
| What's paid | **Impressions only** — 1 impression per 5 s served; clicks tracked, not paid | root `README.md`, `20260625_remove_click_50x.sql` |
| Rate at default fill | $12 gross CPM → user earns 0.6¢ / 5 s ≈ **7¢ per minute** of agent runtime (~$4.30/hr while serving) | `GROSS_CPM_CENTS=1200` |
| Daily earn ceiling | 5,000 impressions/device/day (= $30/day user-side max) | `DAILY_IMPRESSION_CAP=5000` |
| Friends | **+10% of everything a friend earns, on top, platform-funded** — the friend keeps their full 50%. Up to 10 friends; dollar earnings uncapped | `AFFILIATE_REWARD_BPS=1000`, `AFFILIATE_CAP_PEOPLE=10`, `repo.js creditAffiliate` |
| Redemption | **Claude gift-card redemption is open at launch** via the portal; manual fulfillment within 48 h. Cash payouts (Stripe Connect) exist in code but are parked — do **not** say "cash out" | `web/redeem.html`, `LAUNCH.md` |
| Install (CLI) | `npx @freeai.fyi/terminal claude setup` — reversible; `freeai claude restore` undoes it; never edits `~/.claude/settings.json` | `terminal/README.md` |
| Surfaces shippable today | Chrome extension (ChatGPT / Claude / Gemini) + Claude Code CLI. The macOS desktop app is a working skeleton — **cut "desktop" from launch copy unless it ships first** | `LAUNCH.md` known issues |
| Advertiser floor | from **$0.50** per block of 1,000 impressions | `app.js /v1/checkout`, min bid check |

## The strategic read on the number

The split is 50%. That **ties** the incumbent's 50% — it does not beat it. So
the "better" in the hook cannot hang on the split. It hangs on four things the
code actually delivers:

1. **Paid on time, not clicks.** Every 5 seconds the agent runs earns; nobody
   has to click an ad.
2. **Every surface, not one terminal.** Browser (three assistants) + CLI.
3. **Redemption is open on day one.** Not "coming soon."
4. **The friend override.** +10% on top means a networked user's effective
   take is above 50% — that's the only way this number *beats* rather than
   ties, so the friends line earns its place in the hook.

If someone replies "kickbacks pays 50%, what do you pay?" the answer is "same
50% — paid for time instead of clicks, on every surface, redeemable today,
plus 10% of what your friends earn." That survives contact.

## Tweet 1 — the shot

> We did discombobulating, but better.
>
> Every surface your agent lives on, not one terminal. Chrome, CLI.
>
> You earn the whole time it thinks — no clicking — and redemption is open
> today. Bring friends, earn 10% of everything they make.
>
> Available now: freeai.fyi

Changes from the last draft, and why:
- "cash out for real" → "redemption is open today." Payouts are gift-card
  redemption, not cash, and cash payouts are parked. "Cash out" is a loaded
  gun pointed backwards: the first reply becomes "cash out where? it's gift
  cards." "Redemption is open today" keeps the quiet shot at the
  payouts-not-open complaint and is 100% defensible.
- "Chrome, desktop, CLI" → "Chrome, CLI." The macOS app is a skeleton. Claiming
  a surface that isn't installable is the traction-faking failure mode in
  miniature. Add "desktop" back the day it ships — that's a free follow-up
  tweet, not a launch-day liability.
- "earn 10% of everything they make" replaces the vague "earn more" — the
  friends line now carries a number, which is what makes the hook credible.

## Reply 1 — the proof (the most important tweet in the launch)

> what "better" means, specifically:
>
> — you keep 50%, paid per 5 seconds your agent is running. no clicking required
> — redeem for Claude credit today. open now, not "coming soon"
> — nothing patches your editor: a reversible shell alias + Claude Code's
>   official statusLine hook. `freeai claude restore` and it's gone
> — ChatGPT, Claude, and Gemini in the browser + Claude Code in the terminal
> — friends: 10% of everything they earn, on top. they still keep their full 50%
>
> freeai.fyi

The "nothing patches your editor" line is the quiet shot at the CSP-weakening
complaint — the crowd that knows fills in the target. The terminal client
genuinely launches Claude with a temporary `--settings` file and never touches
`~/.claude/settings.json`, so the claim holds under scrutiny.

Optional spice, use only if asked "how much is that actually": "at current
rates ~7¢ a minute of runtime, capped at $30/day." The cap reads as honesty,
not weakness — inflated-sounding earn rates are what this audience distrusts.

## Reply 2 — the friction-killer

> install in one line, works while you're already waiting:
>
> `npx @freeai.fyi/terminal claude setup`
>
> reversible — `freeai claude restore` puts everything back.
> browser: grab the extension at freeai.fyi

## First 30–60 minutes

Sit in the thread. Answer every "but kickbacks does X" with the matching
differentiator from Reply 1. Each exchange outweighs the launch tweet for
reach. Do not post and walk away.

## Post 2 — traction (same day evening / next morning, separate tweet)

> [N] installs in the first [12/24] hours.
> here's the payout counter, live: [screenshot of the portal earnings page]

Real numbers only. If traction is soft, skip this post entirely. The portal
(`freeai.fyi/redeem`) shows live balance/earned/today — screenshot that, it's
the receipt.

## Post 3 — the advertiser flip (day 2–3)

> devs are already earning on freeai while their agents think.
> which means their attention is sitting in one place, unspent.
> advertisers: that's your audience, in the one moment they're not coding.
> bid from $0.50 per 1,000 impressions. freeai.fyi/advertisers

$0.50 is the real checkout floor (min bid per 1,000-impression block), and a
fifty-cent entry point is itself a hook for indie advertisers.

## Standing rule

One shot at the incumbent, in Tweet 1, then stop swinging. Everything after is
receipts.
