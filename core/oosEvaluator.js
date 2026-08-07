/**
 * Out-of-sample (OOS) evaluator for the ML policy.
 *
 * "OOS" here means: scorecard rows whose forward returns were realized AFTER
 * the policy that produced them was trained. Strictly speaking, the trainer
 * doesn't see these outcomes until the NEXT cycle, so they're a clean
 * generalization test of the policy.
 *
 * Two version slices are computed:
 *   - strict OOS: rows where row.policy_version === currentPolicyVersion
 *     (decisions made under the *current* policy, whose forward outcomes
 *     were not in the trainer's input set when the policy was generated).
 *   - rolling OOS: the most recent N rows regardless of policy version
 *     (used as a smoother signal for champion-challenger promotion).
 *
 * ORIENTATION (metricVersion 2, 2026-08-06). Both slices are restricted to
 * buy-related rows and oriented so that a POSITIVE value always means "the
 * decision helped" — see core/scorecardSemantics.js. Declined rows record the
 * forward return of a candidate we refused, so their raw sign is inverted and
 * is negated here. Before this fix the two populations were averaged raw,
 * which reported a 0.00 hit rate while the system was in fact declining losers
 * correctly.
 *
 * The pooled `rolling` / `strict` numbers are a DECISION-QUALITY score in
 * excess-return units, not a portfolio return — we did not earn the loss we
 * avoided. Realized P&L quality lives in the `taken` block. `taken` and
 * `declined` are an exact partition of the same rolling window, so a policy
 * that scores well purely by refusing everything in a falling market is
 * visible rather than hidden.
 *
 * Rows from before this change carry no `metricVersion` and are NOT comparable.
 */

import {
  isBuyRelatedRecord,
  isDeclinedBuyRecord,
  isTakenBuyRecord,
} from "./scorecardSemantics.js";

export const OOS_METRIC_VERSION = 2;

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
 *   (default 5). Below this, metric blocks are marked insufficient.
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

  const targetValue = (record) => record?.horizons?.[horizonKey]?.[target];

  const collectRows = (filterFn, limit) => {
    const rows = [];
    // Iterate most-recent-first so we can stop early for the rolling window.
    for (let i = safeRecords.length - 1; i >= 0; i -= 1) {
      const record = safeRecords[i];
      if (!isBuyRelatedRecord(record)) continue;
      if (!filterFn(record)) continue;
      if (!isFiniteNumber(targetValue(record))) continue;
      rows.push(record);
      if (limit && rows.length >= limit) break;
    }
    return rows;
  };

  // Declined rows carry the missed opportunity of a candidate we refused, so a
  // positive raw value means we blocked a winner. Negate so that across the
  // whole population, positive always means "the decision helped".
  const orientedValues = (rows) =>
    rows.map((record) => {
      const value = targetValue(record);
      return isDeclinedBuyRecord(record) ? -value : value;
    });

  const strictRows =
    currentPolicyVersion === null || currentPolicyVersion === undefined
      ? []
      : collectRows((r) => r?.policy_version === currentPolicyVersion);
  const rollingRows = collectRows(() => true, rollingWindow);

  const strict = summarize(orientedValues(strictRows));
  const rolling = summarize(orientedValues(rollingRows));
  const taken = summarize(orientedValues(rollingRows.filter(isTakenBuyRecord)));
  const declined = summarize(
    orientedValues(rollingRows.filter(isDeclinedBuyRecord)),
  );

  // Auditability: a reader of oos-eval.jsonl can see exactly what was dropped
  // and why, rather than inferring it from a count mismatch.
  const excluded = { sell: 0, no_action_other: 0, missing_target: 0 };
  for (const record of safeRecords) {
    if (isBuyRelatedRecord(record)) {
      if (!isFiniteNumber(targetValue(record))) excluded.missing_target += 1;
      continue;
    }
    const action = String(record?.action_type ?? "").toUpperCase();
    if (action === "SELL") excluded.sell += 1;
    else if (action === "NO_ACTION") excluded.no_action_other += 1;
  }

  const enough = (block) =>
    block.sampleCount >= minSamples ? block : { ...block, insufficient: true };

  return {
    evaluatedAt,
    metricVersion: OOS_METRIC_VERSION,
    population: "buy_related_oriented",
    policyVersion: currentPolicyVersion,
    horizon,
    target,
    rollingWindow,
    minSamples,
    strict: enough(strict),
    rolling: enough(rolling),
    taken: enough(taken),
    declined: enough(declined),
    excluded,
  };
}

export const _internals = { summarize };
