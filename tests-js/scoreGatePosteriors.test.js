import test from "node:test";
import assert from "node:assert/strict";

import { buildScoreGatePosteriors } from "../core/scoreGatePosteriors.js";

function buildRecord({
  symbol,
  excess5 = null,
  signed5 = null,
  intentId = "x",
  actionType = "BUY",
}) {
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    symbol,
    action_type: actionType,
    horizons: {
      5: {
        signed_return: signed5,
        excess_vs_benchmark: excess5,
      },
    },
  };
}

test("buildScoreGatePosteriors: returns empty when no records", () => {
  const result = buildScoreGatePosteriors({ records: [] });
  assert.deepEqual(result.posteriors, {});
  assert.equal(result.sampleCount, 0);
});

test("buildScoreGatePosteriors: alpha increments on positive excess", () => {
  const records = [
    buildRecord({ symbol: "AAPL", excess5: 0.01, intentId: "1" }),
    buildRecord({ symbol: "AAPL", excess5: 0.02, intentId: "2" }),
  ];
  const result = buildScoreGatePosteriors({ records });
  assert.equal(result.posteriors.AAPL.alpha, 2);
  assert.equal(result.posteriors.AAPL.beta, 0);
  assert.equal(result.posteriors.AAPL.sample_count, 2);
  assert.ok(result.posteriors.AAPL.avg_excess > 0);
});

test("buildScoreGatePosteriors: beta increments on non-positive excess", () => {
  const records = [
    buildRecord({ symbol: "AAPL", excess5: -0.01, intentId: "1" }),
    buildRecord({ symbol: "AAPL", excess5: 0.0, intentId: "2" }),
  ];
  const result = buildScoreGatePosteriors({ records });
  assert.equal(result.posteriors.AAPL.alpha, 0);
  assert.equal(result.posteriors.AAPL.beta, 2);
});

test("buildScoreGatePosteriors: aggregates per symbol independently", () => {
  const records = [
    buildRecord({ symbol: "AAPL", excess5: 0.01, intentId: "1" }),
    buildRecord({ symbol: "MSFT", excess5: -0.02, intentId: "2" }),
    buildRecord({ symbol: "AAPL", excess5: -0.005, intentId: "3" }),
  ];
  const result = buildScoreGatePosteriors({ records });
  assert.equal(result.posteriors.AAPL.alpha, 1);
  assert.equal(result.posteriors.AAPL.beta, 1);
  assert.equal(result.posteriors.MSFT.alpha, 0);
  assert.equal(result.posteriors.MSFT.beta, 1);
});

test("buildScoreGatePosteriors: skips records with null target", () => {
  const records = [
    buildRecord({ symbol: "AAPL", excess5: null, intentId: "1" }),
    buildRecord({ symbol: "AAPL", excess5: 0.01, intentId: "2" }),
  ];
  const result = buildScoreGatePosteriors({ records });
  assert.equal(result.posteriors.AAPL.alpha, 1);
  assert.equal(result.skippedNoTarget, 1);
});

test("buildScoreGatePosteriors: normalizes symbol case", () => {
  const records = [
    buildRecord({ symbol: "aapl", excess5: 0.01, intentId: "1" }),
    buildRecord({ symbol: "AAPL", excess5: 0.01, intentId: "2" }),
  ];
  const result = buildScoreGatePosteriors({ records });
  assert.equal(result.posteriors.AAPL.alpha, 2);
});

test("buildScoreGatePosteriors: honors target=signed_return", () => {
  const records = [
    buildRecord({
      symbol: "AAPL",
      signed5: 0.01,
      excess5: -0.05,
      intentId: "1",
    }),
  ];
  const result = buildScoreGatePosteriors({ records, target: "signed_return" });
  assert.equal(result.posteriors.AAPL.alpha, 1);
  assert.equal(result.posteriors.AAPL.beta, 0);
});

test("buildScoreGatePosteriors: produces idempotent output on repeated calls", () => {
  const records = [
    buildRecord({ symbol: "AAPL", excess5: 0.01, intentId: "1" }),
    buildRecord({ symbol: "AAPL", excess5: -0.01, intentId: "2" }),
  ];
  const r1 = buildScoreGatePosteriors({ records });
  const r2 = buildScoreGatePosteriors({ records });
  assert.deepEqual(r1.posteriors, r2.posteriors);
});

test("buildScoreGatePosteriors: falls back to excess_vs_benchmark on invalid target", () => {
  const records = [
    buildRecord({
      symbol: "AAPL",
      excess5: 0.01,
      signed5: -0.99,
      intentId: "1",
    }),
  ];
  // Invalid target — should fall back to default (excess_vs_benchmark)
  // rather than silently reading undefined and skipping every row.
  const result = buildScoreGatePosteriors({ records, target: "garbage_field" });
  assert.equal(result.diagnostics.target, "excess_vs_benchmark");
  assert.equal(result.posteriors.AAPL.alpha, 1);
  assert.equal(result.posteriors.AAPL.beta, 0);
});

// ----- Regression tests for the debug scan (2026-05-29) -----

function buildTypedRecord({
  symbol,
  actionType = "BUY",
  reasonCode = null,
  excess5,
  intentId = "x",
}) {
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    symbol,
    action_type: actionType,
    reason_code: reasonCode,
    horizons: {
      5: { excess_vs_benchmark: excess5 },
    },
  };
}

test("buildScoreGatePosteriors: counts real BUY rows", () => {
  const records = [
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "BUY",
      excess5: 0.02,
      intentId: "1",
    }),
  ];
  const r = buildScoreGatePosteriors({ records });
  assert.equal(r.posteriors.AAPL.alpha, 1);
  assert.equal(r.skippedNonBuy, 0);
});

test("buildScoreGatePosteriors: counts NO_ACTION rows with BUY_* reason", () => {
  const records = [
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "NO_ACTION",
      reasonCode: "BUY_BLOCKED",
      excess5: -0.01,
      intentId: "1",
    }),
  ];
  const r = buildScoreGatePosteriors({ records });
  assert.equal(r.posteriors.AAPL.beta, 1);
  assert.equal(r.skippedNonBuy, 0);
});

test("buildScoreGatePosteriors: REGRESSION — skips real SELL rows", () => {
  // A SELL row with negative excess_vs_benchmark would, under the old
  // behavior, increment β for that symbol — but SELL outcomes don't tell
  // us anything about whether the BUY gate should fire on this symbol.
  const records = [
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "SELL",
      reasonCode: "UNDER_BUFFER_SELL",
      excess5: -0.05,
      intentId: "1",
    }),
  ];
  const r = buildScoreGatePosteriors({ records });
  assert.deepEqual(r.posteriors, {});
  assert.equal(r.skippedNonBuy, 1);
});

test("buildScoreGatePosteriors: REGRESSION — skips CAP_BREACH_SELL rows", () => {
  const records = [
    buildTypedRecord({
      symbol: "MET",
      actionType: "SELL",
      reasonCode: "CAP_BREACH_SELL",
      excess5: -0.03,
      intentId: "1",
    }),
  ];
  const r = buildScoreGatePosteriors({ records });
  assert.deepEqual(r.posteriors, {});
  assert.equal(r.skippedNonBuy, 1);
});

test("buildScoreGatePosteriors: REGRESSION — skips VOL_STOP rows", () => {
  const records = [
    buildTypedRecord({
      symbol: "MET",
      actionType: "SELL",
      reasonCode: "VOL_STOP",
      excess5: 0.02,
      intentId: "1",
    }),
  ];
  const r = buildScoreGatePosteriors({ records });
  assert.deepEqual(r.posteriors, {});
  assert.equal(r.skippedNonBuy, 1);
});

test("buildScoreGatePosteriors: mixed rows — only BUY-related count", () => {
  const records = [
    // Two BUYs that beat the benchmark
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "BUY",
      excess5: 0.01,
      intentId: "1",
    }),
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "BUY",
      excess5: 0.02,
      intentId: "2",
    }),
    // A BUY_BLOCKED counterfactual that lost
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "NO_ACTION",
      reasonCode: "BUY_BLOCKED",
      excess5: -0.01,
      intentId: "3",
    }),
    // A SELL — should be skipped
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "SELL",
      reasonCode: "CAP_BREACH_SELL",
      excess5: -0.05,
      intentId: "4",
    }),
    // A NO_ACTION with non-BUY reason — should be skipped
    buildTypedRecord({
      symbol: "AAPL",
      actionType: "NO_ACTION",
      reasonCode: "NO_SIGNAL",
      excess5: -0.99,
      intentId: "5",
    }),
  ];
  const r = buildScoreGatePosteriors({ records });
  assert.equal(r.posteriors.AAPL.alpha, 2);
  assert.equal(r.posteriors.AAPL.beta, 1);
  assert.equal(r.skippedNonBuy, 2);
});
