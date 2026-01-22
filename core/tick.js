import Alpaca from "@alpacahq/alpaca-trade-api";
import { runValueSteward } from "./runValueSteward.js";
import { loadJsonFile, appendJsonl } from "./githubFiles.js";

const POLICY_PATH = "config/policy.json";
const HISTORY_PATH = "data/history.jsonl";

export async function runTick({ alpacaConfig, githubToken }) {
  const alpaca = new Alpaca(alpacaConfig);

  const { content: policy } = await loadJsonFile({
    token: githubToken,
    path: POLICY_PATH,
    defaultValue: {
      version: 1,
      mode: "read-only",
      risk_level: 0.5,
      max_positions: 3,
      rebalance_threshold: 0.02,
      lastTrainedAt: null,
      lastEquityDelta: 0,
    },
  });

  const result = await runValueSteward({ alpaca, policy });

  const historyEntry = {
    ...result,
    policyVersion: policy.version,
  };

  await appendJsonl({
    token: githubToken,
    path: HISTORY_PATH,
    entry: historyEntry,
  });

  return { policy, result };
}
