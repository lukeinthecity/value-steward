// Load .env first: cron runs with a minimal environment, so the trainer's
// VS_* tuning vars (champion-challenger, OOS, signal-weight, rotation, etc.)
// would otherwise silently fall back to defaults at the EOD train step.
import "dotenv/config";
import { trainPolicyFromHistoryLocal } from "../core/localTrainer.js";
import { startSpinner } from "../world/spinner.js";
import path from "path";
import { fileURLToPath } from "url";

async function main() {
  const stopSpinner = startSpinner("train policy", { total: 1 });
  const force = process.argv.includes("--force");
  const scorecardOnly = process.argv.includes("--scorecard-only");
  const historyOnly = process.argv.includes("--history-only");
  const training = trainPolicyFromHistoryLocal({
    minHistory: 10,
    equityDeltaThreshold: Number(
      process.env.VS_TRAIN_EQUITY_DELTA_THRESHOLD ?? 0
    ),
    maxStep: 0.01,
    minRisk: 0.1,
    maxRisk: Number(process.env.VS_TRAIN_MAX_RISK ?? 0.33),
    minRiskDelta: Number(process.env.VS_TRAIN_MIN_RISK_DELTA ?? 0),
    force,
    allowScorecard: !historyOnly,
    allowHistory: !scorecardOnly,
  });

  stopSpinner.update(1);
  if (training.updated && training.newPolicy) {
    stopSpinner("updated");
    console.log("Updated policy:", training.newPolicy);
  } else {
    stopSpinner("no update");
    console.log("No policy update:", training.reason);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
