/**
 * Gate calibration report (ML_BACKLOG item 2.4): per-gate post-mortem of
 * BUY_BLOCKED decisions.
 *
 * Every blocked buy records a counterfactual — what the symbol did over the
 * next 5 days anyway. Grouping those by WHICH gate fired tells us whether
 * each gate blocks losers (mean forward excess < 0: gate justified) or
 * winners (mean > 0: gate too tight). Pure observation, regenerated weekly
 * into data/gate-calibration.md. The operator decides; nothing auto-tunes,
 * and per the backlog no thresholds change mid-run.
 */

import path from "path";

import { readJsonl, writeTextAtomic } from "./runtimeArtifacts.js";
import { getIntentLogPath } from "./intentReconciliation.js";
import { getScorecardPath } from "./executionQualityReport.js";
import { mean, median, tStatVsZero } from "./stats.js";

const MIN_SAMPLES = 10;

export function getGateCalibrationPath() {
  return path.join(process.cwd(), "data", "gate-calibration.md");
}

/**
 * Map a BUY_BLOCKED explanation to the gate that fired. Vocabulary comes
 * from decision_engine._allow_buy and the sandbox-headroom block; order
 * matters (macro notes also contain "signal_score=").
 */
export function classifyGate(explanation) {
  const note = String(explanation ?? "").replace(/^buy blocked:\s*/i, "");
  if (note.startsWith("macro_label=")) {
    return note.includes("signal_score=")
      ? "macro_score_floor"
      : "macro_sector";
  }
  if (note.startsWith("entry_quality score=")) return "score_floor";
  if (note.startsWith("entry_quality rel20=")) return "rel_strength_20d";
  if (note.startsWith("entry_quality rel60=")) return "rel_strength_60d";
  if (note.startsWith("entry_quality trend=")) return "trend_strength";
  if (note.startsWith("thompson_gate")) return "thompson_gate";
  if (note.startsWith("sandbox_headroom")) return "sandbox_headroom";
  if (note.startsWith("signal_score=")) return "negative_score";
  return "other";
}

/**
 * Pure join: BUY_BLOCKED scorecard rows × intent explanations → per-gate
 * forward-excess statistics at the given horizon.
 */
export function buildGateCalibration({
  scorecardRecords,
  intents,
  horizon = 5,
  now = new Date(),
} = {}) {
  const explanationById = new Map();
  for (const intent of intents ?? []) {
    if (intent?.id) explanationById.set(intent.id, intent.explanation ?? "");
  }

  const horizonKey = String(horizon);
  const byGate = new Map();
  let totalBlocked = 0;
  let unmatched = 0;
  for (const record of scorecardRecords ?? []) {
    if (record?.reason_code !== "BUY_BLOCKED") continue;
    totalBlocked += 1;
    const explanation = explanationById.get(record?.intent_id);
    if (explanation === undefined) {
      unmatched += 1;
      continue;
    }
    const gate = classifyGate(explanation);
    const excess = record?.horizons?.[horizonKey]?.excess_vs_benchmark;
    if (!Number.isFinite(excess)) continue;
    const bucket = byGate.get(gate) ?? [];
    bucket.push(excess);
    byGate.set(gate, bucket);
  }

  const gates = [...byGate.entries()]
    .map(([gate, excesses]) => ({
      gate,
      count: excesses.length,
      mean_excess: mean(excesses),
      median_excess: median(excesses),
      t_stat: tStatVsZero(excesses),
      insufficient: excesses.length < MIN_SAMPLES,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    generated_at: now.toISOString(),
    horizon,
    total_blocked: totalBlocked,
    unmatched_intents: unmatched,
    min_samples: MIN_SAMPLES,
    gates,
  };
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtT(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

export function renderGateCalibrationMarkdown(result) {
  const lines = [
    "# Gate Calibration Report",
    "",
    "**Observation only — do not act mid-run.** Interpretation: mean forward",
    `excess **< 0** means the gate blocked losers (justified); **> 0** means it`,
    "blocked winners (too tight). Rows with fewer than " +
      `${result.min_samples} samples or |t| < 2 are noise, not signal.`,
    "",
    `Generated: ${result.generated_at} · Horizon: ${result.horizon}d · ` +
      `Blocked rows: ${result.total_blocked} (${result.unmatched_intents} without a matching intent)`,
    "",
    "| Gate | Blocks | Mean excess | Median excess | t vs 0 | Verdict |",
    "|---|---|---|---|---|---|",
  ];
  for (const gate of result.gates) {
    const verdict = gate.insufficient
      ? "insufficient data"
      : !Number.isFinite(gate.t_stat) || Math.abs(gate.t_stat) < 2
        ? "not significant"
        : gate.mean_excess < 0
          ? "justified"
          : "too tight?";
    lines.push(
      `| ${gate.gate} | ${gate.count} | ${fmtPct(gate.mean_excess)} | ` +
        `${fmtPct(gate.median_excess)} | ${fmtT(gate.t_stat)} | ${verdict} |`,
    );
  }
  if (!result.gates.length) {
    lines.push("| _no matured BUY_BLOCKED rows yet_ | | | | | |");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Read live artifacts, build the report, write the markdown atomically.
 */
export function runGateCalibration({ now = new Date(), horizon = 5 } = {}) {
  const result = buildGateCalibration({
    scorecardRecords: readJsonl(getScorecardPath()),
    intents: readJsonl(getIntentLogPath()),
    horizon,
    now,
  });
  writeTextAtomic(
    getGateCalibrationPath(),
    renderGateCalibrationMarkdown(result),
  );
  return result;
}
