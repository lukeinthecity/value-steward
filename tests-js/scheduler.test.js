import test from "node:test";
import assert from "node:assert/strict";

import { shouldRunScheduledEod } from "../scripts/eodRunScheduled.js";
import { shouldRunScheduledLocalTick } from "../scripts/localTickScheduled.js";
import { shouldRunScheduledWorld } from "../scripts/worldRunScheduled.js";

test("local tick scheduler follows early-close execution slots", () => {
  const earlyCloseOpen = new Date("2026-11-27T17:30:00Z"); // 12:30 ET, 30 min before 13:00 close
  const midSlot = new Date("2026-11-27T17:35:00Z"); // 12:35 ET, not a configured slot

  const first = shouldRunScheduledLocalTick({ now: earlyCloseOpen });
  const second = shouldRunScheduledLocalTick({ now: midSlot });

  assert.equal(first.run, true);
  assert.equal(first.reason, "execution_slot");
  assert.equal(first.minutesUntilClose, 30);

  assert.equal(second.run, false);
  assert.equal(second.reason, "not_execution_slot");
  assert.equal(second.minutesUntilClose, 25);
});

test("eod scheduler respects post-close window and canonical dedupe", () => {
  const tooEarly = new Date("2026-11-27T18:10:00Z"); // 13:10 ET, 10 min after early close
  const inWindow = new Date("2026-11-27T18:15:00Z"); // 13:15 ET, 15 min after early close

  const first = shouldRunScheduledEod({ now: tooEarly, lastEodDate: null });
  const second = shouldRunScheduledEod({ now: inWindow, lastEodDate: null });
  const third = shouldRunScheduledEod({
    now: inWindow,
    lastEodDate: "2026-11-27",
  });

  assert.equal(first.run, false);
  assert.equal(first.reason, "outside_post_close_window");

  assert.equal(second.run, true);
  assert.equal(second.reason, "window_open");

  assert.equal(third.run, false);
  assert.equal(third.reason, "already_sent");
});

test("eod scheduler skips non-trading days", () => {
  const holidayPostClose = new Date("2026-04-03T20:15:00Z"); // Good Friday, 16:15 ET

  const decision = shouldRunScheduledEod({
    now: holidayPostClose,
    lastEodDate: null,
  });

  assert.equal(decision.run, false);
  assert.equal(decision.reason, "non_trading_day");
});

test("world scheduler force bypasses window and dedupe checks", () => {
  const now = new Date("2026-03-13T02:00:00Z");

  const forced = shouldRunScheduledWorld({
    now,
    force: true,
    latest: {
      date: "2026-03-12",
      slot: "pre_close",
      generated_at: "2026-03-12T20:35:00.000Z",
    },
  });
  const normal = shouldRunScheduledWorld({
    now,
    force: false,
    latest: null,
  });

  assert.equal(forced.run, true);
  assert.equal(forced.reason, "forced");
  assert.equal(forced.slot, "forced");

  assert.equal(normal.run, false);
  assert.equal(normal.reason, "outside_window");
});
