import fs from "fs";
import path from "path";

import { filterPhase1Records, getPhase1StartDate } from "./phase1Window.js";
import { loadStateSync } from "./stewardState.js";
import { getExchangeDateString } from "./timeUtils.js";
import { isTrainingModeAllowed } from "./trainingMode.js";

const DEFAULT_SCORECARD_PATH = path.join(
  process.cwd(),
  "data",
  "signal-scorecard.jsonl"
);

export function loadScorecardRecords(scorecardPath = DEFAULT_SCORECARD_PATH) {
  if (!fs.existsSync(scorecardPath)) return [];
  const raw = fs.readFileSync(scorecardPath, "utf8");
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return filterPhase1Records(records, { state: loadStateSync() });
}

function filterRecordsByActionTypes(records, actionTypes) {
  const allowed = new Set((actionTypes ?? []).map((value) => String(value).toUpperCase()));
  if (allowed.size === 0) return records.slice();
  return records.filter((record) =>
    allowed.has(String(record?.action_type ?? "").toUpperCase())
  );
}

function filterRecordsForTraining(records, actionTypes, reasonPrefixes) {
  const allowedActions = new Set(
    (actionTypes ?? []).map((value) => String(value).toUpperCase())
  );
  const allowedPrefixes = (reasonPrefixes ?? []).map((value) =>
    String(value).toUpperCase()
  );
  if (allowedActions.size === 0 && allowedPrefixes.length === 0) {
    return records.slice();
  }
  return records.filter((record) => {
    const action = String(record?.action_type ?? "").toUpperCase();
    if (allowedActions.has(action)) return true;
    if (action === "NO_ACTION" && allowedPrefixes.length) {
      const reason = String(record?.reason_code ?? "").toUpperCase();
      return allowedPrefixes.some((prefix) => reason.startsWith(prefix));
    }
    return false;
  });
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateString(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

function daysBetweenExchangeDates(startDate, endDate) {
  const start = new Date(getExchangeDateString(startDate));
  const end = new Date(getExchangeDateString(endDate));
  return Math.floor((end.getTime() - start.getTime()) / 86400000);
}

function summarizeScorecard(records, horizons, limit) {
  const windowed = limit > 0 ? records.slice(-limit) : records.slice();
  const summary = {
    sampleCount: windowed.length,
    horizons: {},
  };

  horizons.forEach((horizon) => {
    const key = String(horizon);
    const signed = [];
    const excessBench = [];
    const excessCash = [];
    const beatCash = [];
    const beatBench = [];

    windowed.forEach((record) => {
      const data = record?.horizons?.[key];
      if (!data) return;
      const signedReturn = data.signed_return;
      const benchReturn = data.benchmark_return;
      const exBench = data.excess_vs_benchmark;
      const exCash = data.excess_vs_cash;
      if (typeof signedReturn === "number" && Number.isFinite(signedReturn)) {
        signed.push(signedReturn);
        beatCash.push(signedReturn > 0);
        if (typeof benchReturn === "number" && Number.isFinite(benchReturn)) {
          beatBench.push(signedReturn > benchReturn);
        }
      }
      if (typeof exBench === "number" && Number.isFinite(exBench)) {
        excessBench.push(exBench);
      }
      if (typeof exCash === "number" && Number.isFinite(exCash)) {
        excessCash.push(exCash);
      }
    });

    const avg = (values) =>
      values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : null;
    const rate = (values) =>
      values.length
        ? values.filter(Boolean).length / values.length
        : null;

    summary.horizons[key] = {
      sampleCount: signed.length,
      avgSignedReturn: avg(signed),
      avgExcessBenchmark: avg(excessBench),
      avgExcessCash: avg(excessCash),
      beatCashRate: rate(beatCash),
      beatBenchmarkRate: rate(beatBench),
    };
  });

  return summary;
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

export function trainPolicyWithScorecard({
  policy,
  scorecardPath = DEFAULT_SCORECARD_PATH,
  horizons = [5, 20],
  window = 60,
  minSamples = 5,
  signedThreshold = 0,
  benchmarkThreshold = signedThreshold,
  riskStep = 0.01,
  bufferStep = 0.005,
  minRisk = 0.1,
  maxRisk = 0.33,
  minBuffer = 0.01,
  maxBuffer = 0.05,
  trainingActionTypes = ["BUY", "MULTI"],
  trainingReasonPrefixes = ["BUY_", "SELL_"],
  force = false,
} = {}) {
  if (!policy) {
    return {
      updated: false,
      reason: "policy_load_failed",
      fallback: true,
      source: "scorecard",
    };
  }

  if (!isTrainingModeAllowed(policy.mode)) {
    return {
      updated: false,
      reason: "non_trainable_mode",
      fallback: false,
      source: "scorecard",
    };
  }

  const records = loadScorecardRecords(scorecardPath);
  if (!records.length) {
    const phase1StartDate = getPhase1StartDate();
    return {
      updated: false,
      reason: phase1StartDate ? "no_phase1_scorecard" : "no_scorecard",
      fallback: true,
      source: "scorecard",
    };
  }

  const lastScorecardAt = parseDateString(policy.lastScorecardAt);
  const today = getExchangeDateString();
  if (lastScorecardAt && !force) {
    const minDaysBetween = Math.max(
      0,
      Math.floor(
        parseNumber(process.env.VS_SCORECARD_MIN_DAYS_BETWEEN, 1)
      )
    );
    const daysSince = daysBetweenExchangeDates(lastScorecardAt, new Date());
    if (daysSince < minDaysBetween) {
      return {
        updated: false,
        reason: "cooldown",
        fallback: false,
        source: "scorecard",
      };
    }
    if (getExchangeDateString(lastScorecardAt) === today) {
      return {
        updated: false,
        reason: "already_updated_today",
        fallback: false,
        source: "scorecard",
      };
    }
  }

  const summary = summarizeScorecard(
    filterRecordsForTraining(records, trainingActionTypes, trainingReasonPrefixes),
    horizons,
    window
  );
  const scorecardSummary = {
    training: summary,
    all: summarizeScorecard(records, horizons, window),
    noAction: summarizeScorecard(
      filterRecordsByActionTypes(records, ["NO_ACTION"]),
      horizons,
      window
    ),
    buyBlockedCounterfactual: summarizeScorecard(
      filterRecordsForTraining(records, [], ["BUY_"]),
      horizons,
      window
    ),
    trainingActionTypes: Array.from(
      new Set((trainingActionTypes ?? []).map((value) => String(value).toUpperCase()))
    ),
    trainingReasonPrefixes: Array.from(
      new Set((trainingReasonPrefixes ?? []).map((value) => String(value).toUpperCase()))
    ),
  };
  const horizonStats = summary.horizons;
  const insufficient = horizons.some((horizon) => {
    const stats = horizonStats[String(horizon)];
    return !stats || stats.sampleCount < minSamples;
  });
  if (insufficient) {
    return {
      updated: false,
      reason: "insufficient_buy_samples",
      fallback: true,
      source: "scorecard",
      scorecardSummary,
    };
  }

  const positive = horizons.every((horizon) => {
    const stats = horizonStats[String(horizon)];
    return (
      stats?.avgExcessBenchmark !== null &&
      stats.avgExcessBenchmark > benchmarkThreshold
    );
  });
  const negative = horizons.every((horizon) => {
    const stats = horizonStats[String(horizon)];
    return (
      stats?.avgExcessBenchmark !== null &&
      stats.avgExcessBenchmark < -benchmarkThreshold
    );
  });

  if (!positive && !negative) {
    return {
      updated: false,
      reason: "mixed_signal",
      fallback: false,
      source: "scorecard",
      scorecardSummary,
    };
  }

  const direction = positive ? 1 : -1;
  const oldRisk = typeof policy.risk_level === "number" ? policy.risk_level : 0.2;
  const oldBuffer =
    typeof policy.rebalance_buffer_pct === "number"
      ? policy.rebalance_buffer_pct
      : 0.02;
  const newRisk = clamp(oldRisk + direction * riskStep, minRisk, maxRisk);
  const newBuffer = clamp(
    oldBuffer - direction * bufferStep,
    minBuffer,
    maxBuffer
  );

  if (newRisk === oldRisk && newBuffer === oldBuffer) {
    return {
      updated: false,
      reason: "clamped",
      fallback: false,
      source: "scorecard",
      oldRisk,
      newRisk,
      oldBuffer,
      newBuffer,
      scorecardSummary,
    };
  }

  const nowIso = new Date().toISOString();
  const newPolicy = {
    ...policy,
    schema_version: policy.schema_version ?? 1,
    version: (policy.version ?? 1) + 1,
    risk_level: newRisk,
    rebalance_buffer_pct: newBuffer,
    lastTrainedAt: nowIso,
    lastTrainingReason: "scorecard_update",
    lastScorecardAt: nowIso,
    lastScorecardSummary: {
      window,
      horizons,
      minSamples,
      signedThreshold,
      benchmarkThreshold,
      summary: scorecardSummary,
    },
  };

  return {
    updated: true,
    reason: "scorecard_update",
    fallback: false,
    source: "scorecard",
    oldRisk,
    newRisk,
    oldBuffer,
    newBuffer,
    policyVersion: newPolicy.version,
    scorecardSummary,
    newPolicy,
  };
}
