import "dotenv/config";
import Alpaca from "@alpacahq/alpaca-trade-api";
import { runTick } from "../core/tick.js";
import { trainPolicyFromHistoryLocal } from "../core/localTrainer.js";
import {
  sendHealthEmail,
  sendLessonEmail,
  sendPhaseCheckpointEmail,
} from "../core/emailNotifications.js";
import {
  buildHealthSnapshot,
  buildPhase1Status,
  shouldSendHealthEmail,
  shouldSendPhaseEmail,
} from "../core/healthStatus.js";
import { loadState } from "../core/stewardState.js";
import { isWithinPreCloseWindow } from "../core/timeUtils.js";

async function main() {
  const alpacaConfig = {
    keyId: process.env.ALPACA_API_KEY_ID,
    secretKey: process.env.ALPACA_SECRET_KEY,
    paper: true,
  };

  const alpaca = new Alpaca(alpacaConfig);
  const clock = await alpaca.getClock();
  const marketOpen = clock.is_open;

  // 1. Tick
  const { policy, result } = await runTick({
    alpacaConfig,
    marketOpen,
    clock,
  });

  // 2. Local Training (Post-Tick)
  const training = await trainPolicyFromHistoryLocal({
    policy,
    tickResult: result,
  });

  // 3. Status & Notifications
  const state = await loadState();
  const health = await buildHealthSnapshot({
    agentState: state,
    policy,
    worldContext: result.worldContext,
  });

  const healthCheck = shouldSendHealthEmail({ agentState: state, snapshot: health });
  if (healthCheck.send) {
    await sendHealthEmail({ health, reason: healthCheck.reason });
  }

  // Phase 1 Progress
  const phase = buildPhase1Status();
  
  const isFinalTick = isWithinPreCloseWindow(5, new Date());
  if (training.updated && isFinalTick) {
    await sendLessonEmail({
      policy,
      result,
      training,
      worldContext: result.worldContext,
      tradingDays: phase.trading_days,
    });
  }
  const phaseCheck = shouldSendPhaseEmail({
    agentState: state,
    phase,
    isFinalDecision: true,
  });
  if (phaseCheck.send) {
    await sendPhaseCheckpointEmail({
      phase,
      exchangeDate: health.exchange_date,
    });
  }

  const worldAgeMinutes = health.world?.age_hours ? health.world.age_hours * 60 : null;

  console.log(
    `[local:tick] complete. mode=${result.agentMode} equity=${result.equity} ` +
      `positions=${result.numPositions} worldContextAgeMinutes=${
        typeof worldAgeMinutes === "number" ? Number(worldAgeMinutes.toFixed(2)) : null
      }`
  );
}

main().catch((err) => {
  console.error("Fatal error in local tick:", err?.stack ?? err);
  process.exit(1);
});
