import { trainPolicyFromHistoryLocal } from "../core/localTrainer.js";

async function main() {
  const training = trainPolicyFromHistoryLocal({
    minHistory: 10,
    equityDeltaThreshold: 0,
    maxStep: 0.01,
    minRisk: 0.1,
    maxRisk: 0.9,
  });

  if (training.updated && training.newPolicy) {
    console.log("Updated policy:", training.newPolicy);
  } else {
    console.log("No policy update:", training.reason);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
