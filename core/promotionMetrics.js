import fs from "fs";
import path from "path";

import { buildHealthSnapshot } from "./healthStatus.js";
import { filterPhase1Records } from "./phase1Window.js";
import { loadStateSync } from "./stewardState.js";
import {
  loadLatestTickSnapshot,
  loadLatestTrainingEntry,
  loadPolicySnapshot,
  loadPortfolioLiveSnapshot,
} from "./runtimeArtifacts.js";
import { getExchangeDateString } from "./timeUtils.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";

const SCORECARD_PATH = path.join(
  process.cwd(),
  "data",
  "signal-scorecard.jsonl",
);
const INTENT_LOG_PATH = path.join(process.cwd(), "logs", "intent_log.jsonl");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function uniqueExchangeDays(records) {
  return new Set(
    records
      .map(
        (record) =>
          record.entry_date ?? record.timestamp ?? record.generated_at ?? null,
      )
      .map((value) => (value ? getExchangeDateString(new Date(value)) : null))
      .filter(Boolean),
  );
}

function countIssueLevels(issues = []) {
  return issues.reduce(
    (acc, issue) => {
      const level = issue?.level === "error" ? "error" : "warn";
      acc[level] += 1;
      return acc;
    },
    { warn: 0, error: 0 },
  );
}

function currentCapSettings(policy = {}) {
  const maxEffective = parseNumber(
    policy.max_effective_capital_dollars ??
      process.env.MAX_EFFECTIVE_CAPITAL_DOLLARS ??
      20,
  );
  const maxTrade = parseNumber(
    policy.max_trade_notional_dollars ??
      process.env.MAX_TRADE_NOTIONAL_DOLLARS ??
      5,
  );
  const minTrade = parseNumber(
    policy.min_trade_notional_dollars ??
      process.env.MIN_TRADE_NOTIONAL_DOLLARS ??
      1,
  );
  return {
    max_effective_capital_dollars: maxEffective ?? 20,
    max_trade_notional_dollars: maxTrade ?? 5,
    min_trade_notional_dollars: minTrade ?? 1,
  };
}

function buildCapCompliance({ portfolio, policy }) {
  const caps = currentCapSettings(policy);
  const positions = Array.isArray(portfolio?.positions)
    ? portfolio.positions
    : [];
  const tolerance = Number(
    process.env.VS_POSITION_CAP_TOLERANCE_MULTIPLIER ?? 1.25,
  );
  const totalDeployed = positions.reduce((sum, position) => {
    const marketValue = Math.abs(
      parseNumber(position.market_value ?? position.marketValue) ?? 0,
    );
    return sum + marketValue;
  }, 0);
  const oversizedPositions = positions
    .map((position) => ({
      symbol: position.symbol,
      market_value: Math.abs(
        parseNumber(position.market_value ?? position.marketValue) ?? 0,
      ),
    }))
    .filter(
      (position) =>
        position.market_value > caps.max_effective_capital_dollars * tolerance,
    );
  const maxPositionValue = positions.reduce((max, position) => {
    const marketValue = Math.abs(
      parseNumber(position.market_value ?? position.marketValue) ?? 0,
    );
    return Math.max(max, marketValue);
  }, 0);
  return {
    ...caps,
    total_deployed_dollars: totalDeployed,
    max_position_value: maxPositionValue,
    oversized_positions: oversizedPositions,
    oversized_count: oversizedPositions.length,
    total_deployed_over_cap:
      totalDeployed > caps.max_effective_capital_dollars + 0.01,
    pass:
      oversizedPositions.length === 0 &&
      totalDeployed <= caps.max_effective_capital_dollars + 0.01,
  };
}

function buildArtifactReconciliation({
  tickSnapshot,
  portfolio,
  worldContext,
  health,
}) {
  const tickPositions = Array.isArray(tickSnapshot?.result?.positions)
    ? tickSnapshot.result.positions.length
    : null;
  const portfolioPositions = Array.isArray(portfolio?.positions)
    ? portfolio.positions.length
    : null;
  const tickEquity = parseNumber(tickSnapshot?.result?.equity);
  const portfolioEquity = parseNumber(
    portfolio?.account?.equity ?? portfolio?.snapshot?.equity,
  );
  const worldDate =
    worldContext?.date ??
    (worldContext?.generated_at
      ? getExchangeDateString(new Date(worldContext.generated_at))
      : null);
  const exchangeDate =
    health?.exchange_date ?? getExchangeDateString(new Date());
  const tickArtifactComplete = tickPositions !== null && tickEquity !== null;
  const portfolioArtifactComplete =
    portfolioPositions !== null && portfolioEquity !== null;
  const sameWorldDate = worldDate !== null && worldDate === exchangeDate;
  const positionCountMatch =
    tickArtifactComplete &&
    portfolioArtifactComplete &&
    tickPositions === portfolioPositions;
  const equityDifference =
    !tickArtifactComplete || !portfolioArtifactComplete
      ? null
      : Math.abs(tickEquity - portfolioEquity);
  const equityMatch = equityDifference !== null && equityDifference <= 1.0;
  const blockers = [];
  if (!tickArtifactComplete) blockers.push("tick_snapshot_incomplete");
  if (!portfolioArtifactComplete)
    blockers.push("portfolio_snapshot_incomplete");
  if (worldDate === null) blockers.push("world_context_exchange_date_unknown");
  else if (!sameWorldDate)
    blockers.push("world_context_exchange_date_mismatch");
  if (
    tickArtifactComplete &&
    portfolioArtifactComplete &&
    !positionCountMatch
  ) {
    blockers.push("position_count_mismatch");
  }
  if (tickArtifactComplete && portfolioArtifactComplete && !equityMatch) {
    blockers.push("equity_mismatch");
  }
  return {
    exchange_date: exchangeDate,
    tick_artifact_complete: tickArtifactComplete,
    portfolio_artifact_complete: portfolioArtifactComplete,
    tick_position_count: tickPositions,
    portfolio_position_count: portfolioPositions,
    position_count_match: positionCountMatch,
    tick_equity: tickEquity,
    portfolio_equity: portfolioEquity,
    equity_difference: equityDifference,
    equity_match: equityMatch,
    world_date: worldDate,
    same_world_date: sameWorldDate,
    blockers,
    pass: blockers.length === 0,
  };
}

function determineStage(tradingDays) {
  if (tradingDays >= 60) return "scale_candidate";
  if (tradingDays >= 30) return "edge_validation";
  if (tradingDays >= 10) return "behavioral_competence";
  return "trust_build";
}

function determineVerdict({
  tradingDays,
  blockers,
  avgExcessBenchmark,
  avgExcessCash,
}) {
  if (blockers.length) {
    return "not_eligible";
  }
  if (
    tradingDays >= 60 &&
    ((avgExcessBenchmark ?? Number.NEGATIVE_INFINITY) > 0 ||
      (avgExcessCash ?? Number.NEGATIVE_INFINITY) > 0)
  ) {
    return "eligible_for_next_tier";
  }
  if (tradingDays >= 10) {
    return "watchlist";
  }
  return "not_eligible";
}

function computeWeeklyPerformance(records) {
  const oneDay = records
    .filter((record) => record?.horizons?.["1"])
    .map((record) => record.horizons["1"]);
  const avgExcessBenchmark = average(
    oneDay.map((horizon) => parseNumber(horizon.excess_vs_benchmark)),
  );
  const avgExcessCash = average(
    oneDay.map((horizon) => parseNumber(horizon.excess_vs_cash)),
  );
  const buyHorizons = records
    .filter(
      (record) =>
        ["BUY", "MULTI"].includes(record.action_type) &&
        record?.horizons?.["1"],
    )
    .map((record) => record.horizons["1"]);
  const buyHitRate = average(
    buyHorizons.map((horizon) =>
      typeof horizon.directional_correct === "boolean"
        ? Number(horizon.directional_correct)
        : NaN,
    ),
  );
  return {
    avg_excess_benchmark_1d: avgExcessBenchmark,
    avg_excess_cash_1d: avgExcessCash,
    buy_hit_rate_1d: buyHitRate,
  };
}

function buildHealthBlockers(issues = []) {
  return issues
    .map((issue) => issue?.code)
    .filter((code) => typeof code === "string" && code.length > 0)
    .map((code) => `health_${code}`);
}

function buildWeeklyBlockers({
  filteredRecords,
  filteredIntents,
  performance,
}) {
  const blockers = [];
  const staleGateCount = filteredIntents.filter(
    (intent) =>
      intent?.gate_world_context_fresh === false ||
      intent?.gate_signal_fresh === false ||
      intent?.reason_code === "WORLD_STALE" ||
      intent?.reason_code === "SIGNAL_STALE",
  ).length;

  if (!filteredRecords.length) {
    blockers.push("no_weekly_scorecard_records");
  }
  if (!filteredIntents.length) {
    blockers.push("no_weekly_intents");
  }
  if (staleGateCount > 0) {
    blockers.push("weekly_integrity_gate_failures");
  }
  if (
    performance.avg_excess_benchmark_1d !== null &&
    performance.avg_excess_cash_1d !== null &&
    performance.avg_excess_benchmark_1d < 0 &&
    performance.avg_excess_cash_1d < 0
  ) {
    blockers.push("negative_short_horizon_excess");
  }

  return blockers;
}

export async function buildDailyPromotionSnapshot({
  state,
  policy,
  tickSnapshot,
  portfolio,
  worldContext,
  trainingEntry,
} = {}) {
  const currentState = state ?? loadStateSync();
  const currentPolicy = policy ?? loadPolicySnapshot() ?? {};
  const currentTick = tickSnapshot ?? loadLatestTickSnapshot() ?? {};
  const currentPortfolio = portfolio ?? loadPortfolioLiveSnapshot() ?? {};
  const currentWorld = worldContext ?? (await loadLatestWorldContext());
  const currentTraining = trainingEntry ?? loadLatestTrainingEntry() ?? null;
  const health = await buildHealthSnapshot({
    agentState: currentState,
    policy: currentPolicy,
    worldContext: currentWorld,
  });
  const issueCounts = countIssueLevels(health.issues ?? []);
  const capCompliance = buildCapCompliance({
    portfolio: currentPortfolio,
    policy: currentPolicy,
  });
  const reconciliation = buildArtifactReconciliation({
    tickSnapshot: currentTick,
    portfolio: currentPortfolio,
    worldContext: currentWorld,
    health,
  });
  const blockers = [];
  if (!capCompliance.pass) blockers.push("cap_breach");
  blockers.push(...reconciliation.blockers);
  blockers.push(...buildHealthBlockers(health.issues ?? []));
  const stage = determineStage(health.scorecard?.trading_days ?? 0);
  const trainingStatus = {
    present: Boolean(currentTraining),
    reason: currentTraining?.reason ?? null,
    updated: currentTraining?.decision === "update",
    policy_version_before: currentTraining?.policyVersionBefore ?? null,
    policy_version_after:
      currentTraining?.policyVersionAfter ??
      currentTraining?.policyVersion ??
      null,
  };
  const verdict = determineVerdict({
    tradingDays: health.scorecard?.trading_days ?? 0,
    blockers,
    avgExcessBenchmark: parseNumber(
      health.scorecard?.horizons?.["1"]?.avg_excess_benchmark,
    ),
    avgExcessCash: parseNumber(
      health.scorecard?.horizons?.["1"]?.avg_excess_cash,
    ),
  });

  return {
    generated_at: new Date().toISOString(),
    exchange_date: health.exchange_date,
    stage,
    verdict,
    blockers,
    health_issue_counts: issueCounts,
    integrity: {
      pass: blockers.length === 0,
      issues: health.issues ?? [],
      issue_counts: issueCounts,
      controls: {
        trading_enabled: currentState.trading_enabled === true,
        force_no_trade: currentState.force_no_trade === true,
      },
    },
    cap_compliance: capCompliance,
    reconciliation,
    training: trainingStatus,
    progress: {
      trading_days: health.scorecard?.trading_days ?? 0,
      records: health.scorecard?.records ?? 0,
      phase1_start_date: health.scorecard?.phase1_start_date ?? null,
    },
  };
}

export function buildWeeklyPromotionSummary({
  records,
  intents,
  latestDailyPromotion,
} = {}) {
  const currentState = loadStateSync();
  const filteredRecords = filterPhase1Records(
    records ?? readJsonl(SCORECARD_PATH),
    {
      state: currentState,
    },
  );
  const filteredIntents = filterPhase1Records(
    intents ?? readJsonl(INTENT_LOG_PATH),
    {
      state: currentState,
    },
  );
  const performance = computeWeeklyPerformance(filteredRecords);
  const tradingDays = uniqueExchangeDays(filteredRecords).size;
  const totalBuys = filteredIntents.filter(
    (intent) => intent.action_type === "BUY",
  ).length;
  const totalSells = filteredIntents.filter(
    (intent) => intent.action_type === "SELL",
  ).length;
  const policyVersions = new Set(
    filteredIntents
      .map((intent) => intent.policy_version)
      .filter((value) => value !== null && value !== undefined),
  );
  const blockers = buildWeeklyBlockers({
    filteredRecords,
    filteredIntents,
    performance,
  });
  const currentBlockers = latestDailyPromotion?.blockers ?? [];
  const verdict = determineVerdict({
    tradingDays,
    blockers,
    avgExcessBenchmark: performance.avg_excess_benchmark_1d,
    avgExcessCash: performance.avg_excess_cash_1d,
  });
  return {
    stage: determineStage(tradingDays),
    verdict,
    blockers,
    current_blockers: currentBlockers,
    operational_score: Math.max(0, 100 - blockers.length * 25),
    decision_score:
      performance.avg_excess_benchmark_1d === null
        ? null
        : Number((50 + performance.avg_excess_benchmark_1d * 1000).toFixed(1)),
    learning_score: Math.max(
      0,
      100 - Math.max(policyVersions.size - 1, 0) * 20,
    ),
    risk_score: Math.max(0, 100 - blockers.length * 20),
    metrics: {
      trading_days: tradingDays,
      records: filteredRecords.length,
      total_buys: totalBuys,
      total_sells: totalSells,
      avg_excess_benchmark_1d: performance.avg_excess_benchmark_1d,
      avg_excess_cash_1d: performance.avg_excess_cash_1d,
      buy_hit_rate_1d: performance.buy_hit_rate_1d,
      policy_versions_seen: policyVersions.size,
    },
  };
}
