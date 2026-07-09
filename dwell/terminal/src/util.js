import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function stripControlChars(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Atomic write via temp file + rename. `mode` sets permission bits on the temp
// file BEFORE the rename (rename preserves the temp file's mode), so a caller
// holding a secret can land it at 0600 with no window at the default 0644.
export function writeFileAtomic(path, content, { mode } = {}) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, mode != null ? { encoding: "utf8", mode } : "utf8");
  renameSync(tmp, path);
}

export function writeJsonAtomic(path, value, opts) {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", opts);
}

export function removePath(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function randomId(prefix = "") {
  return prefix ? `${prefix}-${randomUUID()}` : randomUUID();
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// "Brand — slogan" like the Chrome extension, but only when the brand is not
// already how the line starts (live inventory sometimes bakes the brand into
// the line). Control chars are stripped so the text is safe to style.
export function composeAdText(brand, line) {
  const cleanLine = stripControlChars(line).trim();
  const cleanBrand = stripControlChars(brand).trim();
  if (!cleanLine) return cleanBrand;
  if (!cleanBrand) return cleanLine;
  if (cleanLine.toLowerCase().startsWith(cleanBrand.toLowerCase())) return cleanLine;
  return `${cleanBrand} — ${cleanLine}`;
}

// Format a recent-change % to the badge string, e.g. "(+235%)", "(+9.3%)",
// "(-.5%)". Signed, at most 3 significant digit-chars, leading zero dropped,
// magnitude clamped to 999. Returns "" for non-finite input (no badge). Mirrors
// formatChangePct in server/src/util.js and the web/extension clients.
export function formatChangePct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const a = Math.abs(v);
  let body;
  if (a >= 100) body = String(Math.min(999, Math.round(a)));
  else if (a >= 10) body = String(Math.round(a));
  else if (a >= 1) body = a.toFixed(1).replace(/\.0$/, "");
  else if (a > 0) { body = a.toFixed(1).replace(/^0/, ""); if (body === ".0") body = "0"; }
  else body = "0";
  return `(${v < 0 ? "-" : "+"}${body}%)`;
}
