import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importModule() {
  const moduleUrl = `${pathToFileURL(
    path.join(repoRoot, "core", "channelHealth.js")
  ).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

function tmpHealthFile(t, envVar) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-channel-health-"));
  const filePath = path.join(tmpDir, "health.json");
  const previous = process.env[envVar];
  process.env[envVar] = filePath;
  t.after(() => {
    if (previous === undefined) delete process.env[envVar];
    else process.env[envVar] = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return filePath;
}

test("env override wins and outcomes round-trip", async (t) => {
  const { createChannelHealth } = await importModule();
  const filePath = tmpHealthFile(t, "VS_TEST_CHANNEL_HEALTH_PATH");
  const channel = createChannelHealth({
    envVar: "VS_TEST_CHANNEL_HEALTH_PATH",
    defaultFile: "never-used.json",
  });

  assert.equal(channel.healthPath(), filePath);

  channel.recordHealth({ label: "EOD", ok: true });
  let health = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(health.eod.last_outcome, "ok");
  assert.equal(health.eod.last_error, null);
  assert.ok(health.eod.last_success_at);

  const successAt = health.eod.last_success_at;
  channel.recordHealth({ label: "eod", ok: false, error: "boom" });
  health = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(health.eod.last_outcome, "error");
  assert.equal(health.eod.last_error, "boom");
  // Failure preserves the last success timestamp.
  assert.equal(health.eod.last_success_at, successAt);
});

test("recovers from a corrupt health file", async (t) => {
  const { createChannelHealth } = await importModule();
  const filePath = tmpHealthFile(t, "VS_TEST_CHANNEL_HEALTH_PATH");
  fs.writeFileSync(filePath, "{not json");

  const channel = createChannelHealth({
    envVar: "VS_TEST_CHANNEL_HEALTH_PATH",
    defaultFile: "never-used.json",
  });
  channel.recordHealth({ label: "health", ok: true });

  const health = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(health.health.last_outcome, "ok");
});

test("long errors truncate to 300 chars and labels normalize", async (t) => {
  const { createChannelHealth } = await importModule();
  const filePath = tmpHealthFile(t, "VS_TEST_CHANNEL_HEALTH_PATH");
  const channel = createChannelHealth({
    envVar: "VS_TEST_CHANNEL_HEALTH_PATH",
    defaultFile: "never-used.json",
  });

  channel.recordHealth({ label: "  ", ok: false, error: "x".repeat(500) });
  const health = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(health.unknown.last_error.length, 300);
});

test("write is atomic — no .tmp file left behind", async (t) => {
  const { createChannelHealth } = await importModule();
  const filePath = tmpHealthFile(t, "VS_TEST_CHANNEL_HEALTH_PATH");
  const channel = createChannelHealth({
    envVar: "VS_TEST_CHANNEL_HEALTH_PATH",
    defaultFile: "never-used.json",
  });
  channel.recordHealth({ label: "weekly", ok: true });
  assert.ok(fs.existsSync(filePath));
  assert.ok(!fs.existsSync(`${filePath}.tmp`));
});

test("email and push wrappers keep their public APIs on the shared core", async () => {
  const emailUrl = `${pathToFileURL(path.join(repoRoot, "core", "emailHealth.js")).href}?v=${Date.now()}`;
  const pushUrl = `${pathToFileURL(path.join(repoRoot, "core", "pushHealth.js")).href}?v=${Date.now()}`;
  const email = await import(emailUrl);
  const push = await import(pushUrl);

  assert.equal(typeof email.recordEmailHealth, "function");
  assert.equal(typeof email.instrumentTransporter, "function");
  assert.equal(typeof email.emailHealthPath, "function");
  assert.equal(typeof push.recordPushHealth, "function");
  assert.equal(typeof push.pushHealthPath, "function");
  assert.match(email.emailHealthPath(), /email-health\.json$/);
  assert.match(push.pushHealthPath(), /push-health\.json$/);
});
