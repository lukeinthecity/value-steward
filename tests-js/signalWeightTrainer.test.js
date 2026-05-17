import test from "node:test";
import assert from "node:assert/strict";

import {
  trainSignalWeights,
  trainSignalWeightsByRegime,
  _internals,
} from "../core/signalWeightTrainer.js";

const {
  pearsonCorrelation,
  invert3x3,
  ridgeOls3,
  resolveCurrentWeights,
  WEIGHT_MIN,
  WEIGHT_MAX,
} = _internals;

function buildRecord({
  momentum,
  vol,
  drawdown,
  signed5,
  signed20 = null,
  excess5 = null,
  excess20 = null,
  intentId = "x",
}) {
  // When excess is not provided, mirror signed (back-compat).
  const e5 = excess5 === null ? signed5 : excess5;
  const e20 = excess20 === null ? signed20 : excess20;
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    action_type: "BUY",
    signal_momentum_rank: momentum,
    signal_vol_rank: vol,
    signal_drawdown_rank: drawdown,
    horizons: {
      "5": { signed_return: signed5, excess_vs_benchmark: e5 },
      "20": { signed_return: signed20, excess_vs_benchmark: e20 },
    },
  };
}

test("pearsonCorrelation: null on small inputs and zero variance", () => {
  assert.equal(pearsonCorrelation([], []), null);
  assert.equal(pearsonCorrelation([1, 2], [1, 2]), null);
  assert.equal(pearsonCorrelation([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

test("pearsonCorrelation: perfect and anti-correlation", () => {
  const r1 = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(r1 !== null && Math.abs(r1 - 1.0) < 1e-9);
  const r2 = pearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
  assert.ok(r2 !== null && Math.abs(r2 + 1.0) < 1e-9);
});

test("invert3x3: identity matrix", () => {
  const I = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const inv = invert3x3(I);
  assert.ok(inv !== null);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      assert.ok(Math.abs(inv[i][j] - (i === j ? 1 : 0)) < 1e-12);
    }
  }
});

test("invert3x3: known matrix inverse", () => {
  // A * A^-1 = I check
  const A = [
    [2, 1, 0],
    [1, 2, 1],
    [0, 1, 2],
  ];
  const inv = invert3x3(A);
  assert.ok(inv !== null);
  // Multiply A * inv and check it's identity (within tolerance)
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += A[i][k] * inv[k][j];
      const expected = i === j ? 1 : 0;
      assert.ok(Math.abs(sum - expected) < 1e-10, `i=${i},j=${j}: got ${sum}`);
    }
  }
});

test("invert3x3: singular matrix returns null", () => {
  // All rows identical → determinant = 0
  const singular = [
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
  ];
  assert.equal(invert3x3(singular), null);
});

test("ridgeOls3: recovers known coefficients on clean data", () => {
  // Build y = 0.5 * x1 + 0.0 * x2 - 0.3 * x3 with no noise.
  const x1 = [];
  const x2 = [];
  const x3 = [];
  const y = [];
  for (let i = 0; i < 30; i += 1) {
    const a = Math.random();
    const b = Math.random();
    const c = Math.random();
    x1.push(a);
    x2.push(b);
    x3.push(c);
    y.push(0.5 * a + 0.0 * b - 0.3 * c);
  }
  const result = ridgeOls3([x1, x2, x3], y, 0.001);
  assert.ok(result !== null);
  const { coef } = result;
  // With small lambda and clean data, coefficients should be close to truth.
  assert.ok(Math.abs(coef[0] - 0.5) < 0.05, `c1=${coef[0]}`);
  assert.ok(Math.abs(coef[1] - 0.0) < 0.05, `c2=${coef[1]}`);
  assert.ok(Math.abs(coef[2] + 0.3) < 0.05, `c3=${coef[2]}`);
  // With near-zero residuals the t-stats should be very large (or finite).
  result.tStats.forEach((t) => assert.ok(t === null || Number.isFinite(t)));
});

test("ridgeOls3: returns null on singular X^T X (constant features)", () => {
  // All features constant → X^T X singular even with very small lambda.
  // But with lambda > 0, ridge always succeeds. With lambda = 0, fails.
  const constant = Array.from({ length: 10 }, () => 0.5);
  const y = Array.from({ length: 10 }, (_, i) => i * 0.01);
  const result = ridgeOls3([constant, constant, constant], y, 0);
  assert.equal(result, null);
});

test("ridgeOls3: lambda > 0 stabilizes constant features (no null)", () => {
  const constant = Array.from({ length: 10 }, () => 0.5);
  const y = Array.from({ length: 10 }, (_, i) => i * 0.01);
  const result = ridgeOls3([constant, constant, constant], y, 0.01);
  assert.ok(result !== null);
  // Coefficients will be small (regularization dominates) but finite.
  result.coef.forEach((c) => assert.ok(Number.isFinite(c)));
});

test("ridgeOls3: t-stats are large on strong signal, near zero on noise", () => {
  // x1 strongly correlated with y; x2 and x3 are pure noise.
  const x1 = [];
  const x2 = [];
  const x3 = [];
  const y = [];
  // Use a deterministic pseudo-random to avoid flaky tests.
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < 50; i += 1) {
    const v1 = rand();
    x1.push(v1);
    x2.push(rand());
    x3.push(rand());
    // Strong linear relationship with x1; small noise.
    y.push(0.5 * v1 + (rand() - 0.5) * 0.001);
  }
  const result = ridgeOls3([x1, x2, x3], y, 0.001);
  assert.ok(result !== null);
  // x1's t-stat should be far above 2 (statistically significant); the
  // noise features should be much weaker.
  assert.ok(Math.abs(result.tStats[0]) > 5, `x1 t=${result.tStats[0]}`);
  assert.ok(
    Math.abs(result.tStats[1]) < Math.abs(result.tStats[0]),
    `x2 t=${result.tStats[1]} not weaker than x1`
  );
});

test("resolveCurrentWeights: defaults and clamping", () => {
  const defaults = resolveCurrentWeights(null);
  assert.equal(defaults.momentum, 1.0);
  assert.equal(defaults.vol, 0.4);
  assert.equal(defaults.drawdown, 0.4);

  const clamped = resolveCurrentWeights({
    momentum: 5.0,
    vol: -0.5,
    drawdown: 0.7,
  });
  assert.equal(clamped.momentum, WEIGHT_MAX);
  assert.equal(clamped.vol, WEIGHT_MIN);
  assert.equal(clamped.drawdown, 0.7);
});

test("trainSignalWeights: insufficient_samples below minSamples", () => {
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

test("trainSignalWeights: filters records missing features or returns", () => {
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

test("trainSignalWeights: positive OLS coefficient raises corresponding weight", () => {
  // Strongly positive relationship between momentum and excess return.
  // Other features have noise so their coefficients should be near zero.
  const records = Array.from({ length: 12 }, (_, i) => {
    const m = 0.1 + i * 0.075;
    return buildRecord({
      momentum: m,
      vol: 0.5 + (Math.random() - 0.5) * 0.1,
      drawdown: 0.5 + (Math.random() - 0.5) * 0.1,
      signed5: m * 0.02,
      excess5: m * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.05,
  });
  assert.equal(result.updated, true);
  assert.equal(result.reason, "weights_updated");
  assert.ok(result.coefficients !== null);
  assert.ok(result.coefficients.momentum > 0);
  assert.ok(
    result.newWeights.momentum > result.oldWeights.momentum,
    "momentum should increase given positive OLS coefficient"
  );
});

test("trainSignalWeights: negative OLS coefficient lowers corresponding weight", () => {
  // Negative relationship: as vol_rank rises, alpha falls.
  const records = Array.from({ length: 12 }, (_, i) => {
    const v = 0.1 + i * 0.075;
    return buildRecord({
      momentum: 0.5 + (Math.random() - 0.5) * 0.1,
      vol: v,
      drawdown: 0.5 + (Math.random() - 0.5) * 0.1,
      signed5: -v * 0.02,
      excess5: -v * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.05,
  });
  assert.equal(result.updated, true);
  assert.ok(result.coefficients.vol < 0);
  assert.ok(
    result.newWeights.vol < result.oldWeights.vol,
    "vol should decrease given negative OLS coefficient"
  );
});

test("trainSignalWeights: stepSize caps maximum delta on any weight", () => {
  // Huge target magnitude — without step cap, weights would saturate.
  const records = Array.from({ length: 20 }, (_, i) => {
    const m = i / 20;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 100,
      excess5: m * 100,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.05,
  });
  assert.equal(result.updated, true);
  // Largest possible delta on any weight = stepSize * 1 (normalized coef in [-1,1])
  for (const key of ["momentum", "vol", "drawdown"]) {
    const delta = Math.abs(result.newWeights[key] - result.oldWeights[key]);
    assert.ok(
      delta <= 0.05 + 1e-9,
      `${key} delta=${delta} exceeded stepSize=0.05`
    );
  }
});

test("trainSignalWeights: clamps weights at [0.1, 2.0] boundaries", () => {
  const records = Array.from({ length: 12 }, (_, i) => {
    const m = i / 12;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 10,
      excess5: m * 10,
      intentId: `r${i}`,
    });
  });
  const atMax = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: WEIGHT_MAX, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.5,
  });
  assert.ok(atMax.newWeights.momentum <= WEIGHT_MAX);
  assert.ok(atMax.newWeights.vol >= WEIGHT_MIN);
  assert.ok(atMax.newWeights.drawdown >= WEIGHT_MIN);
});

test("trainSignalWeights: default target is excess_vs_benchmark (alpha)", () => {
  // signed_return and excess_vs_benchmark disagree on sign.
  const records = Array.from({ length: 12 }, (_, i) => {
    const m = 0.1 + i * 0.075;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 0.02,
      excess5: -m * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.05,
  });
  assert.equal(result.diagnostics.target, "excess_vs_benchmark");
  // Excess coefficient is negative → momentum weight DECREASES.
  assert.ok(
    result.newWeights.momentum < result.oldWeights.momentum,
    `momentum should decrease (got ${result.newWeights.momentum} vs ${result.oldWeights.momentum})`
  );
});

test("trainSignalWeights: honors target=signed_return override", () => {
  const records = Array.from({ length: 12 }, (_, i) => {
    const m = 0.1 + i * 0.075;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 0.02,
      excess5: -m * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 8,
    stepSize: 0.05,
    target: "signed_return",
  });
  assert.equal(result.diagnostics.target, "signed_return");
  // Signed coefficient is positive → momentum weight INCREASES.
  assert.ok(
    result.newWeights.momentum > result.oldWeights.momentum,
    "momentum should increase when signed_return target gives positive coef"
  );
});

test("trainSignalWeights: minMagnitude threshold blocks tiny updates", () => {
  const records = Array.from({ length: 12 }, (_, i) => {
    const m = 0.1 + i * 0.075;
    return buildRecord({
      momentum: m,
      vol: 0.5,
      drawdown: 0.5,
      signed5: m * 0.02,
      excess5: m * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    minSamples: 8,
    minMagnitude: 100.0, // impossible threshold
  });
  assert.equal(result.updated, false);
  assert.equal(result.reason, "no_significant_signal");
  assert.ok(result.coefficients !== null);
  assert.equal(result.diagnostics.maxAbsCoefficient !== undefined, true);
});

function buildRegimeRecord({
  regime,
  momentum,
  vol,
  drawdown,
  excess5,
  intentId,
}) {
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    action_type: "BUY",
    world_macro_label: regime,
    signal_momentum_rank: momentum,
    signal_vol_rank: vol,
    signal_drawdown_rank: drawdown,
    horizons: {
      "5": { signed_return: excess5, excess_vs_benchmark: excess5 },
    },
  };
}

test("trainSignalWeightsByRegime: groups records by regime and trains independently", () => {
  // calm: momentum positively predicts alpha
  // watchful: momentum negatively predicts alpha (markets favor defensive)
  const records = [];
  for (let i = 0; i < 12; i += 1) {
    const m = 0.1 + i * 0.075;
    records.push(
      buildRegimeRecord({
        regime: "calm",
        momentum: m,
        vol: 0.5,
        drawdown: 0.5,
        excess5: m * 0.02,
        intentId: `calm-${i}`,
      })
    );
    records.push(
      buildRegimeRecord({
        regime: "watchful",
        momentum: m,
        vol: 0.5,
        drawdown: 0.5,
        excess5: -m * 0.02,
        intentId: `watchful-${i}`,
      })
    );
  }
  const result = trainSignalWeightsByRegime({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    trainerOptions: { minSamples: 8, stepSize: 0.05 },
  });
  assert.ok(result.anyUpdated);
  assert.equal(result.regimeOrder.includes("calm"), true);
  assert.equal(result.regimeOrder.includes("watchful"), true);
  // calm: momentum should INCREASE (positive coef)
  assert.ok(result.byRegime.calm.newWeights.momentum > result.byRegime.calm.oldWeights.momentum);
  // watchful: momentum should DECREASE (negative coef)
  assert.ok(result.byRegime.watchful.newWeights.momentum < result.byRegime.watchful.oldWeights.momentum);
});

test("trainSignalWeightsByRegime: skips regimes below minSamples", () => {
  const records = [
    buildRegimeRecord({
      regime: "calm",
      momentum: 0.5, vol: 0.5, drawdown: 0.5,
      excess5: 0.01, intentId: "1",
    }),
  ];
  const result = trainSignalWeightsByRegime({
    records,
    trainerOptions: { minSamples: 8 },
  });
  // Calm regime has only 1 record → trained but returns insufficient_samples.
  assert.equal(result.byRegime.calm?.reason, "insufficient_samples");
  assert.equal(result.anyUpdated, false);
});

test("trainSignalWeightsByRegime: uses existing regime weights as starting point", () => {
  const records = Array.from({ length: 10 }, (_, i) =>
    buildRegimeRecord({
      regime: "calm",
      momentum: 0.1 + i * 0.075,
      vol: 0.5,
      drawdown: 0.5,
      excess5: (0.1 + i * 0.075) * 0.02,
      intentId: `r${i}`,
    })
  );
  const result = trainSignalWeightsByRegime({
    records,
    currentSignalWeights: {
      momentum: 1.0,
      vol: 0.4,
      drawdown: 0.4,
      by_regime: {
        calm: { momentum: 1.5, vol: 0.3, drawdown: 0.3 },
      },
    },
    trainerOptions: { minSamples: 8, stepSize: 0.05 },
  });
  // The calm-specific old weight (1.5) should be the baseline, not the
  // global momentum=1.0.
  assert.equal(result.byRegime.calm.oldWeights.momentum, 1.5);
});

test("trainSignalWeightsByRegime: respects the regimes whitelist parameter", () => {
  const records = [
    ...Array.from({ length: 10 }, (_, i) =>
      buildRegimeRecord({
        regime: "calm",
        momentum: 0.1 + i * 0.075,
        vol: 0.5,
        drawdown: 0.5,
        excess5: 0.01,
        intentId: `c${i}`,
      })
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      buildRegimeRecord({
        regime: "stressed",
        momentum: 0.1 + i * 0.075,
        vol: 0.5,
        drawdown: 0.5,
        excess5: 0.01,
        intentId: `s${i}`,
      })
    ),
  ];
  const result = trainSignalWeightsByRegime({
    records,
    regimes: ["calm"],
    trainerOptions: { minSamples: 8 },
  });
  assert.ok("calm" in result.byRegime);
  assert.ok(!("stressed" in result.byRegime));
});

test("trainSignalWeights: minTStat blocks weight updates on insignificant signal", () => {
  // Pure noise — no true relationship. With minTStat default 2.0, no
  // feature's coefficient should clear the bar, so no weights should update.
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const records = Array.from({ length: 30 }, (_, i) =>
    buildRecord({
      momentum: rand(),
      vol: rand(),
      drawdown: rand(),
      signed5: (rand() - 0.5) * 0.001, // pure noise target
      excess5: (rand() - 0.5) * 0.001,
      intentId: `r${i}`,
    })
  );
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 20,
    minTStat: 2.0,
    stepSize: 0.05,
  });
  // Should NOT update — t-stats are tiny.
  assert.equal(result.updated, false);
  assert.ok(
    result.reason === "no_significant_t_stat" ||
      result.reason === "no_significant_signal",
    `unexpected reason ${result.reason}`
  );
  assert.ok(result.tStats !== null);
});

test("trainSignalWeights: minTStat=0 disables significance gating", () => {
  // Same noise data — with gating disabled, the trainer happily nudges
  // weights. This confirms the gate is what's blocking the update above.
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const records = Array.from({ length: 30 }, (_, i) =>
    buildRecord({
      momentum: rand(),
      vol: rand(),
      drawdown: rand(),
      signed5: (rand() - 0.5) * 0.001,
      excess5: (rand() - 0.5) * 0.001,
      intentId: `r${i}`,
    })
  );
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 20,
    minTStat: 0,
    stepSize: 0.05,
  });
  // With gating off, SOME weight should move (even if direction is noise).
  assert.equal(result.updated, true);
});

test("trainSignalWeights: high t-stat feature still updates when others don't", () => {
  // x1 has real signal; x2 and x3 are noise. With minTStat=2.0, only x1
  // should clear the gate, and only the momentum weight should change.
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const records = Array.from({ length: 50 }, (_, i) => {
    const m = 0.1 + i * 0.018;
    return buildRecord({
      momentum: m,
      vol: rand(),
      drawdown: rand(),
      signed5: m * 0.05 + (rand() - 0.5) * 0.001,
      excess5: m * 0.05 + (rand() - 0.5) * 0.001,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    currentSignalWeights: { momentum: 1.0, vol: 0.4, drawdown: 0.4 },
    minSamples: 20,
    minTStat: 2.0,
    stepSize: 0.05,
  });
  assert.equal(result.updated, true);
  // Momentum should have moved; vol and drawdown should remain unchanged
  // (their t-stats failed the gate).
  assert.notEqual(result.newWeights.momentum, result.oldWeights.momentum);
});

test("trainSignalWeights: result includes Pearson correlations as diagnostics", () => {
  const records = Array.from({ length: 12 }, (_, i) => {
    const m = 0.1 + i * 0.075;
    return buildRecord({
      momentum: m,
      vol: 0.5 + (Math.random() - 0.5) * 0.1,
      drawdown: 0.5 + (Math.random() - 0.5) * 0.1,
      signed5: m * 0.02,
      excess5: m * 0.02,
      intentId: `r${i}`,
    });
  });
  const result = trainSignalWeights({
    records,
    minSamples: 8,
    stepSize: 0.05,
  });
  assert.ok(result.correlations !== null);
  assert.ok(typeof result.correlations.momentum === "number");
  // Momentum strongly correlated with target → r close to 1.
  assert.ok(result.correlations.momentum > 0.9);
});
