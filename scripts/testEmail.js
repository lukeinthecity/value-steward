import "dotenv/config";

import { sendLessonEmail } from "../core/emailNotifications.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";

async function main() {
  const policy = {
    version: 999,
    mode: "read-only",
    risk_level: 0.2,
  };

  const result = {
    ranAt: new Date().toISOString(),
    marketOpen: false,
    equity: 100000,
    buyingPower: 200000,
    numPositions: 0,
    grossExposure: 0,
    netExposure: 0,
  };

  const training = {
    updated: true,
    reason: "manual_email_test",
    equityDelta: 0,
    oldRisk: policy.risk_level,
    newRisk: policy.risk_level,
    metrics: {
      sampleCount: 0,
      equityReturn: 0,
      equityVolatility: 0,
      maxDrawdown: 0,
      avgCashUtilization: 0,
      isUnderinvested: true,
      isOverconcentrated: false,
    },
  };

  const worldContext = await loadLatestWorldContext();

  await sendLessonEmail({
    policy,
    result,
    training,
    worldContext,
  });

  console.log("[ValueSteward] Test email requested.");
}

main().catch((err) => {
  console.error("[ValueSteward] Test email failed:", err?.message ?? err);
  process.exit(1);
});
