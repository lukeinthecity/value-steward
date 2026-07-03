import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  composeStatusLine,
  isHalted,
  maybeSendInitialize,
  maybeSendSessionOff,
  maybeSendHealthAlert,
} from "../core/pushTriggers.js";

function tmpStatePath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-push-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "push-state.json");
}

function capturingSend(result = { ok: true, skipped: false, status: 200 }) {
  const calls = [];
  const send = async (args) => {
    calls.push(args);
    return result;
  };
  return { send, calls };
}

const SNAPSHOT = {
  policy: { mode: "LOW" },
  feeds: { stale_count: 0 },
  issues: [],
};
const STATE_OK = {
  current_mode: "LOW",
  trading_enabled: true,
  force_no_trade: false,
};
const PORTFOLIO = { account: { equity: 99976.31 }, positions: [{}, {}] };

test("composeStatusLine summarizes mode/trading/equity/positions/feeds", () => {
  const line = composeStatusLine({
    snapshot: SNAPSHOT,
    state: STATE_OK,
    portfolio: PORTFOLIO,
  });
  assert.match(line, /LOW/);
  assert.match(line, /trading ✓/);
  assert.match(line, /equity \$99,976/);
  assert.match(line, /2 pos/);
  assert.match(line, /feeds OK/);
});

test("composeStatusLine flags halted trading and stale feeds", () => {
  const line = composeStatusLine({
    snapshot: { policy: { mode: "LOW" }, feeds: { stale_count: 3 } },
    state: { trading_enabled: false },
    portfolio: PORTFOLIO,
  });
  assert.match(line, /trading ✗/);
  assert.match(line, /feeds 3 stale/);
});

test("isHalted true when disabled or force_no_trade", () => {
  assert.equal(
    isHalted({ trading_enabled: true, force_no_trade: false }),
    false,
  );
  assert.equal(isHalted({ trading_enabled: false }), true);
  assert.equal(isHalted({ force_no_trade: true }), true);
});

test("maybeSendInitialize sends once per day then dedupes", async (t) => {
  const statePath = tmpStatePath(t);
  const { send, calls } = capturingSend();
  const now = new Date("2026-06-19T13:35:00Z");
  const r1 = await maybeSendInitialize({
    snapshot: SNAPSHOT,
    state: STATE_OK,
    portfolio: PORTFOLIO,
    now,
    send,
    pushStatePathOverride: statePath,
  });
  assert.equal(r1.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].statusLine, /LOW/);

  const r2 = await maybeSendInitialize({
    snapshot: SNAPSHOT,
    state: STATE_OK,
    portfolio: PORTFOLIO,
    now,
    send,
    pushStatePathOverride: statePath,
  });
  assert.equal(r2.sent, false);
  assert.equal(r2.reason, "already_sent_today");
  assert.equal(calls.length, 1);
});

test("maybeSendInitialize does not consume the day when push is unconfigured", async (t) => {
  const statePath = tmpStatePath(t);
  const skipping = capturingSend({ ok: false, skipped: true });
  const now = new Date("2026-06-19T13:35:00Z");
  const r1 = await maybeSendInitialize({
    snapshot: SNAPSHOT,
    state: STATE_OK,
    portfolio: PORTFOLIO,
    now,
    send: skipping.send,
    pushStatePathOverride: statePath,
  });
  assert.equal(r1.reason, "skipped_unconfigured");

  // Not recorded -> a later (configured) send still goes through.
  const working = capturingSend();
  const r2 = await maybeSendInitialize({
    snapshot: SNAPSHOT,
    state: STATE_OK,
    portfolio: PORTFOLIO,
    now,
    send: working.send,
    pushStatePathOverride: statePath,
  });
  assert.equal(r2.sent, true);
  assert.equal(working.calls.length, 1);
});

test("maybeSendSessionOff marks unexpected when halted", async (t) => {
  const statePath = tmpStatePath(t);
  const { send, calls } = capturingSend();
  const now = new Date("2026-06-19T21:35:00Z");
  await maybeSendSessionOff({
    snapshot: SNAPSHOT,
    state: { force_no_trade: true },
    portfolio: PORTFOLIO,
    now,
    send,
    pushStatePathOverride: statePath,
  });
  assert.equal(calls[0].unexpected, true);
  assert.match(calls[0].statusLine, /HALTED/);
});

test("maybeSendHealthAlert sends, dedupes same sig, re-alerts on change, clears on resolve", async (t) => {
  const statePath = tmpStatePath(t);
  const { send, calls } = capturingSend();
  const base = new Date("2026-06-19T14:00:00Z");
  const snap = (codes) => ({
    issues: codes.map((c) => ({ code: c, message: `${c} msg` })),
  });

  const r1 = await maybeSendHealthAlert({
    snapshot: snap(["feeds_stale"]),
    now: base,
    send,
    pushStatePathOverride: statePath,
    minHours: 6,
  });
  assert.equal(r1.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].issueCount, 1);

  // Same signature 1h later -> deduped.
  const r2 = await maybeSendHealthAlert({
    snapshot: snap(["feeds_stale"]),
    now: new Date(base.getTime() + 3600000),
    send,
    pushStatePathOverride: statePath,
    minHours: 6,
  });
  assert.equal(r2.reason, "deduped");
  assert.equal(calls.length, 1);

  // New signature -> alerts immediately even within the window.
  const r3 = await maybeSendHealthAlert({
    snapshot: snap(["feeds_stale", "tick_stale"]),
    now: new Date(base.getTime() + 3600000),
    send,
    pushStatePathOverride: statePath,
    minHours: 6,
  });
  assert.equal(r3.sent, true);
  assert.equal(calls.length, 2);

  // Resolved -> no_issues and state cleared, so a re-occurrence alerts again.
  const r4 = await maybeSendHealthAlert({
    snapshot: snap([]),
    now: new Date(base.getTime() + 7200000),
    send,
    pushStatePathOverride: statePath,
    minHours: 6,
  });
  assert.equal(r4.reason, "no_issues");
  const r5 = await maybeSendHealthAlert({
    snapshot: snap(["feeds_stale"]),
    now: new Date(base.getTime() + 7200000),
    send,
    pushStatePathOverride: statePath,
    minHours: 6,
  });
  assert.equal(r5.sent, true);
  assert.equal(calls.length, 3);
});
