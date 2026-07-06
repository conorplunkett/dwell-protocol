import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "./util.js";

export const DEFAULT_API_BASE =
  "https://wpjfhezklpczxzocgxsb.supabase.co/functions/v1/dwell-api";

export function dwellDir(home = homedir()) {
  return join(home, ".dwell");
}

export function claudeDwellDir(home = homedir()) {
  return join(dwellDir(home), "claude");
}

export function terminalConfigPath(home = homedir()) {
  return join(claudeDwellDir(home), "config.json");
}

export function devicePath(home = homedir()) {
  return join(dwellDir(home), "device.json");
}

export function sessionsDir(home = homedir()) {
  return join(claudeDwellDir(home), "sessions");
}

export function sessionDir(home, sessionId) {
  return join(sessionsDir(home), sessionId);
}

export function userDwellConfigPath(home = homedir()) {
  return join(dwellDir(home), "config.json");
}

export function resolveApiBase({ home = homedir(), env = process.env } = {}) {
  const cfg = readJson(userDwellConfigPath(home), {});
  const configured = typeof cfg?.backendBaseUrl === "string"
    ? cfg.backendBaseUrl.trim()
    : "";
  const fromEnv = typeof env.DWELL_BASE === "string" ? env.DWELL_BASE.trim() : "";
  return (configured || fromEnv || DEFAULT_API_BASE).replace(/\/+$/, "");
}
