import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShellBlock, restoreShellBlock, MARKER_START, MARKER_END } from "../src/shell.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dwell-terminal-"));
}

test("installShellBlock inserts and replaces a reversible zsh alias block", () => {
  const dir = tempDir();
  const rc = join(dir, ".zshrc");
  writeFileSync(rc, "export FOO=1\n", "utf8");

  const installed = installShellBlock({ shell: "zsh", rcPath: rc });
  assert.equal(installed.changed, true);
  const first = readFileSync(rc, "utf8");
  assert.match(first, /claude\(\) \{/);
  assert.match(first, /dwell claude run "\$@"/);
  // Falls through to the real claude when dwell is missing (never bricks claude).
  assert.match(first, /command claude "\$@"/);
  assert.match(first, new RegExp(MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  installShellBlock({ shell: "zsh", rcPath: rc });
  const second = readFileSync(rc, "utf8");
  assert.equal(second.match(/DWELL Claude terminal integration/g).length, 2);

  const restored = restoreShellBlock({ shell: "zsh", rcPath: rc });
  assert.equal(restored.changed, true);
  assert.equal(readFileSync(rc, "utf8"), "export FOO=1\n");
});

test("installShellBlock migrates a legacy FreeAI block without --force", () => {
  const dir = tempDir();
  const rc = join(dir, ".zshrc");
  const freeaiBlock = `# >>> FreeAI Claude terminal integration >>>
claude() {
  if command -v freeai >/dev/null 2>&1; then
    freeai claude run "$@"
  else
    command claude "$@"
  fi
}
# <<< FreeAI Claude terminal integration <<<
`;
  writeFileSync(rc, `export FOO=1\n${freeaiBlock}`, "utf8");

  // The legacy block is ours, not a user-authored alias — setup must replace
  // it, not refuse with "existing claude alias/function".
  const installed = installShellBlock({ shell: "zsh", rcPath: rc });
  assert.equal(installed.changed, true);
  const content = readFileSync(rc, "utf8");
  assert.doesNotMatch(content, /FreeAI Claude terminal integration/);
  assert.doesNotMatch(content, /freeai claude run/);
  assert.match(content, /dwell claude run "\$@"/);

  // restore removes the DWELL block and leaves the rest of the rc intact.
  const restored = restoreShellBlock({ shell: "zsh", rcPath: rc });
  assert.equal(restored.changed, true);
  assert.equal(readFileSync(rc, "utf8"), "export FOO=1\n");
});

test("restoreShellBlock also removes a legacy FreeAI block", () => {
  const dir = tempDir();
  const rc = join(dir, ".bashrc");
  writeFileSync(rc, `# >>> FreeAI Claude terminal integration >>>
claude() { freeai claude run "$@"; }
# <<< FreeAI Claude terminal integration <<<
export BAR=2
`, "utf8");

  const restored = restoreShellBlock({ shell: "bash", rcPath: rc });
  assert.equal(restored.changed, true);
  assert.equal(readFileSync(rc, "utf8"), "export BAR=2\n");
});

test("installShellBlock aborts on an existing non-DWELL claude alias unless forced", () => {
  const dir = tempDir();
  const rc = join(dir, ".bashrc");
  writeFileSync(rc, "alias claude=/opt/claude\n", "utf8");

  assert.throws(() => installShellBlock({ shell: "bash", rcPath: rc }), /existing claude/);
  installShellBlock({ shell: "bash", rcPath: rc, force: true });
  const content = readFileSync(rc, "utf8");
  assert.match(content, /alias claude=\/opt\/claude/);
  assert.match(content, /dwell claude run "\$@"/);
});

test("installShellBlock writes fish function syntax", () => {
  const dir = tempDir();
  const rc = join(dir, "config.fish");
  installShellBlock({ shell: "fish", rcPath: rc });
  const content = readFileSync(rc, "utf8");
  assert.match(content, /function claude/);
  assert.match(content, /dwell claude run \$argv/);
  assert.match(content, new RegExp(MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
