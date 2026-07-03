/**
 * Execution fill-rate + adverse-selection observation (ML_BACKLOG item 2.8).
 *
 * Answers two questions about the mid-point "Fishing" limit strategy:
 *   1. How often do attempts actually fill — and are the HIGH-conviction
 *      names filling less often than the rest?
 *   2. Adverse selection: did the names that got away subsequently
 *      outperform the ones that filled (i.e. is the spread saving costing
 *      the best ideas)?
 *
 * NOT to be confused with src/valuesteward/core/execution_quality.py, which
 * feeds the live signal-score blend and is therefore decision-affecting.
 * This module is pure observation: it appends snapshot rows to
 * data/execution-quality.jsonl and feeds no decisions. Acting on its
 * findings (e.g. conviction-scaled execution) is post-run work.
 */

import path from "path";

import { appendJsonlLineSync, readJsonl } from "./runtimeArtifacts.js";
import {
  getIntentOutcomesPath,
  toExchangeDate,
} from "./intentReconciliation.js";
import { mean, welchTStat } from "./stats.js";

export function getExecutionQualityLogPath() {
  return path.join(process.cwd(), "data", "execution-quality.jsonl");
}

export function getScorecardPath() {
  return path.join(process.cwd(), "data", "signal-scorecard.jsonl");
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isFilled(outcome) {
  return (
    outcome?.fill_status === "filled" ||
    (safeNumber(outcome?.filled_notional) ?? 0) > 0
  );
}

function latestOutcomesInWindow(outcomes, now, windowDays) {
  const cutoff = toExchangeDate(
    new Date(now.getTime() - windowDays * 86400000).toISOString(),
  );
  const latest = new Map();
  for (const row of outcomes ?? []) {
    const date = row?.exchange_date;
    if (!date || (cutoff && date < cutoff)) continue;
    const key = `${row?.intent_id ?? ""}|${row?.order_client_id ?? `${row?.symbol}:${row?.side}`}`;
    latest.set(key, row);
  }
  return [...latest.values()];
}

function bucketize(scored) {
  const n = scored.length;
  if (!n) return [];
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  const cut1 = Math.floor(n / 3);
  const cut2 = Math.floor((2 * n) / 3);
  const slices = [
    { bucket: "low", rows: sorted.slice(0, cut1) },
    { bucket: "mid", rows: sorted.slice(cut1, cut2) },
    { bucket: "high", rows: sorted.slice(cut2) },
  ];
  return slices
    .filter((slice) => slice.rows.length)
    .map(({ bucket, rows }) => {
      const fills = rows.filter((r) => r.filled).length;
      return {
        bucket,
        score_min: rows[0].score,
        score_max: rows[rows.length - 1].score,
        attempts: rows.length,
        fills,
        fill_rate: fills / rows.length,
      };
    });
}

/**
 * Pure computation over reconciled outcomes × scorecard rows.
 */
export function buildExecutionQualitySnapshot({
  outcomes,
  scorecardRecords,
  now = new Date(),
  windowDays = 30,
} = {}) {
  const attempts = latestOutcomesInWindow(outcomes, now, windowDays);

  const byIntentId = new Map();
  for (const record of scorecardRecords ?? []) {
    if (record?.intent_id) byIntentId.set(record.intent_id, record);
  }

  const enriched = attempts.map((outcome) => {
    const scorecard = byIntentId.get(outcome?.intent_id) ?? null;
    return {
      filled: isFilled(outcome),
      score: safeNumber(scorecard?.signal_score),
      excess5d: safeNumber(scorecard?.horizons?.["5"]?.excess_vs_benchmark),
    };
  });

  const fills = enriched.filter((row) => row.filled).length;
  const scored = enriched.filter((row) => row.score !== null);
  const matured = enriched.filter((row) => row.excess5d !== null);
  const filledExcess = matured
    .filter((row) => row.filled)
    .map((row) => row.excess5d);
  const unfilledExcess = matured
    .filter((row) => !row.filled)
    .map((row) => row.excess5d);
  const filledMean = mean(filledExcess);
  const unfilledMean = mean(unfilledExcess);

  return {
    timestamp: now.toISOString(),
    exchange_date: toExchangeDate(now.toISOString()),
    window_days: windowDays,
    attempts: enriched.length,
    fills,
    fill_rate: enriched.length ? fills / enriched.length : null,
    by_score_bucket: bucketize(scored),
    adverse_selection: {
      n_filled: filledExcess.length,
      n_unfilled: unfilledExcess.length,
      filled_mean_excess_5d: filledMean,
      unfilled_mean_excess_5d: unfilledMean,
      // Positive diff = the ones that got away did better (bad for Fishing).
      diff:
        filledMean !== null && unfilledMean !== null
          ? unfilledMean - filledMean
          : null,
      t_stat: welchTStat(unfilledExcess, filledExcess),
    },
    reason_code: "EXECUTION_QUALITY_SNAPSHOT",
  };
}

/**
 * Read the live artifacts, build a snapshot, append it to the log.
 */
export function runExecutionQualityReport({
  now = new Date(),
  windowDays = 30,
} = {}) {
  const snapshot = buildExecutionQualitySnapshot({
    outcomes: readJsonl(getIntentOutcomesPath()),
    scorecardRecords: readJsonl(getScorecardPath()),
    now,
    windowDays,
  });
  appendJsonlLineSync(getExecutionQualityLogPath(), snapshot);
  return snapshot;
}
