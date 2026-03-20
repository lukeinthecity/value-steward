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
import { loadPolicySnapshot } from "../core/runtimeArtifacts.js";
import {
  loadState,
  markHealthEmailSent,
  markPhaseEmailSent,
} from "../core/stewardState.js";
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
  const { policy: tickPolicy, result } = await runTick({
    alpacaConfig,
    marketOpen,
    clock,
  });
  const isFinalTick = isWithinPreCloseWindow(5, new Date());
  const trainOnNonFinalTick = !["0", "false", "no", "off"].includes(
    String(process.env.VS_TRAIN_ON_NON_FINAL_TICK ?? "false").toLowerCase()
  );

  // 2. Local Training (Post-Tick)
  const training =
    isFinalTick || trainOnNonFinalTick
      ? await trainPolicyFromHistoryLocal({
          worldContext: result.worldContext,
        })
      : {
          updated: false,
          reason: "not_final_tick",
          oldRisk: tickPolicy?.risk_level ?? null,
          newRisk: tickPolicy?.risk_level ?? null,
          metrics: null,
        };
  const policy = loadPolicySnapshot() ?? tickPolicy;

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
    await markHealthEmailSent();
  }

  // Phase 1 Progress
  const phase = buildPhase1Status();

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
    isFinalDecision: isFinalTick,
  });
  if (phaseCheck.send) {
    await sendPhaseCheckpointEmail({
      phase,
      exchangeDate: health.exchange_date,
    });
    await markPhaseEmailSent({
      milestones: phaseCheck.milestones ?? [],
      ready: phaseCheck.reason === "ready",
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
