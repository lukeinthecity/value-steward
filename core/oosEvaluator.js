/**
 * Out-of-sample (OOS) evaluator for the ML policy.
 *
 * "OOS" here means: scorecard rows whose forward returns were realized AFTER
 * the policy that produced them was trained. Strictly speaking, the trainer
 * doesn't see these outcomes until the NEXT cycle, so they're a clean
 * generalization test of the policy.
 *
 * Two metrics are computed:
 *   - strict OOS: rows where row.policy_version === currentPolicyVersion
 *     (decisions made under the *current* policy, whose forward outcomes
 *     were not in the trainer's input set when the policy was generated).
 *   - rolling OOS: the most recent N rows regardless of policy version
 *     (used as a smoother signal for champion-challenger promotion).
 *
 * Both report sample count, mean excess_vs_benchmark, std, Sharpe (mean/std),
 * and hit rate (fraction with excess > 0). Returns null metrics when there
 * are too few samples.
 */

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function summarize(values) {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      mean: null,
      std: null,
      sharpe: null,
      hitRate: null,
    };
  }
  const n = values.length;
  let sum = 0;
  let hits = 0;
  for (const v of values) {
    sum += v;
    if (v > 0) hits += 1;
  }
  const mean = sum / n;
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  // Bessel-corrected sample standard deviation.
  const std = n > 1 ? Math.sqrt(sumSq / (n - 1)) : 0;
  // Sharpe defined only when std is meaningfully non-zero — otherwise
  // the ratio is dominated by floating-point noise.
  const sharpe = n > 1 && std > 1e-9 ? mean / std : null;
  return {
    sampleCount: n,
    mean,
    std,
    sharpe,
    hitRate: hits / n,
  };
}

/**
 * Compute OOS evaluation metrics for the current policy.
 *
 * @param {object} args
 * @param {Array} args.records - Scorecard records (output of loadScorecardRecords).
 * @param {number|null} args.currentPolicyVersion - The current policy.json version.
 *   Used to slice "strict OOS" — rows decided under the current policy.
 * @param {number} args.horizon - Forward-return horizon to evaluate at (default 5).
 * @param {number} args.rollingWindow - Rolling sample window for the rolling metric
 *   (default 20).
 * @param {number} args.minSamples - Minimum samples required to report metrics
 *   (default 5). Below this, metric blocks are null.
 * @param {string} args.target - Field on horizon to evaluate (default "excess_vs_benchmark").
 * @returns {object}
 */
export function evaluateOos({
  records,
  currentPolicyVersion = null,
  horizon = 5,
  rollingWindow = 20,
  minSamples = 5,
  target = "excess_vs_benchmark",
} = {}) {
  const evaluatedAt = new Date().toISOString();
  const horizonKey = String(horizon);
  const safeRecords = Array.isArray(records) ? records : [];

  const collect = (filterFn, limit) => {
    const values = [];
    // Iterate most-recent-first so we can stop early for the rolling window.
    for (let i = safeRecords.length - 1; i >= 0; i -= 1) {
      const record = safeRecords[i];
      if (!filterFn(record)) continue;
      const horizonData = record?.horizons?.[horizonKey];
      const value = horizonData?.[target];
      if (!isFiniteNumber(value)) continue;
      values.push(value);
      if (limit && values.length >= limit) break;
    }
    return values;
  };

  const strictValues =
    currentPolicyVersion === null || currentPolicyVersion === undefined
      ? []
      : collect((r) => r?.policy_version === currentPolicyVersion);
  const rollingValues = collect(() => true, rollingWindow);

  const strict = summarize(strictValues);
  const rolling = summarize(rollingValues);

  const enough = (block) =>
    block.sampleCount >= minSamples ? block : { ...block, insufficient: true };

  return {
    evaluatedAt,
    policyVersion: currentPolicyVersion,
    horizon,
    target,
    rollingWindow,
    minSamples,
    strict: enough(strict),
    rolling: enough(rolling),
  };
}

export const _internals = { summarize };
