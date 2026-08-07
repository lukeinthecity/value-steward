import test from "node:test";
import assert from "node:assert/strict";

import {
  isBuyRelatedRecord,
  isDeclinedBuyRecord,
  isTakenBuyRecord,
  dedupeScorecardRecords,
  scorecardDecisionKey,
} from "../core/scorecardSemantics.js";

test("isTakenBuyRecord matches executed buys only", () => {
  assert.equal(isTakenBuyRecord({ action_type: "BUY" }), true);
  assert.equal(isTakenBuyRecord({ action_type: "MULTI" }), true);
  assert.equal(isTakenBuyRecord({ action_type: "buy" }), true);
  assert.equal(
    isTakenBuyRecord({ action_type: "NO_ACTION", reason_code: "BUY_BLOCKED" }),
    false
  );
  assert.equal(isTakenBuyRecord({ action_type: "SELL" }), false);
  assert.equal(isTakenBuyRecord({}), false);
});

test("isDeclinedBuyRecord matches only NO_ACTION rows with a BUY_ reason", () => {
  assert.equal(
    isDeclinedBuyRecord({ action_type: "NO_ACTION", reason_code: "BUY_BLOCKED" }),
    true
  );
  assert.equal(
    isDeclinedBuyRecord({ action_type: "no_action", reason_code: "buy_blocked" }),
    true
  );
  assert.equal(
    isDeclinedBuyRecord({ action_type: "NO_ACTION", reason_code: "NO_SIGNAL" }),
    false
  );
  assert.equal(isDeclinedBuyRecord({ action_type: "NO_ACTION" }), false);
  assert.equal(isDeclinedBuyRecord({ action_type: "BUY" }), false);
});

test("taken and declined are mutually exclusive and partition buy-related", () => {
  const rows = [
    { action_type: "BUY" },
    { action_type: "MULTI" },
    { action_type: "NO_ACTION", reason_code: "BUY_BLOCKED" },
    { action_type: "NO_ACTION", reason_code: "NO_SIGNAL" },
    { action_type: "SELL" },
    {},
  ];
  for (const row of rows) {
    assert.equal(
      isTakenBuyRecord(row) && isDeclinedBuyRecord(row),
      false,
      "no row may be both taken and declined"
    );
    assert.equal(
      isBuyRelatedRecord(row),
      isTakenBuyRecord(row) || isDeclinedBuyRecord(row),
      "buy-related must be exactly the union"
    );
  }
});

test("SELL rows are excluded from every buy population", () => {
  const sell = { action_type: "SELL", reason_code: "ROTATION_SELL" };
  assert.equal(isTakenBuyRecord(sell), false);
  assert.equal(isDeclinedBuyRecord(sell), false);
  assert.equal(isBuyRelatedRecord(sell), false);
});

test("dedupe collapses per-slot replicas of one symbol-day", () => {
  const rows = ["19:30", "19:40", "19:50", "19:55"].map((slot) => ({
    intent_id: `intent-${slot}`,
    symbol: "NATL",
    entry_date: "2026-07-23",
    action_type: "NO_ACTION",
    reason_code: "BUY_BLOCKED",
  }));
  const deduped = dedupeScorecardRecords(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].intent_id, "intent-19:55", "keeps the latest slot");
});

test("dedupe keeps the executed action over a later block (KCCA 2026-07-14)", () => {
  // KCCA was BUY at the 19:30 slot, then BUY_BLOCKED at 19:40 once it was
  // already at target. The portfolio fact is the BUY, and keeping both would
  // give one forward return two opposite signs after orientation.
  const rows = [
    {
      intent_id: "a",
      symbol: "KCCA",
      entry_date: "2026-07-14",
      action_type: "BUY",
      reason_code: "UNDER_TARGET_BUY",
    },
    {
      intent_id: "b",
      symbol: "KCCA",
      entry_date: "2026-07-14",
      action_type: "NO_ACTION",
      reason_code: "BUY_BLOCKED",
    },
  ];
  const deduped = dedupeScorecardRecords(rows);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].action_type, "BUY");
  assert.equal(deduped[0].intent_id, "a");
});

test("rows without symbol or entry_date are never treated as replicas", () => {
  // Guards existing fixtures in scorecardTrainer.test.js, which set no symbol
  // and share an entry_date. Do not "improve" this into an intent_id fallback.
  const rows = [
    { intent_id: "blocked-1", entry_date: "2026-04-28", action_type: "NO_ACTION" },
    { intent_id: "blocked-2", entry_date: "2026-04-28", action_type: "NO_ACTION" },
  ];
  assert.equal(dedupeScorecardRecords(rows).length, 2);

  const noDate = [
    { intent_id: "x", symbol: "AAA", action_type: "BUY" },
    { intent_id: "y", symbol: "AAA", action_type: "BUY" },
  ];
  assert.equal(dedupeScorecardRecords(noDate).length, 2);
});

test("dedupe preserves chronological order so recency walks stay correct", () => {
  // Mirrors real slot interleaving: each slot emits a row per candidate.
  const rows = [
    { intent_id: "a1", symbol: "AAA", entry_date: "2026-07-01", action_type: "BUY" },
    { intent_id: "b1", symbol: "BBB", entry_date: "2026-07-01", action_type: "BUY" },
    { intent_id: "a2", symbol: "AAA", entry_date: "2026-07-01", action_type: "BUY" },
    { intent_id: "b2", symbol: "BBB", entry_date: "2026-07-01", action_type: "BUY" },
    { intent_id: "a3", symbol: "AAA", entry_date: "2026-07-02", action_type: "BUY" },
  ];
  const deduped = dedupeScorecardRecords(rows);
  assert.equal(deduped.length, 3, "two symbol-days on 07-01, one on 07-02");
  // The later trading day must remain last — evaluateOos walks backwards for
  // recency, so a reordering here would silently corrupt the rolling window.
  assert.equal(deduped[deduped.length - 1].entry_date, "2026-07-02");
  const dates = deduped.map((r) => r.entry_date);
  assert.deepEqual([...dates].sort(), dates, "entry_date must be non-decreasing");
});

test("same symbol on different days stays distinct", () => {
  const rows = [
    { intent_id: "1", symbol: "AAA", entry_date: "2026-07-01", action_type: "BUY" },
    { intent_id: "2", symbol: "AAA", entry_date: "2026-07-02", action_type: "BUY" },
  ];
  assert.equal(dedupeScorecardRecords(rows).length, 2);
});

test("dedupe degrades gracefully on bad input", () => {
  assert.deepEqual(dedupeScorecardRecords(null), []);
  assert.deepEqual(dedupeScorecardRecords(undefined), []);
  assert.deepEqual(dedupeScorecardRecords([]), []);
});

test("scorecardDecisionKey falls back to a per-row key without identity", () => {
  assert.equal(
    scorecardDecisionKey({ symbol: "AAA", entry_date: "2026-07-01" }, 3),
    "decision:AAA|2026-07-01"
  );
  assert.equal(scorecardDecisionKey({ entry_date: "2026-07-01" }, 3), "row:3");
  assert.equal(scorecardDecisionKey({ symbol: "AAA" }, 7), "row:7");
});
