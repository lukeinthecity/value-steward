import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordEmailHealth, instrumentTransporter } from "../core/emailHealth.js";

async function withTempCwd(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-email-health-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  process.chdir(dir);
  try {
    // await handles both sync and async fn — ensures the temp dir is the
    // cwd for the entire body before we chdir back.
    return await fn(dir);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readHealth(dir) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "data", "email-health.json"), "utf8")
  );
}

test("recordEmailHealth: writes ok outcome with success timestamp", async () => {
  await withTempCwd((dir) => {
    recordEmailHealth({ label: "eod", ok: true });
    const h = readHealth(dir);
    assert.equal(h.eod.last_outcome, "ok");
    assert.equal(h.eod.last_error, null);
    assert.ok(h.eod.last_success_at);
    assert.ok(h.eod.last_attempt_at);
  });
});

test("recordEmailHealth: error preserves prior success timestamp", async () => {
  await withTempCwd((dir) => {
    recordEmailHealth({ label: "eod", ok: true });
    const firstSuccess = readHealth(dir).eod.last_success_at;
    recordEmailHealth({ label: "eod", ok: false, error: "535 auth failed" });
    const h = readHealth(dir);
    assert.equal(h.eod.last_outcome, "error");
    assert.equal(h.eod.last_error, "535 auth failed");
    // The last successful send timestamp is retained across a later failure.
    assert.equal(h.eod.last_success_at, firstSuccess);
  });
});

test("recordEmailHealth: tracks multiple labels independently", async () => {
  await withTempCwd((dir) => {
    recordEmailHealth({ label: "eod", ok: true });
    recordEmailHealth({ label: "weekly report email", ok: false, error: "boom" });
    const h = readHealth(dir);
    assert.equal(h.eod.last_outcome, "ok");
    assert.equal(h["weekly report email"].last_outcome, "error");
  });
});

test("recordEmailHealth: truncates very long error messages", async () => {
  await withTempCwd((dir) => {
    recordEmailHealth({ label: "x", ok: false, error: "e".repeat(1000) });
    const h = readHealth(dir);
    assert.ok(h.x.last_error.length <= 300);
  });
});

test("instrumentTransporter: records ok on successful sendMail", async () => {
  await withTempCwd(async (dir) => {
    const fakeTransport = {
      sendMail: async () => ({ messageId: "abc" }),
    };
    instrumentTransporter(fakeTransport, "health email");
    const res = await fakeTransport.sendMail({ subject: "test" });
    assert.equal(res.messageId, "abc");
    assert.equal(readHealth(dir)["health email"].last_outcome, "ok");
  });
});

test("instrumentTransporter: records error and re-throws on failed sendMail", async () => {
  await withTempCwd(async (dir) => {
    const fakeTransport = {
      sendMail: async () => {
        throw new Error("Invalid login: 535-5.7.8");
      },
    };
    instrumentTransporter(fakeTransport, "eod");
    await assert.rejects(
      () => fakeTransport.sendMail({ subject: "test" }),
      /535-5.7.8/
    );
    const h = readHealth(dir);
    assert.equal(h.eod.last_outcome, "error");
    assert.match(h.eod.last_error, /535/);
  });
});

test("instrumentTransporter: no-op on a transport without sendMail", () => {
  const obj = {};
  const out = instrumentTransporter(obj, "x");
  assert.equal(out, obj);
});
