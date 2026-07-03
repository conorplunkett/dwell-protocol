import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "./util.js";

export const MARKER_START = "# >>> FreeAI Claude terminal integration >>>";
export const MARKER_END = "# <<< FreeAI Claude terminal integration <<<";

export function shellFromEnv(env = process.env) {
  const shell = env.SHELL || "";
  if (shell.endsWith("/fish")) return "fish";
  if (shell.endsWith("/bash")) return "bash";
  return "zsh";
}

export function defaultRcPath(shell, home = homedir()) {
  if (shell === "fish") return join(home, ".config", "fish", "config.fish");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".zshrc");
}

export function shellBlock(shell) {
  // Defined as a function (not a bare alias) so that if `freeai` is ever missing
  // — uninstalled, moved, not yet on PATH — the wrapper transparently falls
  // through to the real `claude` (the npm shim) instead of leaving the user with
  // `command not found: freeai`. `command claude` bypasses this function, so
  // there is no recursion. Upholds the "FreeAI must never break the session" rule
  // even at the shell layer.
  if (shell === "fish") {
    return `${MARKER_START}
function claude
    if command -v freeai >/dev/null 2>&1
        freeai claude run $argv
    else
        command claude $argv
    end
end
${MARKER_END}
`;
  }
  return `${MARKER_START}
claude() {
  if command -v freeai >/dev/null 2>&1; then
    freeai claude run "$@"
  else
    command claude "$@"
  fi
}
${MARKER_END}
`;
}

export function stripFreeAiBlock(content) {
  const re = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`, "g");
  return content.replace(re, "");
}

export function hasNonFreeAiClaudeDefinition(content, shell) {
  const stripped = stripFreeAiBlock(content);
  if (shell === "fish") {
    return /^\s*(?:function\s+claude\b|alias\s+claude\b)/m.test(stripped);
  }
  return /^\s*(?:alias\s+claude=|function\s+claude\b|claude\s*\(\s*\))/m.test(stripped);
}

export function installShellBlock({
  shell = shellFromEnv(),
  rcPath = defaultRcPath(shell),
  force = false,
} = {}) {
  const current = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  if (!force && hasNonFreeAiClaudeDefinition(current, shell)) {
    throw new Error(`found an existing claude alias/function in ${rcPath}; rerun with --force to replace only the FreeAI block`);
  }
  const nextBlock = shellBlock(shell);
  const without = stripFreeAiBlock(current).replace(/\s*$/, "");
  const next = without ? `${without}\n${nextBlock}` : nextBlock;
  // Atomic write: a truncated/partial rc (interrupt, ENOSPC, power loss) would
  // break every future interactive shell, not just `claude`.
  writeFileAtomic(rcPath, next);
  return { rcPath, shell, changed: next !== current };
}

export function restoreShellBlock({
  shell = shellFromEnv(),
  rcPath = defaultRcPath(shell),
} = {}) {
  if (!existsSync(rcPath)) return { rcPath, shell, changed: false };
  const current = readFileSync(rcPath, "utf8");
  const next = stripFreeAiBlock(current);
  if (next !== current) writeFileAtomic(rcPath, next);
  return { rcPath, shell, changed: next !== current };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
