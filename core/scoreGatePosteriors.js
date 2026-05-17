/**
 * Per-symbol Beta(alpha, beta) posteriors for the score-gate Thompson sampler.
 *
 * For each scorecard record at the training horizon:
 *   - If excess_vs_benchmark > 0: alpha += 1 (beat the benchmark)
 *   - If excess_vs_benchmark <= 0: beta += 1 (didn't beat the benchmark)
 *
 * The Python decision_engine reads these posteriors and samples from
 * Beta(alpha + prior_alpha, beta + prior_beta) at decision time. High alpha
 * means a high-confidence winner; high beta means a known loser. The prior
 * (default Beta(2, 2)) keeps new symbols neutral until enough evidence
 * accumulates.
 *
 * Posteriors are rebuilt from scratch each cycle for idempotency.
 */

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeSymbol(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build score-gate posteriors from a list of scorecard records.
 *
 * @param {object} args
 * @param {Array} args.records - Scorecard records.
 * @param {number} args.horizon - Forward horizon in trading days (default 5).
 * @param {string} args.target - Which field to interpret as the outcome
 *   (default "excess_vs_benchmark"; "signed_return" also valid).
 * @returns {object} { posteriors, sampleCount, skippedNoTarget, skippedNoSymbol,
 *   diagnostics }
 */
export function buildScoreGatePosteriors({
  records,
  horizon = 5,
  target = "excess_vs_benchmark",
} = {}) {
  const posteriors = {};
  let sampleCount = 0;
  let skippedNoTarget = 0;
  let skippedNoSymbol = 0;

  if (!Array.isArray(records)) {
    return {
      posteriors,
      sampleCount: 0,
      skippedNoTarget: 0,
      skippedNoSymbol: 0,
      diagnostics: { horizon, target },
    };
  }

  const horizonKey = String(horizon);
  for (const record of records) {
    const horizonData = record?.horizons?.[horizonKey];
    const targetValue = horizonData?.[target];
    if (!isFiniteNumber(targetValue)) {
      skippedNoTarget += 1;
      continue;
    }
    const symbol = normalizeSymbol(record?.symbol);
    if (!symbol) {
      skippedNoSymbol += 1;
      continue;
    }
    if (!posteriors[symbol]) {
      posteriors[symbol] = { alpha: 0, beta: 0, sample_count: 0, sum_excess: 0 };
    }
    const slot = posteriors[symbol];
    if (targetValue > 0) {
      slot.alpha += 1;
    } else {
      slot.beta += 1;
    }
    slot.sample_count += 1;
    slot.sum_excess += targetValue;
    sampleCount += 1;
  }

  // Add a rolling mean for diagnostics.
  for (const symbol of Object.keys(posteriors)) {
    const p = posteriors[symbol];
    p.avg_excess = p.sample_count > 0 ? p.sum_excess / p.sample_count : null;
    delete p.sum_excess;
  }

  return {
    posteriors,
    sampleCount,
    skippedNoTarget,
    skippedNoSymbol,
    diagnostics: { horizon, target, symbolCount: Object.keys(posteriors).length },
  };
}

export const _internals = { normalizeSymbol };
