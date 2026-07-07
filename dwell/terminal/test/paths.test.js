import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API_BASE, resolveApiBase } from "../src/paths.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dwell-terminal-"));
}

test("resolveApiBase uses DWELL config, env, then default", () => {
  const home = tempDir();
  assert.equal(resolveApiBase({ home, env: {} }), DEFAULT_API_BASE);
  assert.equal(
    resolveApiBase({ home, env: { DWELL_BASE: "http://127.0.0.1:8787/api/" } }),
    "http://127.0.0.1:8787/api",
  );

  mkdirSync(join(home, ".dwell"), { recursive: true });
  writeFileSync(join(home, ".dwell", "config.json"), JSON.stringify({
    backendBaseUrl: "https://api.example.test/dwell/",
  }), "utf8");
  assert.equal(
    resolveApiBase({ home, env: { DWELL_BASE: "http://127.0.0.1:8787/api" } }),
    "https://api.example.test/dwell",
  );
});
