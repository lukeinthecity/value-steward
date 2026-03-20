import { trainPolicyFromHistoryLocal } from "../core/localTrainer.js";
import { startSpinner } from "../world/spinner.js";

async function main() {
  const stopSpinner = startSpinner("train policy", { total: 1 });
  const force = process.argv.includes("--force");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
