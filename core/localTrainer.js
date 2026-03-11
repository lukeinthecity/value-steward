import fs from "fs";
import path from "path";

import { trainPolicyWithMetrics } from "./deepTrainer.js";
import { trainPolicyWithScorecard } from "./scorecardTrainer.js";

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
  return JSON.parse(raw);
}

function savePolicy(policy) {
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  const raw = fs.readFileSync(HISTORY_PATH, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendTrainingLog(entry) {
  fs.mkdirSync(path.dirname(TRAINING_LOG_PATH), { recursive: true });
  fs.appendFileSync(TRAINING_LOG_PATH, `${JSON.stringify(entry)}\n`);
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

export function trainPolicyFromHistoryLocal({
  minHistory = 10,
  equityDeltaThreshold = null,
  maxStep = 0.01,
  minRisk = 0.1,
  maxRisk = 0.9,
  minRiskDelta = null,
  worldContext = null,
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

  const scorecardEnabled = !["0", "false", "no", "off"].includes(
    String(process.env.VS_SCORECARD_LEARN ?? "true").toLowerCase()
  );
  if (scorecardEnabled) {
    const scorecardTraining = trainPolicyWithScorecard({
      policy,
      scorecardPath: SCORECARD_PATH,
      horizons: parseHorizonList(process.env.VS_SCORECARD_HORIZONS, [5, 20]),
      window: parseNumber(process.env.VS_SCORECARD_WINDOW, 60),
      minSamples: parseNumber(process.env.VS_SCORECARD_MIN_SAMPLES, 20),
      signedThreshold: parseNumber(
        process.env.VS_SCORECARD_SIGNED_THRESHOLD,
        0
      ),
      riskStep: parseNumber(process.env.VS_SCORECARD_RISK_STEP, 0.01),
      bufferStep: parseNumber(process.env.VS_SCORECARD_BUFFER_STEP, 0.005),
      minRisk: parseNumber(process.env.VS_SCORECARD_MIN_RISK, 0.1),
      maxRisk: parseNumber(process.env.VS_SCORECARD_MAX_RISK, 0.33),
      minBuffer: parseNumber(process.env.VS_SCORECARD_MIN_BUFFER, 0.01),
      maxBuffer: parseNumber(process.env.VS_SCORECARD_MAX_BUFFER, 0.05),
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

      if (scorecardTraining.updated && scorecardTraining.newPolicy) {
        savePolicy(scorecardTraining.newPolicy);
        return scorecardTraining;
      }

      const blockFallbackReasons = new Set([
        "already_updated_today",
        "non_read_only_mode",
      ]);
      if (blockFallbackReasons.has(scorecardTraining.reason)) {
        return scorecardTraining;
      }
    }
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
