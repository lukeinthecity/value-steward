import "dotenv/config";
import fs from "fs";
import path from "path";

import {
  assertMatchingCycleIds,
  extractLatestOrderFromPortfolioSnapshot,
  getArtifactCycleId,
  loadLatestTickSnapshot,
  loadLatestTrainingEntry,
  loadPolicySnapshot,
  loadPortfolioLiveSnapshot,
} from "../core/runtimeArtifacts.js";
import { getPhase1StartDate, isWithinPhase1Window } from "../core/phase1Window.js";
import { loadStateSync } from "../core/stewardState.js";
import { getExchangeDateString } from "../core/timeUtils.js";
import { sendLessonEmail } from "../core/emailNotifications.js";
import { markEodEmailSent } from "../core/stewardState.js";
import {
  loadIntentLog,
  summarizeDecisionsForExchangeDate,
} from "../core/decisionReview.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import { startSpinner } from "../world/spinner.js";
import { buildDailyPromotionSnapshot } from "../core/promotionMetrics.js";

const SCORECARD_PATH = path.join(process.cwd(), "data", "signal-scorecard.jsonl");

function getTradingDays(state) {
  if (!fs.existsSync(SCORECARD_PATH)) return 0;
  const raw = fs.readFileSync(SCORECARD_PATH, "utf8").trim();
  const lines = raw.split("\n").filter(Boolean);
  const dates = new Set();
  lines.forEach((line) => {
    try {
      const entry = JSON.parse(line);
      const candidate = entry.entry_date ?? entry.timestamp ?? null;
      if (!isWithinPhase1Window(candidate, { state })) {
        return;
      }
      if (entry.entry_date) {
        dates.add(entry.entry_date);
      } else if (entry.timestamp) {
        const startDate = getPhase1StartDate({ state });
        const exchangeDate = getExchangeDateString(new Date(entry.timestamp));
        if (!startDate || exchangeDate >= startDate) {
          dates.add(exchangeDate);
        }
      }
    } catch {
      // Ignore invalid lines.
    }
  });
  return dates.size;
}

function requireCurrentExchangeDate(label, value) {
  const exchangeDate = getExchangeDateString(new Date());
  const candidate = value ? getExchangeDateString(new Date(value)) : null;
  if (!candidate || candidate !== exchangeDate) {
    throw new Error(`${label} is missing or stale for exchange date ${exchangeDate}.`);
  }
}

function resolveReportExchangeDate(tickSnapshot, worldContext) {
  return (
    tickSnapshot?.exchange_date ??
    worldContext?.date ??
    getExchangeDateString(new Date())
  );
}

function requireSameCycleArtifacts({ tickSnapshot, portfolio, worldContext }) {
  const cycleCheck = assertMatchingCycleIds([
    { label: "tick", cycleId: getArtifactCycleId(tickSnapshot) },
    { label: "portfolio", cycleId: getArtifactCycleId(portfolio) },
    { label: "world", cycleId: getArtifactCycleId(worldContext) },
  ]);
  if (!cycleCheck.ok) {
    const mismatchSummary = cycleCheck.mismatches
      .map((entry) => `${entry.label}=${entry.cycleId}`)
      .join(", ");
    throw new Error(
      `Artifact cycle mismatch for EOD. expected=${cycleCheck.expectedCycleId} mismatches=${mismatchSummary}`
    );
  }
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSnapshotResult({ portfolio, tickSnapshot, policy }) {
  const account = portfolio?.account ?? {};
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const grossExposure = positions.reduce((sum, position) => {
    return sum + Math.abs(parseNumber(position.market_value ?? position.marketValue) ?? 0);
  }, 0);
  const netExposure = positions.reduce((sum, position) => {
    return sum + (parseNumber(position.market_value ?? position.marketValue) ?? 0);
  }, 0);

  return {
    ranAt: portfolio?.updated_at ?? tickSnapshot?.result?.ranAt ?? new Date().toISOString(),
    marketOpen: portfolio?.clock?.is_open ?? tickSnapshot?.result?.marketOpen ?? false,
    equity:
      parseNumber(account.equity) ??
      parseNumber(portfolio?.snapshot?.equity) ??
      parseNumber(tickSnapshot?.result?.equity) ??
      0,
    buyingPower:
      parseNumber(account.buying_power) ??
      parseNumber(tickSnapshot?.result?.buyingPower) ??
      0,
    numPositions: positions.length,
    grossExposure,
    netExposure,
    downtimeSeconds: tickSnapshot?.result?.downtimeSeconds ?? null,
    tradeGate: tickSnapshot?.result?.tradeGate ?? {
      mode: tickSnapshot?.result?.agentMode ?? policy?.mode ?? null,
      canTrade: null,
      tradingEnabled: null,
      forceNoTrade: null,
      internetOk: null,
      brokerOk: null,
    },
    agentMode: tickSnapshot?.result?.agentMode ?? null,
  };
}

function buildTrainingSummary(entry, policy) {
  if (!entry) {
    return {
      updated: false,
      reason: "no_training_record_for_today",
      equityDelta: null,
      oldRisk: policy?.risk_level ?? null,
      newRisk: policy?.risk_level ?? null,
      metrics: null,
    };
  }

  return {
    updated: entry.decision === "update",
    reason: entry.reason ?? "unknown",
    equityDelta: entry.equityDelta ?? null,
    oldRisk: entry.oldRisk ?? policy?.risk_level ?? null,
    newRisk: entry.newRisk ?? policy?.risk_level ?? null,
    metrics: entry.metrics ?? null,
  };
}

async function main() {
  const stopSpinner = startSpinner("generating eod email", { total: 3 });
  const state = loadStateSync();
  const policy = loadPolicySnapshot();
  if (!policy) {
    throw new Error("Policy snapshot unavailable.");
  }
  const tickSnapshot = loadLatestTickSnapshot();
  if (!tickSnapshot?.result) {
    throw new Error("Latest tick snapshot unavailable.");
  }
  requireCurrentExchangeDate("Latest tick snapshot", tickSnapshot.result.ranAt);

  const portfolio = loadPortfolioLiveSnapshot();
  if (!portfolio) {
    throw new Error("Portfolio refresh artifact unavailable.");
  }
  requireCurrentExchangeDate("Portfolio refresh artifact", portfolio.updated_at);

  const latestTrainingEntry = loadLatestTrainingEntry();
  const trainingEntry =
    latestTrainingEntry?.ranAt &&
    getExchangeDateString(new Date(latestTrainingEntry.ranAt)) ===
      getExchangeDateString(new Date())
      ? latestTrainingEntry
      : null;
  const worldContext = await loadLatestWorldContext();
  requireCurrentExchangeDate("World context", worldContext?.generated_at);
  requireSameCycleArtifacts({ tickSnapshot, portfolio, worldContext });
  const reportExchangeDate = resolveReportExchangeDate(tickSnapshot, worldContext);
  const tradingDays = getTradingDays(state);
  
  stopSpinner.update(1);

  const result = buildSnapshotResult({ portfolio, tickSnapshot, policy });
  const lastOrder =
    extractLatestOrderFromPortfolioSnapshot(portfolio, {
      exchangeDate: reportExchangeDate,
      requireExecuted: true,
    }) ??
    extractLatestOrderFromPortfolioSnapshot(portfolio, {
      exchangeDate: reportExchangeDate,
      requireExecuted: false,
    });
  const decisionReview = summarizeDecisionsForExchangeDate(
    loadIntentLog(),
    reportExchangeDate,
    {
      portfolio,
    }
  );
  const training = buildTrainingSummary(trainingEntry, policy);
  const promotion = await buildDailyPromotionSnapshot({
    state,
    policy,
    tickSnapshot,
    portfolio,
    worldContext,
    trainingEntry,
  });

  stopSpinner.update(2);

  await sendLessonEmail({
    policy,
    result,
    training,
    worldContext,
    promotion,
    emailMode: "summary",
    lastOrder,
    decisionReview,
    tradingDays
  });
  await markEodEmailSent();
  
  stopSpinner.update(3);
  stopSpinner("complete");

  console.log(`[ValueSteward] Real EOD report dispatched for ${result.equity.toFixed(2)} equity.`);
}

main().catch((err) => {
  console.error("[ValueSteward] EOD email failed:", err?.message ?? err);
  process.exit(1);
});
