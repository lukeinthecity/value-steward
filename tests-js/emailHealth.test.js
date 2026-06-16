import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordEmailHealth, instrumentTransporter } from "../core/emailHealth.js";

// Each test gets its own temp file via VS_EMAIL_HEALTH_PATH so we never touch
// the real data/email-health.json and never mutate process.cwd() (which is
// global and unsafe under node:test concurrency).
async function withTempHealthFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-email-health-"));
  const file = path.join(dir, "email-health.json");
  const prev = process.env.VS_EMAIL_HEALTH_PATH;
  process.env.VS_EMAIL_HEALTH_PATH = file;
  try {
    // await so the env override stays in place for the entire body (sync or
    // async) before we restore it.
    return await fn(file);
  } finally {
    if (prev === undefined) delete process.env.VS_EMAIL_HEALTH_PATH;
    else process.env.VS_EMAIL_HEALTH_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readHealth = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("recordEmailHealth: writes ok outcome with success timestamp", async () => {
  await withTempHealthFile((file) => {
    recordEmailHealth({ label: "eod", ok: true });
    const h = readHealth(file);
    assert.equal(h.eod.last_outcome, "ok");
    assert.equal(h.eod.last_error, null);
    assert.ok(h.eod.last_success_at);
    assert.ok(h.eod.last_attempt_at);
  });
});

test("recordEmailHealth: error preserves prior success timestamp", async () => {
  await withTempHealthFile((file) => {
    recordEmailHealth({ label: "eod", ok: true });
    const firstSuccess = readHealth(file).eod.last_success_at;
    recordEmailHealth({ label: "eod", ok: false, error: "535 auth failed" });
    const h = readHealth(file);
    assert.equal(h.eod.last_outcome, "error");
    assert.equal(h.eod.last_error, "535 auth failed");
    assert.equal(h.eod.last_success_at, firstSuccess);
  });
});

test("recordEmailHealth: tracks multiple labels independently", async () => {
  await withTempHealthFile((file) => {
    recordEmailHealth({ label: "eod", ok: true });
    recordEmailHealth({ label: "weekly report email", ok: false, error: "x" });
    const h = readHealth(file);
    assert.equal(h.eod.last_outcome, "ok");
    assert.equal(h["weekly report email"].last_outcome, "error");
  });
});

test("recordEmailHealth: truncates very long error messages", async () => {
  await withTempHealthFile((file) => {
    recordEmailHealth({ label: "z", ok: false, error: "e".repeat(1000) });
    assert.ok(readHealth(file).z.last_error.length <= 300);
  });
});

test("instrumentTransporter: records ok on successful sendMail", async () => {
  await withTempHealthFile(async (file) => {
    const fake = { sendMail: async () => ({ messageId: "abc" }) };
    instrumentTransporter(fake, "health email");
    const res = await fake.sendMail({ subject: "t" });
    assert.equal(res.messageId, "abc");
    assert.equal(readHealth(file)["health email"].last_outcome, "ok");
  });
});

test("instrumentTransporter: records error and re-throws on failed sendMail", async () => {
  await withTempHealthFile(async (file) => {
    const fake = {
      sendMail: async () => {
        throw new Error("Invalid login: 535-5.7.8");
      },
    };
    instrumentTransporter(fake, "eod");
    await assert.rejects(() => fake.sendMail({ subject: "t" }), /535-5.7.8/);
    assert.match(readHealth(file).eod.last_error, /535/);
  });
});

test("instrumentTransporter: no-op on a transport without sendMail", () => {
  const obj = {};
  assert.equal(instrumentTransporter(obj, "x"), obj);
});
