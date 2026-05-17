import test from "node:test";
import assert from "node:assert/strict";

import { buildScoreGatePosteriors } from "../core/scoreGatePosteriors.js";

function buildRecord({ symbol, excess5 = null, signed5 = null, intentId = "x" }) {
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    symbol,
    horizons: {
      "5": {
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
    buildRecord({ symbol: "AAPL", signed5: 0.01, excess5: -0.05, intentId: "1" }),
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
