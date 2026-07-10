import { spawn, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defaultBackend, ensureDevice, readDevice } from "./backend.js";
import { locateRealClaude, readTerminalConfig, writeTerminalConfig } from "./claude.js";
import { startSessionMonitor } from "./monitor.js";
import { sessionDir } from "./paths.js";
import { buildDwellStatusLine, effectiveStatusLine, extractSettingsArg,
  readSettingsValue, writeSessionSettings } from "./settings.js";
import { initialState, updateState, writeState } from "./state.js";
import { composeAdText, delay, removePath, safeHttpUrl, randomId, HOUSE_AD } from "./util.js";

// Opt-in stderr tracing. The ad path is intentionally silent in normal use, so
// when "doctor" is green but no ad shows, `DWELL_DEBUG=1 claude` reveals which
// step bailed (and whether the wrapper ran at all).
function debugEnabled(env) {
  return env?.DWELL_DEBUG === "1" || env?.DWELL_DEBUG === "true";
}
function debug(env, msg) {
  if (debugEnabled(env)) console.error(`dwell[debug]: ${msg}`);
}

export async function runClaude(argv, {
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  realClaudePath,
  cliPath = fileURLToPath(new URL("../bin/dwell.js", import.meta.url)),
  backend = defaultBackend({ home, env }),
  keepSession = false,
  monitorOptions = {},
} = {}) {
  const config = readTerminalConfig(home);
  const realClaude = locateRealClaude({
    explicit: realClaudePath,
    env,
    home,
    storedPath: config.realClaudePath,
  });
  if (!realClaude) {
    console.error("dwell: could not find the real claude executable; run `dwell claude setup`");
    return 127;
  }

  debug(env, `wrapper active; real claude: ${realClaude}`);
  // One throttled nudge (≤ once/day) if this machine's credits aren't reaching
  // an account yet, so a user who skipped/abandoned linking isn't silently
  // unattributed. Best-effort and printed before Claude takes over the screen.
  await maybeNudgeUnlinked({ home, env, backend }).catch((err) => debug(env, `nudge skipped: ${err?.message || err}`));
  const prepared = await prepareDwellSession({
    argv, cwd, env, home, realClaude, cliPath, backend, monitorOptions,
  }).catch((err) => {
    debug(env, `ad setup threw, running claude unchanged: ${err?.message || err}`);
    return null;
  });

  if (!prepared) {
    debug(env, "no ad session prepared; running claude unchanged");
    return spawnAndWait(realClaude, argv, { cwd, env });
  }

  const { finalArgv, cleanup, monitor, refreshTimer } = prepared;
  debug(env, `ad session ready via ${finalArgv[1]}`);
  try {
    return await spawnAndWait(realClaude, finalArgv, { cwd, env });
  } finally {
    monitor?.stop();
    if (refreshTimer) clearInterval(refreshTimer);
    if (!keepSession) cleanup();
  }
}

const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Print at most one stderr line per day when this machine has a device (so it
// can earn) but isn't linked to an account (so the credits go nowhere claimable).
// Local-throttled; the single network probe runs at most once/day and stays
// silent on unknown/timeout so a linked user is never wrongly nudged.
async function maybeNudgeUnlinked({ home, env, backend }) {
  if (env.DWELL_NO_NUDGE === "1" || env.DWELL_NO_NUDGE === "true") return;
  const cfg = readTerminalConfig(home);
  if (cfg.linkedAt) return;                                   // already confirmed linked
  if (Date.now() - (Date.parse(cfg.lastLinkNudgeAt || "") || 0) < NUDGE_INTERVAL_MS) return;
  const device = readDevice(home);
  if (!device) return;                                        // nothing to attribute yet
  const status = await Promise.race([
    backend.linkStatus(device).catch(() => null),
    delay(3000).then(() => null),                             // don't delay startup
  ]);
  if (!status) return;                                        // unknown — stay silent, retry next run
  if (status.linked) {
    writeTerminalConfig(home, { ...readTerminalConfig(home), linkedAt: new Date().toISOString() });
    return;
  }
  writeTerminalConfig(home, { ...readTerminalConfig(home), lastLinkNudgeAt: new Date().toISOString() });
  console.error("dwell: this machine's Claude Code credits aren't linked to an account yet — run `dwell claude link` to claim them (silence with DWELL_NO_NUDGE=1).");
}

async function prepareDwellSession({
  argv, cwd, env, home, realClaude, cliPath, backend, monitorOptions,
}) {
  if (env.DWELL_DISABLE === "1" || env.DWELL_DISABLE === "true") {
    debug(env, "DWELL_DISABLE set; skipping ads for this run");
    return null;
  }
  const config = await backend.config();
  if (config.serving === false) {
    debug(env, "backend reports serving=false; no ad this run");
    return null;
  }
  const ads = await backend.ads();
  let ad = ads[0];
  // No funded inventory ⇒ fall back to the non-billable house ad, unless the
  // admin turned it off (/v1/config → houseAdEnabled). It promotes DWELL itself;
  // critically, we start NO monitor for it (below), so it never serves or
  // redeems an impression and the user earns nothing from it.
  const house = !ad && config.houseAdEnabled !== false;
  if (!ad && !house) {
    debug(env, "backend returned no active ads; house ad disabled by admin");
    return null;
  }
  if (house) ad = HOUSE_AD;

  let device = null;
  let trackingUrl = "";
  if (house) {
    // House ad has no campaign, so there is no click-intent to mint. Link
    // straight to the advertise page (first-party — records/bills nothing) and
    // skip the device entirely so nothing about this run is attributable.
    trackingUrl = safeHttpUrl(ad.url) ? ad.url : "";
    debug(env, "backend returned no active ads; serving the house ad (no billing)");
  } else {
    device = await ensureDevice(home, backend);
    trackingUrl = await backend.createClickIntent(device, ad.id);
    if (!safeHttpUrl(trackingUrl)) {
      debug(env, `click-intent returned no usable tracking URL (${trackingUrl})`);
      return null;
    }
    debug(env, `serving ad "${ad.line}" (${ad.id})`);
  }

  const { cleanArgv, settingsValue } = extractSettingsArg(argv);
  let userSettings = {};
  if (settingsValue) userSettings = readSettingsValue(settingsValue, cwd);

  const previousStatusLine = effectiveStatusLine({ home, userSettings });
  const sessionId = randomId("cc");
  const dir = sessionDir(home, sessionId);
  const statePath = join(dir, "state.json");
  const settingsPath = join(dir, "settings.json");
  const prevPath = previousStatusLine ? join(dir, "prev-statusline.json") : "";
  const state = initialState({ sessionId, ad, trackingUrl });
  writeState(statePath, state);
  if (previousStatusLine) {
    writeFileSync(prevPath, JSON.stringify({ statusLine: previousStatusLine }, null, 2) + "\n", "utf8");
  }

  const statusLine = buildDwellStatusLine({
    cliPath, statePath, prevPath: prevPath || undefined,
  });
  const spinnerVerbs = await supportedSpinnerVerbs(realClaude)
    ? { mode: "replace", verbs: [composeAdText(ad.brand, ad.line)] }
    : undefined;
  writeSessionSettings({ path: settingsPath, userSettings, statusLine, spinnerVerbs });

  // The house ad is filler: NO monitor and NO click-intent refresh. Without the
  // monitor there is no serve/redeem cycle, so it can never bill an impression —
  // this is the guarantee that the user earns nothing while it's on screen.
  const monitor = house ? null : startSessionMonitor({
    statePath, home, backend, device, ad, ...monitorOptions,
  });
  const refreshTimer = house ? null : setInterval(() => {
    void backend.createClickIntent(device, ad.id).then((nextUrl) => {
      if (!safeHttpUrl(nextUrl)) return;
      updateState(statePath, (next) => {
        next.trackingUrl = nextUrl;
        return next;
      });
    }).catch(() => {});
  }, 60_000);
  if (refreshTimer) { try { refreshTimer.unref?.(); } catch { /* ignore */ } }

  return {
    finalArgv: ["--settings", settingsPath, ...cleanArgv],
    monitor,
    refreshTimer,
    cleanup: () => removePath(dir),
  };
}

export function spawnAndWait(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    // Forward signals persistently (process.on, not once): Claude Code uses a
    // double-Ctrl-C to exit and ignores the first SIGINT, so the second delivery
    // must still reach the child. Listeners are removed on exit.
    const forward = (signal) => {
      try { child.kill(signal); } catch { /* ignore */ }
    };
    const handlers = {
      SIGINT: () => forward("SIGINT"),
      SIGTERM: () => forward("SIGTERM"),
      SIGHUP: () => forward("SIGHUP"),
      SIGQUIT: () => forward("SIGQUIT"),
    };
    for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);
    const clearHandlers = () => {
      for (const [sig, fn] of Object.entries(handlers)) process.removeListener(sig, fn);
    };
    child.on("error", (err) => {
      clearHandlers();
      console.error(`dwell: failed to run claude: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      clearHandlers();
      if (signal) resolve(128 + signalNumber(signal));
      else resolve(code ?? 0);
    });
  });
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 }[signal] || 1;
}

// Custom spinner verbs (the line that replaces Claude's "Thinking…") exist since
// Claude Code 2.1.23 and the settings schema is unchanged. We only suppress them
// on a positively-detected older build — if `claude --version` is slow or
// unparseable we assume a modern Claude and still write them, since a failed
// probe used to silently drop the ad from the spinner line entirely.
async function supportedSpinnerVerbs(realClaude) {
  const version = await detectClaudeVersion(realClaude);
  if (!version) return true;
  return gte(version, [2, 1, 23]);
}

function detectClaudeVersion(realClaude) {
  return new Promise((resolve) => {
    try {
      execFile(realClaude, ["--version"], { timeout: 1500, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout || ""));
        resolve(match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
