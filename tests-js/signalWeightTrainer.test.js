import test from "node:test";
import assert from "node:assert/strict";

import {
  trainSignalWeights,
  _internals,
} from "../core/signalWeightTrainer.js";

const { pearsonCorrelation, resolveCurrentWeights, WEIGHT_MIN, WEIGHT_MAX } =
  _internals;

function buildRecord({
  momentum,
  vol,
  drawdown,
  signed5,
  signed20 = null,
  intentId = "x",
}) {
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    action_type: "BUY",
    signal_momentum_rank: momentum,
    signal_vol_rank: vol,
    signal_drawdown_rank: drawdown,
    horizons: {
      "5": {
        signed_return: signed5,
      },
      "20": {
        signed_return: signed20,
      },
    },
  };
}

test("pearsonCorrelation returns null on too-small inputs", () => {
  assert.equal(pearsonCorrelation([], []), null);
  assert.equal(pearsonCorrelation([1, 2], [1, 2]), null);
});

test("pearsonCorrelation returns 1 for perfectly correlated series", () => {
  const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(r !== null && Math.abs(r - 1.0) < 1e-9);
});

test("pearsonCorrelation returns -1 for perfectly anti-correlated series", () => {
  const r = pearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
  assert.ok(r !== null && Math.abs(r + 1.0) < 1e-9);
});

test("pearsonCorrelation returns null when one series has zero variance", () => {
  assert.equal(pearsonCorrelation([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

test("resolveCurrentWeights uses defaults when input is missing or invalid", () => {
  const defaults = resolveCurrentWeights(null);
  assert.equal(defaults.momentum, 1.0);
  assert.equal(defaults.vol, 0.4);
  assert.equal(defaults.drawdown, 0.4);

  const partial = resolveCurrentWeights({ momentum: 1.2 });
  assert.equal(partial.momentum, 1.2);
  assert.equal(partial.vol, 0.4); // default
});

test("resolveCurrentWeights clamps out-of-range inputs", () => {
  const clamped = resolveCurrentWeights({
    momentum: 5.0,
    vol: -0.5,
    drawdown: 0.7,
  });
  assert.equal(clamped.momentum, WEIGHT_MAX);
  assert.equal(clamped.vol, WEIGHT_MIN);
  assert.equal(clamped.drawdown, 0.7);
});

test("trainSignalWeights returns insufficient_samples below minSamples", () => {
  const records = Array.from({ length: 5 }, (_, i) =>
    buildRecord({
      momentum: 0.5 + i * 0.1,
      vol: 0.5,
      drawdown: 0.5,
      signed5: 0.01,
      intentId: `r${i}`,
    })
  );
  const result = trainSignalWeights({ records, minSamples: 8 });
  assert.equal(result.updated, false);
  assert.equal(result.reason, "insufficient_samples");
  assert.equal(result.sampleCount, 5);
});

test("trainSignalWeights ignores records missing features or returns", () => {
  const records = [
    buildRecord({ momentum: 0.5, vol: 0.5, drawdown: 0.5, signed5: null }),
    buildRecord({ momentum: null, vol: 0.5, drawdown: 0.5, signed5: 0.01 }),
  ];
  const result = trainSignalWeights({ records, minSamples: 1 });
  assert.equal(result.sampleCount, 0);
  assert.equal(result.reason, "insufficient_samples");
  assert.equal(result.diagnostics.skippedMissingFeature, 1);
  assert.equal(result.diagnostics.skippedMissingReturn, 1);
});

test("trainSignalWeights raises weight when feature positively correlates with return", () => {
  // Construct momentum perfectly correlated with signed_return.
  // vol and drawdown held constant (no signal).
  const records = Array.from({ length: 10 }, (_, i) => {
    const m = 0.1 + i * 0.1; // 0.1..1.0
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 0.02, // strong positive correlation
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.1,
  });
  assert.equal(result.updated, true);
  assert.equal(result.reason, "weights_updated");
  assert.ok(
    result.newWeights.momentum > result.oldWeights.momentum,
    "momentum weight should increase given positive correlation"
  );
  // Vol/drawdown had zero variance → null correlation, weights unchanged.
  assert.equal(result.newWeights.vol, result.oldWeights.vol);
  assert.equal(result.newWeights.drawdown, result.oldWeights.drawdown);
});

test("trainSignalWeights lowers weight when feature negatively correlates with return", () => {
  const records = Array.from({ length: 10 }, (_, i) => {
    const v = 0.1 + i * 0.1;
    return buildRecord({
      momentum: 0.5,
      vol: v,
      drawdown: 0.5,
      signed5: -v * 0.02, // strong negative correlation
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.1,
  });
  assert.equal(result.updated, true);
  assert.ok(
    result.newWeights.vol < result.oldWeights.vol,
    "vol weight should decrease given negative correlation"
  );
});

test("trainSignalWeights clamps weights at boundaries", () => {
  // Starting at max, positive correlation should not push beyond.
  const records = Array.from({ length: 10 }, (_, i) => {
    const m = 0.1 + i * 0.1;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 0.1,
      intentId: `r${i}`,
    });
  });
  const atMax = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: WEIGHT_MAX, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.5,
  });
  // Either no update (clamped) or stays at max
  assert.ok(atMax.newWeights.momentum <= WEIGHT_MAX);
});

test("trainSignalWeights respects minCorrelation threshold", () => {
  // Build records with strong correlation; set minCorrelation above 1.0
  // (which |r| can never reach), so the parameter alone blocks any update.
  const records = Array.from({ length: 10 }, (_, i) => {
    const m = 0.1 + i * 0.1;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    minSamples: 8,
    minCorrelation: 1.01,
  });
  assert.equal(result.updated, false);
  assert.equal(result.reason, "no_significant_correlation");
  // Correlation was computed, just rejected as below threshold.
  assert.ok(result.correlations !== null);
});
