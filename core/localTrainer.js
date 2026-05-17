import fs from "fs";
import path from "path";

import { filterPhase1Records } from "./phase1Window.js";
import { normalizePolicySnapshot } from "./policySnapshot.js";
import { trainPolicyWithMetrics } from "./deepTrainer.js";
import {
  appendJsonlLineSync,
  writeJsonAtomic,
} from "./runtimeArtifacts.js";
import {
  loadScorecardRecords,
  trainPolicyWithScorecard,
} from "./scorecardTrainer.js";
import { trainSignalWeights } from "./signalWeightTrainer.js";
import { getExchangeDateString } from "./timeUtils.js";

const POLICY_PATH = path.join(process.cwd(), "config", "policy.json");
const HISTORY_PATH = path.join(process.cwd(), "data", "history.jsonl");
const SCORECARD_PATH = path.join(
  process.cwd(),
  "data",
  "signal-scorecard.jsonl"
);
const TRAINING_LOG_PATH = path.join(
  process.cwd(),
  "data",
  "training-log.jsonl"
);

function loadPolicy() {
  if (!fs.existsSync(POLICY_PATH)) return null;
  const raw = fs.readFileSync(POLICY_PATH, "utf8");
  return normalizePolicySnapshot(JSON.parse(raw));
}

function savePolicy(policy) {
  writeJsonAtomic(POLICY_PATH, normalizePolicySnapshot(policy));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  const raw = fs.readFileSync(HISTORY_PATH, "utf8");
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return filterPhase1Records(records);
}

function appendTrainingLog(entry) {
  appendJsonlLineSync(TRAINING_LOG_PATH, entry);
}

function loadLatestTrainingEntryBySource(source) {
  if (!fs.existsSync(TRAINING_LOG_PATH)) return null;
  const lines = fs
    .readFileSync(TRAINING_LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if ((entry?.source ?? "history") === source) {
        return entry;
      }
    } catch {
      // ignore malformed historical rows
    }
  }
  return null;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseHorizonList(value, fallback = [5, 20]) {
  if (!value) return fallback;
  const list = String(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num) && num > 0);
  return list.length ? Array.from(new Set(list)) : fallback;
}

function parseReasonPrefixList(value, fallback = ["BUY_", "SELL_"]) {
  if (value === undefined || value === null) return fallback;
  const list = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.toUpperCase());
  return list.length ? Array.from(new Set(list)) : fallback;
}

function buildWorldSnapshot(worldContext) {
  if (!worldContext) return null;
  return {
    date: worldContext.date ?? null,
    slot: worldContext.slot ?? null,
    macro_label: worldContext.macro_view?.macro_label ?? null,
    macro_score: worldContext.macro_view?.macro_score ?? null,
    generated_at: worldContext.generated_at ?? null,
    sources_used: worldContext.sources_used ?? null,
    raw_count: worldContext.raw_count ?? null,
  };
}

function maybeTrainSignalWeights({ baselinePolicy, worldContext }) {
  const weightLearningDisabled = ["0", "false", "no", "off"].includes(
    String(process.env.VS_SIGNAL_WEIGHT_LEARN ?? "true").toLowerCase()
  );
  if (weightLearningDisabled) return baselinePolicy;

  const records = loadScorecardRecords(SCORECARD_PATH);
  const weightTraining = trainSignalWeights({
    records,
    currentSignalWeights: baselinePolicy.signal_weights || null,
    horizon: parseNumber(process.env.VS_SIGNAL_WEIGHT_HORIZON, 5),
    stepSize: parseNumber(process.env.VS_SIGNAL_WEIGHT_STEP, 0.05),
    minSamples: parseNumber(process.env.VS_SIGNAL_WEIGHT_MIN_SAMPLES, 8),
    minCorrelation: parseNumber(process.env.VS_SIGNAL_WEIGHT_MIN_CORR, 0.05),
    target: (process.env.VS_SIGNAL_WEIGHT_TARGET || "excess_vs_benchmark").trim(),
  });

  const nowIso = new Date().toISOString();
  const logEntry = {
    ranAt: nowIso,
    source: "signal_weights",
    decision: weightTraining.updated ? "update" : "no_update",
    reason: weightTraining.reason,
    sampleCount: weightTraining.sampleCount,
    correlations: weightTraining.correlations,
    oldWeights: weightTraining.oldWeights,
    newWeights: weightTraining.newWeights,
    diagnostics: weightTraining.diagnostics,
    policyVersionBefore: baselinePolicy.version ?? 1,
    policyVersionAfter: weightTraining.updated
      ? (baselinePolicy.version ?? 1) + 1
      : baselinePolicy.version ?? 1,
    worldMacroSnapshot: buildWorldSnapshot(worldContext),
  };
  appendTrainingLog(logEntry);

  if (!weightTraining.updated) {
    return baselinePolicy;
  }

  const mergedPolicy = {
    ...baselinePolicy,
    schema_version: baselinePolicy.schema_version ?? 1,
    version: (baselinePolicy.version ?? 1) + 1,
    signal_weights: {
      ...(baselinePolicy.signal_weights || {}),
      ...weightTraining.newWeights,
      last_trained_at: nowIso,
      last_sample_count: weightTraining.sampleCount,
      last_correlations: weightTraining.correlations,
      last_horizon: weightTraining.diagnostics?.horizon ?? null,
    },
    lastTrainedAt: nowIso,
    lastTrainingReason: "signal_weights_update",
  };
  savePolicy(mergedPolicy);
  return mergedPolicy;
}

export function trainPolicyFromHistoryLocal({
  minHistory = 10,
  equityDeltaThreshold = null,
  maxStep = 0.01,
  minRisk = 0.1,
  maxRisk = 0.9,
  minRiskDelta = null,
  worldContext = null,
  force = false,
  allowScorecard = true,
  allowHistory = true,
} = {}) {
  const policy = loadPolicy();
  const history = loadHistory();
  if (!policy) {
    const entry = {
      ranAt: new Date().toISOString(),
      policyVersionBefore: null,
      policyVersionAfter: null,
      oldRisk: null,
      newRisk: null,
      decision: "no_update",
      reason: "policy_load_failed",
      metrics: null,
      worldMacroSnapshot: buildWorldSnapshot(worldContext),
    };
    appendTrainingLog(entry);
    return { updated: false, reason: "policy_load_failed" };
  }

  const oncePerDay = !["0", "false", "no", "off"].includes(
    String(process.env.VS_TRAIN_ONCE_PER_DAY ?? "true").toLowerCase()
  );

  const scorecardEnabled =
    allowScorecard &&
    !["0", "false", "no", "off"].includes(
      String(process.env.VS_SCORECARD_LEARN ?? "true").toLowerCase()
    );
  if (scorecardEnabled) {
    const latestScorecardTraining = loadLatestTrainingEntryBySource("scorecard");
    if (
      !force &&
      oncePerDay &&
      latestScorecardTraining?.ranAt &&
      getExchangeDateString(new Date(latestScorecardTraining.ranAt)) ===
        getExchangeDateString(new Date())
    ) {
      return {
        updated: false,
        reason: "already_attempted_today",
        source: "scorecard",
        oldRisk: policy.risk_level ?? null,
        newRisk: policy.risk_level ?? null,
        policyVersion: policy.version ?? 1,
        metrics: null,
      };
    }

    const scorecardTraining = trainPolicyWithScorecard({
      policy,
      scorecardPath: SCORECARD_PATH,
      horizons: parseHorizonList(process.env.VS_SCORECARD_HORIZONS, [5, 20]),
      window: parseNumber(process.env.VS_SCORECARD_WINDOW, 60),
      minSamples: parseNumber(process.env.VS_SCORECARD_MIN_SAMPLES, 5),
      trainingReasonPrefixes: parseReasonPrefixList(
        process.env.VS_SCORECARD_TRAINING_REASON_PREFIXES,
        ["BUY_", "SELL_"]
      ),
      signedThreshold: parseNumber(
        process.env.VS_SCORECARD_SIGNED_THRESHOLD,
        0
      ),
      benchmarkThreshold: parseNumber(
        process.env.VS_SCORECARD_BENCHMARK_THRESHOLD,
        parseNumber(process.env.VS_SCORECARD_SIGNED_THRESHOLD, 0)
      ),
      riskStep: parseNumber(process.env.VS_SCORECARD_RISK_STEP, 0.01),
      bufferStep: parseNumber(process.env.VS_SCORECARD_BUFFER_STEP, 0.005),
      minRisk: parseNumber(process.env.VS_SCORECARD_MIN_RISK, 0.1),
      maxRisk: parseNumber(process.env.VS_SCORECARD_MAX_RISK, 0.33),
      minBuffer: parseNumber(process.env.VS_SCORECARD_MIN_BUFFER, 0.01),
      maxBuffer: parseNumber(process.env.VS_SCORECARD_MAX_BUFFER, 0.05),
      force,
    });

    if (scorecardTraining) {
      const entry = {
        ranAt: new Date().toISOString(),
        policyVersionBefore: policy.version ?? 1,
        policyVersionAfter: scorecardTraining.updated
          ? scorecardTraining.policyVersion
          : policy.version ?? 1,
        oldRisk: scorecardTraining.oldRisk ?? policy.risk_level,
        newRisk: scorecardTraining.newRisk ?? policy.risk_level,
        oldBuffer: scorecardTraining.oldBuffer ?? policy.rebalance_buffer_pct ?? null,
        newBuffer: scorecardTraining.newBuffer ?? policy.rebalance_buffer_pct ?? null,
        decision: scorecardTraining.updated ? "update" : "no_update",
        reason: scorecardTraining.reason,
        source: scorecardTraining.source ?? "scorecard",
        metrics: null,
        scorecardSummary: scorecardTraining.scorecardSummary ?? null,
        worldMacroSnapshot: buildWorldSnapshot(worldContext),
      };

      appendTrainingLog(entry);

      let baselinePolicy = policy;
      if (scorecardTraining.updated && scorecardTraining.newPolicy) {
        baselinePolicy = scorecardTraining.newPolicy;
        savePolicy(baselinePolicy);
      }

      const blockFallbackReasons = new Set([
        "already_updated_today",
        "already_attempted_today",
        "cooldown",
        "non_trainable_mode",
      ]);
      // Signal weight training runs whenever scorecard training was attempted
      // and the scorecard wasn't blocked by a cooldown reason. It uses the
      // same records and inherits cooldown via the scorecard guard above.
      if (!blockFallbackReasons.has(scorecardTraining.reason)) {
        baselinePolicy = maybeTrainSignalWeights({
          baselinePolicy,
          worldContext,
        });
      }

      if (scorecardTraining.updated) {
        return scorecardTraining;
      }

      if (
        blockFallbackReasons.has(scorecardTraining.reason) ||
        history.length === 0
      ) {
        return scorecardTraining;
      }
    }
  }

  if (!allowHistory) {
    return {
      updated: false,
      reason: "history_disabled",
      source: "history",
      oldRisk: policy.risk_level ?? null,
      newRisk: policy.risk_level ?? null,
      policyVersion: policy.version ?? 1,
      metrics: null,
    };
  }

  const latestHistoryTraining = loadLatestTrainingEntryBySource("history");
  if (
    !force &&
    oncePerDay &&
    latestHistoryTraining?.ranAt &&
    getExchangeDateString(new Date(latestHistoryTraining.ranAt)) ===
      getExchangeDateString(new Date())
  ) {
    return {
      updated: false,
      reason: "already_attempted_today",
      source: "history",
      oldRisk: policy.risk_level ?? null,
      newRisk: policy.risk_level ?? null,
      policyVersion: policy.version ?? 1,
      metrics: null,
    };
  }

  const resolvedEquityDeltaThreshold = parseNumber(
    equityDeltaThreshold,
    parseNumber(process.env.VS_TRAIN_EQUITY_DELTA_THRESHOLD, 0)
  );
  const resolvedMinRiskDelta = parseNumber(
    minRiskDelta,
    parseNumber(process.env.VS_TRAIN_MIN_RISK_DELTA, 0)
  );

  const training = trainPolicyWithMetrics({
    history,
    policy,
    minHistory,
    equityDeltaThreshold: resolvedEquityDeltaThreshold,
    maxStep,
    minRisk,
    maxRisk,
    minRiskDelta: resolvedMinRiskDelta,
  });

  const entry = {
    ranAt: new Date().toISOString(),
    policyVersionBefore: policy.version ?? 1,
    policyVersionAfter: training.updated
      ? training.policyVersion
      : policy.version ?? 1,
    oldRisk: training.oldRisk ?? policy.risk_level,
    newRisk: training.newRisk ?? policy.risk_level,
    oldBuffer: policy.rebalance_buffer_pct ?? null,
    newBuffer: policy.rebalance_buffer_pct ?? null,
    decision: training.updated ? "update" : "no_update",
    reason: training.reason,
    source: "history",
    metrics: training.metrics ?? null,
    scorecardSummary: null,
    worldMacroSnapshot: buildWorldSnapshot(worldContext),
  };

  appendTrainingLog(entry);

  if (training.updated && training.newPolicy) {
    savePolicy(training.newPolicy);
  }

  return training;
}
