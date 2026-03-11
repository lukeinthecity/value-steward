import "dotenv/config";
import fs from "fs";
import path from "path";

import { sendLessonEmail } from "../core/emailNotifications.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import { startSpinner } from "../world/spinner.js";

const HISTORY_PATH = path.join(process.cwd(), "data", "history.jsonl");
const POLICY_PATH = path.join(process.cwd(), "config", "policy.json");
const SCORECARD_PATH = path.join(process.cwd(), "data", "signal-scorecard.jsonl");

function loadLatestJsonl(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;
  const lines = raw.split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function getTradingDays() {
    if (!fs.existsSync(SCORECARD_PATH)) return 0;
    const raw = fs.readFileSync(SCORECARD_PATH, "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    const dates = new Set();
    lines.forEach(l => {
        try {
            const d = JSON.parse(l);
            if (d.timestamp) dates.add(d.timestamp.slice(0, 10));
        } catch(e) {
            // Ignore invalid lines
        }
    });
    return dates.size;
}

async function main() {
  const stopSpinner = startSpinner("generating eod email", { total: 3 });
  
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
  const history = loadLatestJsonl(HISTORY_PATH);
  const worldContext = await loadLatestWorldContext();
  const tradingDays = getTradingDays();
  
  stopSpinner.update(1);

  // Result object for the email template
  const result = {
    ranAt: new Date().toISOString(),
    marketOpen: false,
    equity: history?.equity || 0,
    buyingPower: history?.buyingPower || 0,
    numPositions: history?.positions?.length || 0,
    grossExposure: history?.grossExposure || 0,
    netExposure: history?.netExposure || 0,
    downtimeSeconds: history?.downtimeSeconds || 0,
    tradeGate: {
        mode: policy.mode,
        canTrade: true,
        tradingEnabled: true
    }
  };

  // Training summary (we use defaults if no training occurred today)
  const training = {
    updated: false,
    reason: "daily_rebalance",
    equityDelta: 0,
    oldRisk: policy.risk_level,
    newRisk: policy.risk_level,
    metrics: {
      sampleCount: history?.positions?.length || 0,
      isUnderinvested: (history?.grossExposure / history?.equity) < (policy.target_risk_exposure_pct_low || 0.2),
    },
  };

  stopSpinner.update(2);

  await sendLessonEmail({
    policy,
    result,
    training,
    worldContext,
    emailMode: "summary",
    tradingDays
  });
  
  stopSpinner.update(3);
  stopSpinner("complete");

  console.log(`[ValueSteward] Real EOD report dispatched for ${result.equity.toFixed(2)} equity.`);
}

main().catch((err) => {
  console.error("[ValueSteward] EOD email failed:", err?.message ?? err);
  process.exit(1);
});
