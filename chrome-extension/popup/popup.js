// FreeAI.fyi — popup logic (Fuel Ring)
const $ = (id) => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// A free month of Claude Pro = $20 (the entry redemption — see giftcards.js). The
// fuel ring tracks credits earned toward that next free month, so progress stays
// meaningful at real balances. (The design mock framed the ring around a $200
// Claude Max month; we use the achievable Pro goal here — see the redesign notes.)
const MONTH_TARGET = 20;

// Ring geometry — must match the <svg> in popup.html (r=69, stroke=14).
const RING_R = 69;
const RING_C = 2 * Math.PI * RING_R;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const money = (n) => "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function setRing(pct) {
  const arc = $("ring-arc");
  if (!arc) return;
  const clamped = Math.max(0, Math.min(1, pct));
  arc.setAttribute("stroke-dasharray", RING_C.toFixed(1));
  arc.setAttribute("stroke-dashoffset", (RING_C * (1 - clamped)).toFixed(1));
}

async function refresh() {
  const s = (await send({ type: "BB_GET_STATE" })) || {};
  const earnings = s.earnings || 0;

  // Hero ring — credits earned, and progress toward the next free month.
  setText("earnings", money(earnings));
  setText("goal", "of $" + MONTH_TARGET);
  const pct = earnings / MONTH_TARGET;
  setRing(pct);
  const progress = $("progress");
  if (progress) {
    const whole = Math.min(100, Math.round(pct * 100));
    progress.innerHTML = whole >= 100
      ? "<b>Ready</b> — redeem a free month of Claude"
      : `<b>${whole}%</b> toward a free month of Claude`;
  }

  // Stats
  setText("impressions", (s.impressions || 0).toLocaleString());
  setText("clicks", (s.clicks || 0).toLocaleString());
  $("enabled").checked = s.enabled !== false;
  const days = Math.max(1, Math.round((Date.now() - (s.installedAt || Date.now())) / 86400000));
  setText("perday", money(earnings / days));

  // Live status line reflects the on/off switch.
  const status = $("status");
  if (status) {
    const on = s.enabled !== false;
    status.classList.toggle("off", !on);
    status.querySelector(".status-txt").innerHTML = on
      ? "Active on <b>chatgpt.com</b>, <b>claude.ai</b>"
      : "Paused — flip the switch to start earning";
  }

  // Test mode (developer tools)
  const on = !!s.testMode;
  if ($("testmode")) $("testmode").checked = on;
  if ($("test-pill")) $("test-pill").hidden = !on;
  if ($("test-hint")) $("test-hint").hidden = !on;
  if (on) {
    setText("test-counts", `${s.testImpressions || 0} mock impressions · ${s.testClicks || 0} mock clicks (not billed).`);
  }
}

// CREW — friends you referred and the credits they've earned you. Populated only
// when the extension is linked to a signed-in account (a web session). Today the
// popup is anonymous/device-scoped, so this resolves to the signed-out invite
// state; the rendering is data-driven so it lights up once auth lands.
function planClass(status) {
  return status === "rewarded" ? "plan max" : "plan";
}
function friendRow(f) {
  const cut = f.youUsd ? `<div class="cut"><div class="v">+${esc(money(f.youUsd))}</div><div class="k">${esc(f.cutLabel || "to you")}</div></div>` : "";
  return (
    `<div class="friend">` +
    `<div class="meta">` +
    `<div class="nm">${esc(f.name)} <span class="${planClass(f.status)}">${esc(f.statusLabel || f.status || "")}</span></div>` +
    `<div class="sub">${esc(f.sub || "")}</div>` +
    `</div>${cut}</div>`
  );
}

async function refreshCrew() {
  const crew = (await send({ type: "BB_GET_CREW" })) || {};
  const list = $("crew-list");
  const empty = $("crew-empty");
  const sum = $("crew-sum");
  const friends = Array.isArray(crew.friends) ? crew.friends : [];

  if (friends.length) {
    setText("crew-label", `Your crew · ${friends.length} ${friends.length === 1 ? "friend" : "friends"}`);
    if (list) list.innerHTML = friends.map(friendRow).join("");
    if (empty) empty.hidden = true;
  } else {
    setText("crew-label", "Your crew");
    if (list) list.innerHTML = "";
    if (empty) empty.hidden = false;
  }

  if (sum) {
    if (crew.fromFriendsUsd > 0) {
      sum.textContent = `+${money(crew.fromFriendsUsd)} to you`;
      sum.hidden = false;
    } else {
      sum.hidden = true;
    }
  }
}

// Top-5 of the live bid market.
function boardHtml(ads) {
  return ads
    .slice(0, 5)
    .map(
      (a, i) =>
        `<li><span class="rk">${i + 1}</span>` +
        `<span class="chip" style="background:${esc(a.color)};color:${esc(a.ink)}">${esc(a.chip)}</span>` +
        `<span class="ln"><b>${esc(a.brand)}</b> — ${esc(a.line)}</span></li>`
    )
    .join("");
}
function renderBoard() {
  $("board").innerHTML = boardHtml(self.BB_ADS || []);
}
// Pull live inventory from the background (auction-backed) so the board mirrors
// what the injected bar would actually show; fall back to the bundled list.
async function refreshBoard() {
  const ads = await send({ type: "BB_GET_ADS" });
  if (Array.isArray(ads) && ads.length) $("board").innerHTML = boardHtml(ads);
}

$("enabled").addEventListener("change", async (e) => {
  await send({ type: "BB_SET", payload: { enabled: e.target.checked } });
  refresh();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "BB_REFRESH" }, () => void chrome.runtime.lastError);
});

if ($("testmode")) {
  $("testmode").addEventListener("change", async (e) => {
    await send({ type: "BB_SET", payload: { testMode: e.target.checked } });
    await refresh();
    // push the change to the active tab so the mock ad appears/disappears now
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "BB_REFRESH" }, () => {
        if (chrome.runtime.lastError) {
          $("test-hint").hidden = false;
          setText("test-counts", "Open chatgpt.com / claude.ai / gemini.google.com, then reload the tab to see the mock ad.");
        }
      });
    }
  });
}

if ($("demo")) {
  $("demo").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "BB_DEMO", ms: 30000 }, () => {
      if (chrome.runtime.lastError) {
        setText("hint", "Open a supported AI site (claude.ai, chatgpt.com…) and try the demo there.");
      } else {
        setText("hint", "Demo running on the active tab — watch the sponsored line for 30s.");
      }
    });
  });
}

if ($("reset")) {
  $("reset").addEventListener("click", async () => {
    await send({ type: "BB_RESET" });
    refresh();
  });
}

renderBoard();   // instant paint from the bundled list
refreshBoard();  // then swap in live inventory if available
refresh();
refreshCrew();
setInterval(refresh, 1000);
