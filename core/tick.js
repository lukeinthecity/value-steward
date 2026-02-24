import Alpaca from "@alpacahq/alpaca-trade-api";
import { runValueSteward } from "./runValueSteward.js";
import { loadJsonFile, appendJsonl } from "./localFiles.js";
import { loadAgentState, saveAgentState, transitionMode } from "./agentState.js";
import { MODES } from "./modes.js";
import { computeCanTrade } from "./tradeGate.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import { validatePolicy } from "./policyValidator.js";

const POLICY_PATH = "config/policy.json";
const HISTORY_PATH = "data/history.jsonl";

export async function runTick({ alpacaConfig, marketOpen, clock }) {
  const alpaca = new Alpaca(alpacaConfig);
  const now = new Date().toISOString();
  const nowDate = new Date(now);
  const agentState = await loadAgentState();
  const lastRun = agentState.last_run_wall_clock
    ? Date.parse(agentState.last_run_wall_clock)
    : null;
  const downtimeSeconds =
    lastRun !== null ? Math.max(0, (Date.parse(now) - lastRun) / 1000) : null;
  const marketOpenFlag = typeof marketOpen === "boolean" ? marketOpen : false;
  const lastRunDate = lastRun !== null ? new Date(lastRun) : null;
  const exchangeTz = "America/New_York";
  const formatExchangeDate = (date) => {
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: exchangeTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return fmt.format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  };
  const todayExchange = formatExchangeDate(nowDate);
  const lastRunExchange = lastRunDate ? formatExchangeDate(lastRunDate) : null;

  let nextMode = agentState.current_mode || MODES.INACTIVE;
  let transitionReason = null;
  const recoveryThresholdSeconds = Number(
    process.env.VS_RECOVERY_DOWNTIME_SECONDS ?? 1800
  );

  if (!agentState.last_run_wall_clock) {
    nextMode = MODES.INACTIVE;
    transitionReason = "initial_boot";
    console.log(`[VS] boot @ ${now} mode=${nextMode}`);
  } else if (lastRunExchange && lastRunExchange !== todayExchange) {
    nextMode = MODES.CATCHUP;
    transitionReason = "new_trading_day";
  } else if (
    marketOpenFlag &&
    downtimeSeconds !== null &&
    downtimeSeconds > recoveryThresholdSeconds
  ) {
    nextMode = MODES.RECOVERY;
    transitionReason = "downtime_detected";
  } else {
    nextMode = MODES.LIVE;
    transitionReason = "normal";
  }

  if (nextMode !== agentState.current_mode) {
    await transitionMode({
      from: agentState.current_mode,
      to: nextMode,
      reason: transitionReason,
      now,
      state: agentState,
    });
    agentState.current_mode = nextMode;
    agentState.last_mode_transition_reason = transitionReason;
    agentState.status_indicator = nextMode;
  }

  const { content: policy } = await loadJsonFile({
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
  const policyValidation = validatePolicy(policy);
  if (!policyValidation.valid) {
    console.warn(
      `[VS] policy validation warnings: ${policyValidation.warnings.join("; ")}`
    );
  }

  const result = await runValueSteward({
    alpaca,
    policy,
    mode: agentState.current_mode,
    marketOpen,
    clock,
    nowOverride: now,
  });

  const worldContext =
    (await loadLatestWorldContext().catch((err) => {
      console.error(
        "[world] failed to load latest world context:",
        err?.message ?? err
      );
      return null;
    })) ?? null;

  const tradeGate = computeCanTrade({
    mode: agentState.current_mode,
    internetOk: true,
    brokerOk: true,
  });

  const tickResult = {
    ...result,
    downtimeSeconds,
    tradeGate,
    agentMode: agentState.current_mode,
    worldContext: worldContext ?? result.worldContext,
  };

  const historyEntry = {
    ...tickResult,
    policyVersion: policy.version,
  };

  await appendJsonl({
    path: HISTORY_PATH,
    entry: historyEntry,
  });

  agentState.last_run_wall_clock = now;
  agentState.last_market_timestamp = result.marketTimestamp;
  agentState.last_known_positions = result.positions || [];
  agentState.open_orders_snapshot = [];
  await saveAgentState(agentState);

  console.log(
    `[VS] tick @ ${now} mode=${agentState.current_mode} marketOpen=${marketOpenFlag} ` +
      `canTrade=${tradeGate.canTrade} tradingEnabled=${tradeGate.tradingEnabled} ` +
      `downtimeSeconds=${downtimeSeconds ?? "n/a"}`
  );

  return { policy, result: tickResult };
}
