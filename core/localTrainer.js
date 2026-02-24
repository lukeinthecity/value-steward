import fs from "fs";
import path from "path";

import { trainPolicyWithMetrics } from "./deepTrainer.js";

const POLICY_PATH = path.join(process.cwd(), "config", "policy.json");
const HISTORY_PATH = path.join(process.cwd(), "data", "history.jsonl");
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
  equityDeltaThreshold = 0,
  maxStep = 0.01,
  minRisk = 0.1,
  maxRisk = 0.9,
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

  const training = trainPolicyWithMetrics({
    history,
    policy,
    minHistory,
    equityDeltaThreshold,
    maxStep,
    minRisk,
    maxRisk,
  });

  const entry = {
    ranAt: new Date().toISOString(),
    policyVersionBefore: policy.version ?? 1,
    policyVersionAfter: training.updated
      ? training.policyVersion
      : policy.version ?? 1,
    oldRisk: training.oldRisk ?? policy.risk_level,
    newRisk: training.newRisk ?? policy.risk_level,
    decision: training.updated ? "update" : "no_update",
    reason: training.reason,
    metrics: training.metrics ?? null,
    worldMacroSnapshot: buildWorldSnapshot(worldContext),
  };

  appendTrainingLog(entry);

  if (training.updated && training.newPolicy) {
    savePolicy(training.newPolicy);
  }

  return training;
}
