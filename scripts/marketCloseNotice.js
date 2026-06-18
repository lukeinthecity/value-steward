import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { buildHealthSnapshot } from "../core/healthStatus.js";
import { loadStateSync } from "../core/stewardState.js";
import { loadPortfolioLiveSnapshot } from "../core/runtimeArtifacts.js";
import { isTradingDay } from "../core/timeUtils.js";
import { maybeSendSessionOff } from "../core/pushTriggers.js";

async function main() {
  const now = new Date();
  const force = process.argv.includes("--force");
  if (!isTradingDay(now) && !force) {
    console.log("[notify] not a trading day; skipping session-off notice.");
    return;
  }

  const snapshot = await buildHealthSnapshot();
  const state = loadStateSync();
  const portfolio = loadPortfolioLiveSnapshot();

  const res = await maybeSendSessionOff({ snapshot, state, portfolio, now });
  console.log(`[notify] session-off notice: ${res.reason}`);
}

// Only run when executed directly (cron/CLI), never on import.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[notify] session-off notice failed:", err?.message ?? err);
    process.exit(1);
  });
}
