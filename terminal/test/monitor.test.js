import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delay } from "../src/util.js";
import { startSessionMonitor } from "../src/monitor.js";
import { initialState, readState, writeState } from "../src/state.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dwell-terminal-"));
}

test("monitor serves a token then redeems it once after the qualifying dwell (server-authoritative)", async () => {
  const home = tempDir();
  const dir = tempDir();
  const statePath = join(dir, "state.json");
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript,
    "{\"entrypoint\":\"cli\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    "utf8");
  const state = initialState({
    sessionId: "s1",
    ad: { id: "ad1", line: "Ad", url: "https://ad.example" },
    trackingUrl: "https://api.example/v1/go/tok",
  });
  state.lastHeartbeatMs = Date.now();
  state.transcriptPath = transcript;
  writeState(statePath, state);

  let serves = 0;
  const redeems = [];
  const monitor = startSessionMonitor({
    statePath,
    home,
    ad: { id: "ad1" },
    device: { deviceId: "dev", deviceKey: "key" },
    backend: {
      async serveImpression() { serves += 1; return `tok-${serves}`; },
      async redeemImpression(_device, token) { redeems.push(token); return { ok: true }; },
    },
    intervalMs: 10,
    viewThresholdMs: 30,
    heartbeatFreshMs: 1000,
    transcriptFreshMs: 1000,
  });
  await delay(140);
  monitor.stop();
  // exactly one bill per active segment, and it's the token that was served
  assert.equal(redeems.length, 1);
  assert.equal(redeems[0], "tok-1", "redeemed the served token");
  assert.equal(serves, 1, "one token served for the segment");
  assert.equal(readState(statePath).impression.sent, true);
  assert.equal(readState(statePath).impression.token, "tok-1");
});

test("monitor does not bill without a statusline heartbeat", async () => {
  const home = tempDir();
  const dir = tempDir();
  const statePath = join(dir, "state.json");
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript,
    "{\"entrypoint\":\"cli\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    "utf8");
  const state = initialState({
    sessionId: "s1",
    ad: { id: "ad1", line: "Ad", url: "https://ad.example" },
    trackingUrl: "https://api.example/v1/go/tok",
  });
  state.transcriptPath = transcript;
  writeState(statePath, state);

  let calls = 0;
  const monitor = startSessionMonitor({
    statePath,
    home,
    ad: { id: "ad1" },
    device: { deviceId: "dev", deviceKey: "key" },
    backend: {
      async serveImpression() { calls++; return "tok"; },
      async redeemImpression() { calls++; return { ok: true }; },
    },
    intervalMs: 10,
    viewThresholdMs: 20,
    heartbeatFreshMs: 1000,
    transcriptFreshMs: 1000,
  });
  await delay(60);
  monitor.stop();
  assert.equal(calls, 0, "no heartbeat ⇒ never serves or redeems");
});
