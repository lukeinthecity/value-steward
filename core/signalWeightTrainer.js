/**
 * Signal weight trainer.
 *
 * Implements Ridge-regularized OLS regression of forward alpha against the
 * three component signal features (momentum_rank, vol_rank, drawdown_rank).
 *
 *   excess_vs_benchmark_5d  ~  c_mom * momentum_rank
 *                            + c_vol * vol_rank
 *                            + c_dd  * drawdown_rank
 *
 *   coef = (X^T X + lambda * I)^-1 X^T y
 *
 * The OLS coefficients are normalized by their largest absolute value to
 * produce a bounded direction vector. Each weight is then nudged by
 * `stepSize * normalized_coef[i]` per cycle, clamped to [0.1, 2.0].
 *
 * Why Ridge: with N=10-50 samples and three correlated rank features,
 * unregularized OLS produces wildly oscillating coefficients. A small
 * ridge term (lambda=0.01 by default) stabilizes the inversion without
 * meaningfully biasing the direction.
 *
 * Target choice: excess_vs_benchmark isolates alpha (did we beat SPY?)
 * from market beta. Using raw signed_return would mostly correlate with
 * whether the market went up. The scorecard trainer (which adjusts
 * risk_level) uses the same target — this keeps the learning signal
 * consistent across both trainers. Override with VS_SIGNAL_WEIGHT_TARGET
 * if you need raw return.
 *
 * Diagnostics also include per-feature Pearson correlations so operators
 * can sanity-check what the regression is responding to.
 */

const VALID_TARGETS = new Set(["excess_vs_benchmark", "signed_return"]);

const FEATURES = [
  { policyKey: "momentum", scorecardKey: "signal_momentum_rank" },
  { policyKey: "vol", scorecardKey: "signal_vol_rank" },
  { policyKey: "drawdown", scorecardKey: "signal_drawdown_rank" },
];

const DEFAULT_BASE_WEIGHTS = {
  momentum: 1.0,
  vol: 0.4,
  drawdown: 0.4,
};

const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 2.0;
const DEFAULT_RIDGE_LAMBDA = 0.01;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function pearsonCorrelation(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return null;
  return num / denom;
}

/**
 * Invert a 3x3 matrix via the cofactor formula. Returns null if the
 * determinant is below `epsilon` (singular or nearly singular).
 */
function invert3x3(m, epsilon = 1e-12) {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < epsilon) return null;
  const invDet = 1 / det;
  return [
    [(e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [(f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
  ];
}

function matVecMul3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Ridge OLS for 3-feature regression with significance diagnostics.
 *
 * Returns ``{ coef, tStats, residualVariance, inv, sampleCount }`` or null
 * if the (X^T X + lambda*I) matrix could not be inverted.
 *
 * Standard errors and t-statistics use the classical OLS formula:
 *   sigma² = RSS / (n - p)
 *   Var(coef) = sigma² * (X^T X + lambda*I)^-1
 *   t[i] = coef[i] / sqrt(Var(coef)[i][i])
 *
 * t-stats let the caller decide which coefficients are statistically
 * distinguishable from zero before nudging weights — important defense
 * against overfitting at small N (rule of thumb: |t| > 2 ~ p < 0.05).
 */
function ridgeOls3(featureColumns, targets, lambda) {
  const n = targets.length;
  if (n < 4) return null; // need at least n > p=3 for residual variance
  // Compute X^T X (symmetric 3x3) and X^T y (3-vector)
  const xtx = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const xty = [0, 0, 0];
  for (let row = 0; row < n; row += 1) {
    const x0 = featureColumns[0][row];
    const x1 = featureColumns[1][row];
    const x2 = featureColumns[2][row];
    const y = targets[row];
    xtx[0][0] += x0 * x0;
    xtx[0][1] += x0 * x1;
    xtx[0][2] += x0 * x2;
    xtx[1][1] += x1 * x1;
    xtx[1][2] += x1 * x2;
    xtx[2][2] += x2 * x2;
    xty[0] += x0 * y;
    xty[1] += x1 * y;
    xty[2] += x2 * y;
  }
  xtx[1][0] = xtx[0][1];
  xtx[2][0] = xtx[0][2];
  xtx[2][1] = xtx[1][2];

  // Add ridge term: (X^T X + lambda * I)
  xtx[0][0] += lambda;
  xtx[1][1] += lambda;
  xtx[2][2] += lambda;

  const inv = invert3x3(xtx);
  if (!inv) return null;
  const coef = matVecMul3(inv, xty);

  // Residual sum of squares for standard error / t-stat estimation.
  let rss = 0;
  for (let row = 0; row < n; row += 1) {
    const pred =
      coef[0] * featureColumns[0][row] +
      coef[1] * featureColumns[1][row] +
      coef[2] * featureColumns[2][row];
    const r = targets[row] - pred;
    rss += r * r;
  }
  const degreesOfFreedom = Math.max(1, n - 3);
  const residualVariance = rss / degreesOfFreedom;

  // se(coef_i) = sqrt(sigma² * inv[i][i]) — diagonal of variance matrix.
  const tStats = [];
  for (let i = 0; i < 3; i += 1) {
    const variance = residualVariance * inv[i][i];
    if (!Number.isFinite(variance) || variance <= 0) {
      tStats.push(null);
      continue;
    }
    const se = Math.sqrt(variance);
    tStats.push(coef[i] / se);
  }

  return {
    coef,
    tStats,
    residualVariance,
    inv,
    sampleCount: n,
  };
}

function extractSamples(records, horizon, targetKey) {
  const key = String(horizon);
  const featureColumns = FEATURES.map(() => []);
  const targets = [];
  let skippedMissingFeature = 0;
  let skippedMissingReturn = 0;

  for (const record of records) {
    const horizonData = record?.horizons?.[key];
    const targetValue = horizonData?.[targetKey];
    if (!isFiniteNumber(targetValue)) {
      skippedMissingReturn += 1;
      continue;
    }
    const featureValues = FEATURES.map((f) => record?.[f.scorecardKey]);
    if (!featureValues.every(isFiniteNumber)) {
      skippedMissingFeature += 1;
      continue;
    }
    featureValues.forEach((v, i) => featureColumns[i].push(v));
    targets.push(targetValue);
  }

  return {
    featureColumns,
    targets,
    sampleCount: targets.length,
    skippedMissingFeature,
    skippedMissingReturn,
  };
}

function resolveCurrentWeights(currentSignalWeights) {
  const result = { ...DEFAULT_BASE_WEIGHTS };
  if (!currentSignalWeights || typeof currentSignalWeights !== "object") {
    return result;
  }
  for (const { policyKey } of FEATURES) {
    const value = currentSignalWeights[policyKey];
    if (isFiniteNumber(value)) {
      result[policyKey] = clamp(value, WEIGHT_MIN, WEIGHT_MAX);
    }
  }
  return result;
}

function buildDiagnostics({
  horizon,
  minSamples,
  resolvedTarget,
  lambda,
  skippedMissingFeature,
  skippedMissingReturn,
  extras = {},
}) {
  return {
    horizon,
    minSamples,
    target: resolvedTarget,
    ridgeLambda: lambda,
    skippedMissingFeature,
    skippedMissingReturn,
    ...extras,
  };
}

/**
 * Train signal weights from a scorecard slice using Ridge OLS with
 * per-feature t-statistic gating.
 *
 * @param {object} args
 * @param {Array} args.records - Scorecard records (may include null horizons).
 * @param {object|null} args.currentSignalWeights - Current weights map
 *   ({ momentum, vol, drawdown }). Defaults applied if missing.
 * @param {number} args.horizon - Forward-return horizon in trading days (default 5).
 * @param {number} args.stepSize - Cap on per-cycle weight delta in either
 *   direction (default 0.05). Coefficients are normalized to [-1,1] first,
 *   so the largest move on any single weight is exactly stepSize.
 * @param {number} args.minSamples - Minimum samples required (default 8).
 * @param {number} args.minMagnitude - Skip updates when the largest normalized
 *   coefficient is below this absolute value (default 1e-6).
 * @param {number} args.minTStat - Per-feature t-stat magnitude required to
 *   apply an update on that feature (default 2.0, ~p < 0.05). Set to 0 to
 *   disable significance gating.
 * @param {number} args.ridgeLambda - Ridge regularization strength (default 0.01).
 * @param {string} args.target - "excess_vs_benchmark" (default) or "signed_return".
 * @returns {object} { updated, reason, oldWeights, newWeights, coefficients,
 *   normalizedCoefficients, tStats, correlations, sampleCount, diagnostics }
 */
export function trainSignalWeights({
  records,
  currentSignalWeights = null,
  horizon = 5,
  stepSize = 0.05,
  minSamples = 8,
  minMagnitude = 1e-6,
  minTStat = 2.0,
  ridgeLambda = DEFAULT_RIDGE_LAMBDA,
  target = "excess_vs_benchmark",
} = {}) {
  const oldWeights = resolveCurrentWeights(currentSignalWeights);
  const resolvedTarget = VALID_TARGETS.has(target) ? target : "excess_vs_benchmark";
  const lambda = isFiniteNumber(ridgeLambda) && ridgeLambda >= 0
    ? ridgeLambda
    : DEFAULT_RIDGE_LAMBDA;

  if (!Array.isArray(records) || records.length === 0) {
    return {
      updated: false,
      reason: "no_records",
      oldWeights,
      newWeights: oldWeights,
      coefficients: null,
      normalizedCoefficients: null,
      tStats: null,
      correlations: null,
      sampleCount: 0,
      diagnostics: buildDiagnostics({
        horizon,
        minSamples,
        resolvedTarget,
        lambda,
        skippedMissingFeature: 0,
        skippedMissingReturn: 0,
      }),
    };
  }

  const {
    featureColumns,
    targets,
    sampleCount,
    skippedMissingFeature,
    skippedMissingReturn,
  } = extractSamples(records, horizon, resolvedTarget);

  if (sampleCount < minSamples) {
    return {
      updated: false,
      reason: "insufficient_samples",
      oldWeights,
      newWeights: oldWeights,
      coefficients: null,
      normalizedCoefficients: null,
      tStats: null,
      correlations: null,
      sampleCount,
      diagnostics: buildDiagnostics({
        horizon,
        minSamples,
        resolvedTarget,
        lambda,
        skippedMissingFeature,
        skippedMissingReturn,
      }),
    };
  }

  // Per-feature Pearson correlations for diagnostics only — the actual
  // update direction comes from joint Ridge OLS below.
  const correlations = {};
  FEATURES.forEach(({ policyKey }, idx) => {
    correlations[policyKey] = pearsonCorrelation(featureColumns[idx], targets);
  });

  const olsResult = ridgeOls3(featureColumns, targets, lambda);
  if (!olsResult) {
    return {
      updated: false,
      reason: "singular_matrix",
      oldWeights,
      newWeights: oldWeights,
      coefficients: null,
      normalizedCoefficients: null,
      tStats: null,
      correlations,
      sampleCount,
      diagnostics: buildDiagnostics({
        horizon,
        minSamples,
        resolvedTarget,
        lambda,
        skippedMissingFeature,
        skippedMissingReturn,
      }),
    };
  }
  const coefArray = olsResult.coef;
  const tStatArray = olsResult.tStats;

  const coefficients = {};
  const tStats = {};
  FEATURES.forEach(({ policyKey }, idx) => {
    coefficients[policyKey] = coefArray[idx];
    tStats[policyKey] = tStatArray[idx];
  });

  const maxAbs = Math.max(...coefArray.map((c) => Math.abs(c)));
  if (!Number.isFinite(maxAbs) || maxAbs < minMagnitude) {
    return {
      updated: false,
      reason: "no_significant_signal",
      oldWeights,
      newWeights: oldWeights,
      coefficients,
      normalizedCoefficients: null,
      tStats,
      correlations,
      sampleCount,
      diagnostics: buildDiagnostics({
        horizon,
        minSamples,
        resolvedTarget,
        lambda,
        skippedMissingFeature,
        skippedMissingReturn,
        extras: { maxAbsCoefficient: maxAbs },
      }),
    };
  }

  const normalized = coefArray.map((c) => c / maxAbs);
  const normalizedCoefficients = {};
  FEATURES.forEach(({ policyKey }, idx) => {
    normalizedCoefficients[policyKey] = normalized[idx];
  });

  // Per-feature significance gating: skip a feature's update when its
  // OLS t-statistic is below `minTStat`. Prevents drifting on noise.
  const skippedTStat = {};
  const newWeights = { ...oldWeights };
  let anyUpdate = false;
  FEATURES.forEach(({ policyKey }, idx) => {
    const t = tStatArray[idx];
    const significant =
      minTStat <= 0 ||
      (typeof t === "number" && Number.isFinite(t) && Math.abs(t) >= minTStat);
    if (!significant) {
      skippedTStat[policyKey] = t;
      return;
    }
    const delta = stepSize * normalized[idx];
    const updated = clamp(oldWeights[policyKey] + delta, WEIGHT_MIN, WEIGHT_MAX);
    if (updated !== oldWeights[policyKey]) {
      newWeights[policyKey] = updated;
      anyUpdate = true;
    }
  });

  if (!anyUpdate) {
    const reason =
      Object.keys(skippedTStat).length === FEATURES.length
        ? "no_significant_t_stat"
        : "clamped_no_change";
    return {
      updated: false,
      reason,
      oldWeights,
      newWeights: oldWeights,
      coefficients,
      normalizedCoefficients,
      tStats,
      correlations,
      sampleCount,
      diagnostics: buildDiagnostics({
        horizon,
        minSamples,
        resolvedTarget,
        lambda,
        skippedMissingFeature,
        skippedMissingReturn,
        extras: { minTStat, skippedTStat },
      }),
    };
  }

  return {
    updated: true,
    reason: "weights_updated",
    oldWeights,
    newWeights,
    coefficients,
    normalizedCoefficients,
    tStats,
    correlations,
    sampleCount,
    diagnostics: buildDiagnostics({
      horizon,
      minSamples,
      resolvedTarget,
      lambda,
      skippedMissingFeature,
      skippedMissingReturn,
    }),
  };
}

function groupRecordsByRegime(records) {
  const groups = {};
  for (const record of records) {
    const label = record?.world_macro_label;
    if (typeof label !== "string" || label.trim() === "") continue;
    const key = label.trim();
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }
  return groups;
}

/**
 * Run Ridge OLS weight training independently for each macro regime.
 *
 * For each regime present in ``records`` with at least ``minSamples`` rows,
 * call ``trainSignalWeights`` using that regime's current weights as the
 * starting point (falling back to the base weights when the regime has no
 * entry yet). Regimes without enough data are skipped silently.
 *
 * @param {object} args
 * @param {Array} args.records - Scorecard records.
 * @param {object|null} args.currentSignalWeights - Full signal_weights block
 *   from policy.json: { momentum, vol, drawdown, by_regime: {...} }.
 * @param {Array<string>} args.regimes - Whitelist of regime labels to train
 *   (default: every regime present in records).
 * @param {object} args.trainerOptions - Forwarded to trainSignalWeights
 *   (horizon, stepSize, minSamples, ridgeLambda, target).
 * @returns {object} { byRegime, regimeSampleCounts, regimeOrder, anyUpdated }
 */
export function trainSignalWeightsByRegime({
  records,
  currentSignalWeights = null,
  regimes = null,
  trainerOptions = {},
} = {}) {
  const groups = groupRecordsByRegime(records || []);
  const baseWeights = resolveCurrentWeights(currentSignalWeights);
  const byRegimeMap =
    currentSignalWeights && typeof currentSignalWeights.by_regime === "object"
      ? currentSignalWeights.by_regime
      : {};
  const allowedRegimes = Array.isArray(regimes) && regimes.length
    ? new Set(regimes.map((r) => r.trim()).filter(Boolean))
    : null;

  const byRegime = {};
  const regimeSampleCounts = {};
  let anyUpdated = false;
  const regimeOrder = Object.keys(groups).sort();

  for (const regime of regimeOrder) {
    if (allowedRegimes && !allowedRegimes.has(regime)) continue;
    const regimeRecords = groups[regime];
    const regimeCurrent =
      byRegimeMap && typeof byRegimeMap[regime] === "object"
        ? { ...baseWeights, ...byRegimeMap[regime] }
        : baseWeights;
    const result = trainSignalWeights({
      ...trainerOptions,
      records: regimeRecords,
      currentSignalWeights: regimeCurrent,
    });
    byRegime[regime] = result;
    regimeSampleCounts[regime] = result.sampleCount;
    if (result.updated) anyUpdated = true;
  }

  return { byRegime, regimeSampleCounts, regimeOrder, anyUpdated };
}

export const _internals = {
  pearsonCorrelation,
  invert3x3,
  matVecMul3,
  ridgeOls3,
  resolveCurrentWeights,
  extractSamples,
  groupRecordsByRegime,
  FEATURES,
  WEIGHT_MIN,
  WEIGHT_MAX,
  DEFAULT_RIDGE_LAMBDA,
};
