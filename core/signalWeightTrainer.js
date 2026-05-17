/**
 * Signal weight trainer.
 *
 * Uses Pearson correlation between each component signal feature
 * (momentum_rank, vol_rank, drawdown_rank) and the forward alpha
 * (excess_vs_benchmark by default) at a configurable horizon to compute
 * weight update deltas.
 *
 * Target choice matters: excess_vs_benchmark isolates alpha (did we beat
 * SPY?) from market beta (did the market go up?). Using raw signed_return
 * would mostly correlate with whether the market rose, not with our
 * feature edge. The scorecard trainer (which adjusts risk_level) uses the
 * same target — this keeps the learning signal consistent across both
 * trainers. Override with VS_SIGNAL_WEIGHT_TARGET if you need raw return.
 *
 * Why correlation rather than full OLS: with N=10-50 samples and three
 * highly-correlated rank features, full OLS produces unstable coefficients.
 * Per-feature correlation gives independent, interpretable updates that
 * degrade gracefully when data is sparse.
 *
 * Update rule: w_new[i] = clamp(w_old[i] + stepSize * r[i] * |r[i]|, min, max)
 * The |r| factor gives quadratic shrinkage so weak correlations barely move
 * the weights and strong correlations move them more.
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
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

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
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

/**
 * Train signal weights from a scorecard slice.
 *
 * @param {object} args
 * @param {Array} args.records - Scorecard records (may include null horizons).
 * @param {object|null} args.currentSignalWeights - Current weights map
 *   ({ momentum, vol, drawdown }). Defaults applied if missing.
 * @param {number} args.horizon - Forward-return horizon in trading days (default 5).
 * @param {number} args.stepSize - Max magnitude of any single weight update (default 0.05).
 * @param {number} args.minSamples - Minimum samples required (default 8).
 * @param {number} args.minCorrelation - Skip updates below this |r| (default 0.05).
 * @param {string} args.target - Which scorecard horizon field to regress against:
 *   "excess_vs_benchmark" (alpha; default, matches scorecardTrainer) or
 *   "signed_return" (raw direction-adjusted return).
 * @returns {object} { updated, reason, oldWeights, newWeights, correlations,
 *   sampleCount, diagnostics }
 */
export function trainSignalWeights({
  records,
  currentSignalWeights = null,
  horizon = 5,
  stepSize = 0.05,
  minSamples = 8,
  minCorrelation = 0.05,
  target = "excess_vs_benchmark",
} = {}) {
  const oldWeights = resolveCurrentWeights(currentSignalWeights);
  const resolvedTarget = VALID_TARGETS.has(target) ? target : "excess_vs_benchmark";

  if (!Array.isArray(records) || records.length === 0) {
    return {
      updated: false,
      reason: "no_records",
      oldWeights,
      newWeights: oldWeights,
      correlations: null,
      sampleCount: 0,
      diagnostics: { target: resolvedTarget },
    };
  }

  const { featureColumns, targets, sampleCount, skippedMissingFeature, skippedMissingReturn } =
    extractSamples(records, horizon, resolvedTarget);

  if (sampleCount < minSamples) {
    return {
      updated: false,
      reason: "insufficient_samples",
      oldWeights,
      newWeights: oldWeights,
      correlations: null,
      sampleCount,
      diagnostics: {
        horizon,
        minSamples,
        target: resolvedTarget,
        skippedMissingFeature,
        skippedMissingReturn,
      },
    };
  }

  const correlations = {};
  const newWeights = { ...oldWeights };
  let anyUpdate = false;

  FEATURES.forEach(({ policyKey }, idx) => {
    const r = pearsonCorrelation(featureColumns[idx], targets);
    correlations[policyKey] = r;
    if (r === null) return;
    if (Math.abs(r) < minCorrelation) return;
    const delta = stepSize * r * Math.abs(r);
    const updated = clamp(oldWeights[policyKey] + delta, WEIGHT_MIN, WEIGHT_MAX);
    if (updated !== oldWeights[policyKey]) {
      newWeights[policyKey] = updated;
      anyUpdate = true;
    }
  });

  if (!anyUpdate) {
    return {
      updated: false,
      reason: "no_significant_correlation",
      oldWeights,
      newWeights: oldWeights,
      correlations,
      sampleCount,
      diagnostics: {
        horizon,
        minSamples,
        target: resolvedTarget,
        skippedMissingFeature,
        skippedMissingReturn,
      },
    };
  }

  return {
    updated: true,
    reason: "weights_updated",
    oldWeights,
    newWeights,
    correlations,
    sampleCount,
    diagnostics: {
      horizon,
      minSamples,
      target: resolvedTarget,
      skippedMissingFeature,
      skippedMissingReturn,
    },
  };
}

export const _internals = {
  pearsonCorrelation,
  resolveCurrentWeights,
  extractSamples,
  FEATURES,
  WEIGHT_MIN,
  WEIGHT_MAX,
};
