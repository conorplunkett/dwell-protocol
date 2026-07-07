import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import { ensureDir, isPlainObject, shQuote } from "./util.js";

export function extractSettingsArg(argv) {
  const cleanArgv = [];
  let settingsValue = null;
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      cleanArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      cleanArgv.push(arg);
      continue;
    }
    if (arg === "--settings") {
      settingsValue = argv[i + 1] ?? "";
      i++;
      continue;
    }
    if (arg.startsWith("--settings=")) {
      settingsValue = arg.slice("--settings=".length);
      continue;
    }
    cleanArgv.push(arg);
  }
  return { cleanArgv, settingsValue };
}

export function readSettingsValue(value, cwd = process.cwd()) {
  if (!value) return {};
  const trimmed = String(value).trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return parseJsonc(trimmed);
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  return parseJsonc(readFileSync(path, "utf8"));
}

export function readSettingsFile(path) {
  try {
    if (!path || !existsSync(path)) return {};
    return parseJsonc(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// The only settings file whose statusLine FreeAI is allowed to CHAIN (re-execute).
// Project-scoped files — cwd/.claude/settings.json and settings.local.json — are
// deliberately excluded: Claude Code gates project-provided statusLine (and hook)
// execution behind its folder-trust prompt, but FreeAI runs the chained command
// itself via `shell:true`, ~once per second. Honoring a project file here would
// execute a command straight out of a cloned repo's .claude/settings.json even
// when the user declined to trust that folder — a trust-gate bypass / RCE. Only
// the user's own ~/.claude/settings.json (and an explicit --settings passed on
// this invocation) are trusted sources.
export function chainableSettingsPath({ home = homedir() } = {}) {
  return join(home, ".claude", "settings.json");
}

export function effectiveStatusLine({ home = homedir(), userSettings = null } = {}) {
  let statusLine;
  const settings = readSettingsFile(chainableSettingsPath({ home }));
  if (settings && Object.prototype.hasOwnProperty.call(settings, "statusLine")) {
    statusLine = settings.statusLine;
  }
  if (userSettings && Object.prototype.hasOwnProperty.call(userSettings, "statusLine")) {
    statusLine = userSettings.statusLine;
  }
  return isForeignStatusLine(statusLine) ? statusLine : undefined;
}

export function isForeignStatusLine(value) {
  return isPlainObject(value)
    && value.type === "command"
    && typeof value.command === "string"
    && !value.command.includes("freeai-statusline")
    && !value.command.includes("freeai claude statusline");
}

export function statusLineCommand({ nodePath = process.execPath, cliPath, statePath, prevPath }) {
  const parts = [
    shQuote(nodePath),
    shQuote(cliPath),
    "claude",
    "statusline",
    "--state",
    shQuote(statePath),
  ];
  if (prevPath) parts.push("--prev", shQuote(prevPath));
  return parts.join(" ");
}

export function buildFreeAiStatusLine(params) {
  const statusLine = {
    type: "command",
    command: statusLineCommand(params),
    padding: 0,
  };
  // Re-run the status line command on a timer in addition to Claude Code's
  // event-driven updates. Without this, the ad line is not re-rendered during a
  // long "thinking" phase that emits no transcript events, so it never appears.
  // 1s (Claude's minimum) also keeps the shimmer sweep moving smoothly.
  const refreshInterval = params.refreshInterval ?? 1;
  if (refreshInterval) statusLine.refreshInterval = refreshInterval;
  return statusLine;
}

export function writeSessionSettings({ path, userSettings = {}, statusLine, spinnerVerbs }) {
  const out = isPlainObject(userSettings) ? { ...userSettings } : {};
  out.statusLine = statusLine;
  if (spinnerVerbs) out.spinnerVerbs = spinnerVerbs;
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}
