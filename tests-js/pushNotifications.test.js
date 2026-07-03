import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sendPush, sendHealthAlertPush } from "../core/pushNotifications.js";

// Run fn with env overrides applied, restoring originals afterward.
// (undefined value => delete the var for the duration.)
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(overrides)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
  return { fetchImpl, calls };
}

function tmpHealthPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-push-health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "push-health.json");
}

test("sendPush posts to ntfy with title/priority/tags/click and records ok", async (t) => {
  const healthPath = tmpHealthPath(t);
  const { fetchImpl, calls } = makeFetch(async () => ({
    ok: true,
    status: 200,
  }));
  await withEnv(
    {
      VS_NTFY_TOPIC: "secret-topic",
      VS_NTFY_SERVER: "https://ntfy.example",
      VS_PUSH_ENABLED: "true",
      VS_PUSH_HEALTH_PATH: healthPath,
      VS_NTFY_TOKEN: undefined,
    },
    async () => {
      const res = await sendPush({
        label: "test",
        title: "Hello",
        message: "world",
        priority: 4,
        tags: ["rocket", "warning"],
        clickUrl: "https://example.com/r",
        fetchImpl,
        retries: 0,
      });
      assert.equal(res.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://ntfy.example/secret-topic");
      assert.equal(calls[0].opts.method, "POST");
      assert.equal(calls[0].opts.body, "world");
      assert.equal(calls[0].opts.headers.Title, "Hello");
      assert.equal(calls[0].opts.headers.Priority, "4");
      assert.equal(calls[0].opts.headers.Tags, "rocket,warning");
      assert.equal(calls[0].opts.headers.Click, "https://example.com/r");
      assert.equal(calls[0].opts.headers.Authorization, undefined);
    },
  );
  const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  assert.equal(health.test.last_outcome, "ok");
  assert.ok(health.test.last_success_at);
});

test("sendPush adds bearer auth header when VS_NTFY_TOKEN is set", async (t) => {
  const healthPath = tmpHealthPath(t);
  const { fetchImpl, calls } = makeFetch(async () => ({
    ok: true,
    status: 200,
  }));
  await withEnv(
    {
      VS_NTFY_TOPIC: "t",
      VS_NTFY_TOKEN: "tk_secret",
      VS_PUSH_HEALTH_PATH: healthPath,
    },
    async () => {
      await sendPush({ label: "test", message: "x", fetchImpl, retries: 0 });
      assert.equal(calls[0].opts.headers.Authorization, "Bearer tk_secret");
    },
  );
});

test("sendPush skips (no fetch call) when VS_NTFY_TOPIC unset", async (t) => {
  const healthPath = tmpHealthPath(t);
  const { fetchImpl, calls } = makeFetch(async () => ({
    ok: true,
    status: 200,
  }));
  await withEnv(
    { VS_NTFY_TOPIC: undefined, VS_PUSH_HEALTH_PATH: healthPath },
    async () => {
      const res = await sendPush({ message: "x", fetchImpl, retries: 0 });
      assert.equal(res.skipped, true);
      assert.equal(res.ok, false);
      assert.equal(calls.length, 0);
    },
  );
});

test("sendPush skips when VS_PUSH_ENABLED=false even with a topic", async (t) => {
  const healthPath = tmpHealthPath(t);
  const { fetchImpl, calls } = makeFetch(async () => ({
    ok: true,
    status: 200,
  }));
  await withEnv(
    {
      VS_NTFY_TOPIC: "t",
      VS_PUSH_ENABLED: "false",
      VS_PUSH_HEALTH_PATH: healthPath,
    },
    async () => {
      const res = await sendPush({ message: "x", fetchImpl, retries: 0 });
      assert.equal(res.skipped, true);
      assert.equal(calls.length, 0);
    },
  );
});

test("sendPush records error and does not throw on HTTP failure (with retry)", async (t) => {
  const healthPath = tmpHealthPath(t);
  const { fetchImpl, calls } = makeFetch(async () => ({
    ok: false,
    status: 503,
  }));
  await withEnv(
    {
      VS_NTFY_TOPIC: "t",
      VS_PUSH_ENABLED: "true",
      VS_PUSH_HEALTH_PATH: healthPath,
    },
    async () => {
      const res = await sendPush({
        label: "test",
        message: "x",
        fetchImpl,
        retries: 1,
        retryBaseMs: 1,
      });
      assert.equal(res.ok, false);
      assert.equal(res.skipped, false);
      assert.match(res.error, /http_503/);
      assert.equal(calls.length, 2); // initial attempt + 1 retry
    },
  );
  const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  assert.equal(health.test.last_outcome, "error");
});

test("sendPush does not throw when fetch itself rejects", async (t) => {
  const healthPath = tmpHealthPath(t);
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  await withEnv(
    {
      VS_NTFY_TOPIC: "t",
      VS_PUSH_ENABLED: "true",
      VS_PUSH_HEALTH_PATH: healthPath,
    },
    async () => {
      const res = await sendPush({
        label: "test",
        message: "x",
        fetchImpl,
        retries: 0,
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /network down/);
    },
  );
});

test("sendHealthAlertPush uses high priority + warning tag", async (t) => {
  const healthPath = tmpHealthPath(t);
  const { fetchImpl, calls } = makeFetch(async () => ({
    ok: true,
    status: 200,
  }));
  await withEnv(
    {
      VS_NTFY_TOPIC: "t",
      VS_PUSH_ENABLED: "true",
      VS_PUSH_HEALTH_PATH: healthPath,
    },
    async () => {
      await sendHealthAlertPush({
        issueCount: 2,
        summary: "stale feeds",
        fetchImpl,
        retries: 0,
      });
      assert.equal(calls[0].opts.headers.Priority, "4");
      assert.match(calls[0].opts.headers.Tags, /warning/);
      assert.match(calls[0].opts.headers.Title, /2 issues/);
    },
  );
});
