// Adversarial coverage for the account-link ("login") surface: device
// registration, the email magic-link request, link-status polling, and API
// base resolution. Grew out of a real incident — a new user's setup died with
// "device register 500" when the backend was down — so these pin the exact
// failure modes a user can hit between `dwell claude setup` and a linked
// account.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DwellBackend,
  ensureDevice,
  linkAccountEmail,
  readDevice,
  waitForLink,
  writeDevice,
  EMAIL_RE,
} from "../src/backend.js";
import { devicePath, resolveApiBase, DEFAULT_API_BASE } from "../src/paths.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "dwell-terminal-"));
}

// ---------- device registration failure modes ----------

test("registerDevice surfaces the HTTP status (the 'device register 500' incident)", async () => {
  const backend = new DwellBackend({
    base: "https://api.example",
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: "WORKER_ERROR", message: "Function exited due to an error" }), { status: 500 }),
  });
  await assert.rejects(() => backend.registerDevice(), /device register 500/);
});

test("registerDevice rejects a 200 with a non-JSON body", async () => {
  const backend = new DwellBackend({
    base: "https://api.example",
    fetchImpl: async () => new Response("<html>gateway error</html>", { status: 200 }),
  });
  await assert.rejects(() => backend.registerDevice());
});

test("registerDevice rejects a 200 missing deviceId/deviceKey", async () => {
  for (const body of [{}, { deviceId: "d" }, { deviceKey: "k" }, { deviceId: "", deviceKey: "k" }]) {
    const backend = new DwellBackend({
      base: "https://api.example",
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    });
    await assert.rejects(() => backend.registerDevice(), /bad device response/);
  }
});

test("a failed registration persists nothing — the retry starts clean", async () => {
  const home = tempHome();
  const backend = {
    async registerDevice() { throw new Error("device register 500"); },
  };
  await assert.rejects(() => ensureDevice(home, backend), /device register 500/);
  assert.equal(readDevice(home), null, "no half-written device.json after a failure");
});

test("requests time out instead of hanging forever", async () => {
  const backend = new DwellBackend({
    base: "https://api.example",
    timeoutMs: 20,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  });
  // AbortSignal.timeout's timer is unref'd in Node — keep the loop alive so the
  // abort actually fires instead of the test draining the event loop first.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(() => backend.registerDevice(), (err) => err.name === "TimeoutError");
  } finally {
    clearTimeout(keepAlive);
  }
});

// ---------- local device state (what a retry reads back) ----------

test("ensureDevice re-registers over a corrupt device.json", async () => {
  const home = tempHome();
  mkdirSync(join(home, ".dwell"), { recursive: true });
  writeFileSync(devicePath(home), "{not json", "utf8");
  const backend = {
    async registerDevice() { return { deviceId: "fresh", deviceKey: "key" }; },
  };
  assert.deepEqual(await ensureDevice(home, backend), { deviceId: "fresh", deviceKey: "key" });
  assert.deepEqual(readDevice(home), { deviceId: "fresh", deviceKey: "key" });
});

test("ensureDevice re-registers when device.json is missing a field", async () => {
  const home = tempHome();
  writeDevice(home, { deviceId: "only-id" }); // no deviceKey — unusable creds
  let registered = 0;
  const backend = {
    async registerDevice() { registered++; return { deviceId: "d2", deviceKey: "k2" }; },
  };
  await ensureDevice(home, backend);
  assert.equal(registered, 1);
});

test("a cached device never touches the network", async () => {
  const home = tempHome();
  writeDevice(home, { deviceId: "cached", deviceKey: "secret" });
  const backend = {
    async registerDevice() { throw new Error("network must not be hit"); },
  };
  assert.deepEqual(await ensureDevice(home, backend), { deviceId: "cached", deviceKey: "secret" });
});

test("device.json lands owner-only (0600) — deviceKey is a bearer secret", { skip: process.platform === "win32" }, async () => {
  const home = tempHome();
  writeDevice(home, { deviceId: "d", deviceKey: "k" });
  const mode = statSync(devicePath(home)).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ---------- email validation at the door ----------

test("EMAIL_RE accepts real-world shapes and rejects garbage", () => {
  for (const good of [
    "a@b.co",
    "first.last@example.com",
    "user+tag@example.co.uk",
    "UPPER@EXAMPLE.COM",
    "fullerton.work@icloud.com",
  ]) assert.ok(EMAIL_RE.test(good), `${good} should pass`);
  for (const bad of [
    "",
    "nope",
    "a@b",
    "@example.com",
    "a@.com",
    "a b@c.co",
    "a@b c.co",
    "a\n@b.co",
    "mailto:a@b.co ",
  ]) assert.ok(!EMAIL_RE.test(bad), `${JSON.stringify(bad)} should fail`);
});

test("linkAccountEmail: registration failure aborts before the email request", async () => {
  const home = tempHome();
  let emailed = 0;
  const backend = {
    async registerDevice() { throw new Error("device register 500"); },
    async requestEmailLink() { emailed++; return { ok: true }; },
  };
  await assert.rejects(() => linkAccountEmail(home, backend, "me@example.com"), /device register 500/);
  assert.equal(emailed, 0, "no link email attempted without device creds");
});

// ---------- the magic-link request itself ----------

test("requestEmailLink falls back to 'request-link <status>' when the error body isn't JSON", async () => {
  const backend = new DwellBackend({
    base: "https://api.example",
    fetchImpl: async () => new Response("bad gateway", { status: 503 }),
  });
  await assert.rejects(
    () => backend.requestEmailLink({ deviceId: "d", deviceKey: "k" }, "me@example.com"),
    /request-link 503/
  );
});

test("requestEmailLink tolerates a 200 with an empty/unparsable body", async () => {
  const backend = new DwellBackend({
    base: "https://api.example",
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  assert.deepEqual(
    await backend.requestEmailLink({ deviceId: "d", deviceKey: "k" }, "me@example.com"),
    { ok: true, sent: true }
  );
});

test("requestEmailLink reports sent:false when the server says so (cooldown suppression)", async () => {
  const backend = new DwellBackend({
    base: "https://api.example",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, sent: false }), { status: 200 }),
  });
  const res = await backend.requestEmailLink({ deviceId: "d", deviceKey: "k" }, "me@example.com");
  assert.equal(res.sent, false);
});

// ---------- waiting for the click ----------

test("waitForLink returns immediately when the first probe is already linked", async () => {
  let slept = 0;
  const backend = { async linkStatus() { return { linked: true, email: "me@example.com" }; } };
  const status = await waitForLink(backend, { deviceId: "d", deviceKey: "k" }, {
    timeoutMs: 60000, intervalMs: 1000, sleep: async () => { slept++; },
  });
  assert.equal(status.linked, true);
  assert.equal(slept, 0, "no sleep before the first probe or after success");
});

test("waitForLink never sleeps past its deadline", async () => {
  let probes = 0;
  const backend = { async linkStatus() { probes++; return { linked: false, email: null }; } };
  const t0 = Date.now();
  await waitForLink(backend, { deviceId: "d", deviceKey: "k" }, { timeoutMs: 120, intervalMs: 50 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `poll loop overshot its deadline (${elapsed}ms)`);
  assert.ok(probes >= 1);
});

test("waitForLink returns the unlinked default when every probe throws", async () => {
  const backend = { async linkStatus() { throw new Error("network down"); } };
  const status = await waitForLink(backend, { deviceId: "d", deviceKey: "k" }, {
    timeoutMs: 30, intervalMs: 10, sleep: async () => {},
  });
  assert.deepEqual(status, { linked: false, email: null });
});

// ---------- which backend the login talks to ----------

test("resolveApiBase: user config beats env beats default, slashes trimmed", () => {
  const home = tempHome();
  assert.equal(resolveApiBase({ home, env: {} }), DEFAULT_API_BASE);
  assert.equal(
    resolveApiBase({ home, env: { DWELL_BASE: "https://env.example/api///" } }),
    "https://env.example/api"
  );
  mkdirSync(join(home, ".dwell"), { recursive: true });
  writeFileSync(join(home, ".dwell", "config.json"), JSON.stringify({ backendBaseUrl: "https://cfg.example/base/" }));
  assert.equal(
    resolveApiBase({ home, env: { DWELL_BASE: "https://env.example" } }),
    "https://cfg.example/base"
  );
});

test("resolveApiBase: blank config values fall through instead of producing ''", () => {
  const home = tempHome();
  mkdirSync(join(home, ".dwell"), { recursive: true });
  writeFileSync(join(home, ".dwell", "config.json"), JSON.stringify({ backendBaseUrl: "   " }));
  assert.equal(resolveApiBase({ home, env: {} }), DEFAULT_API_BASE);
  writeFileSync(join(home, ".dwell", "config.json"), "{corrupt");
  assert.equal(resolveApiBase({ home, env: {} }), DEFAULT_API_BASE);
});
