import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { trainPolicyWithMetrics } from "../core/deepTrainer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLICY_PATH = path.join(__dirname, "..", "config", "policy.json");
const HISTORY_PATH = path.join(__dirname, "..", "data", "history.jsonl");
const TRAINING_LOG_PATH = path.join(__dirname, "..", "data", "training-log.jsonl");

function loadPolicy() {
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

async function main() {
  const history = loadHistory();
  const policy = loadPolicy();

  const training = trainPolicyWithMetrics({
    history,
    policy,
    minHistory: 10,
    equityDeltaThreshold: 0,
    maxStep: 0.01,
    minRisk: 0.1,
    maxRisk: 0.9,
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
  };

  appendTrainingLog(entry);

  if (training.updated && training.newPolicy) {
    savePolicy(training.newPolicy);
    console.log("Updated policy:", training.newPolicy);
  } else {
    console.log("No policy update:", training.reason);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
