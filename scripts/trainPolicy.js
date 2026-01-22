import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLICY_PATH = path.join(__dirname, "..", "config", "policy.json");
const HISTORY_PATH = path.join(__dirname, "..", "data", "history.jsonl");

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

function computeEquityDelta(history) {
  if (history.length < 2) return 0;
  const equities = history.map((h) => parseFloat(h.equity));
  return equities[equities.length - 1] - equities[0];
}

async function main() {
  const history = loadHistory();
  const policy = loadPolicy();

  const equityDelta = computeEquityDelta(history);

  let newRisk = policy.risk_level;
  if (equityDelta > 0) {
    newRisk = Math.min(1, policy.risk_level + 0.01);
  } else if (equityDelta < 0) {
    newRisk = Math.max(0, policy.risk_level - 0.01);
  }

  const newPolicy = {
    ...policy,
    version: (policy.version || 1) + 1,
    risk_level: newRisk,
    lastTrainedAt: new Date().toISOString(),
    lastEquityDelta: equityDelta,
  };

  savePolicy(newPolicy);

  console.log("Updated policy:", newPolicy);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
