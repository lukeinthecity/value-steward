import { evaluateHistoryMetrics } from "./evalMetrics.js";

export function trainPolicyWithMetrics({
  history,
  policy,
  minHistory = 10,
  equityDeltaThreshold = 0,
  maxStep = 0.01,
  minRisk = 0.1,
  maxRisk = 0.9,
}) {
  if (policy.mode !== "read-only") {
    return { updated: false, reason: "non_read_only_mode" };
  }

  if (!history.length) {
    return { updated: false, reason: "no_history" };
  }

  if (history.length < minHistory) {
    return { updated: false, reason: "not_enough_history", count: history.length };
  }

  const metrics = evaluateHistoryMetrics(history);
  if (metrics.equityFirst === null || metrics.equityLast === null) {
    return { updated: false, reason: "not_enough_equity_points" };
  }

  const equityDelta = metrics.equityLast - metrics.equityFirst;
  if (Math.abs(equityDelta) <= equityDeltaThreshold) {
    return { updated: false, reason: "equity_delta_small", metrics, equityDelta };
  }

  let direction = 0;
  if (metrics.isUptrend && !metrics.isHighVol && !metrics.isOverconcentrated) {
    direction += 1;
  }
  if (metrics.isDowntrend || metrics.isHighVol || (metrics.maxDrawdown ?? 0) > 0.1) {
    direction -= 1;
  }
  if (
    metrics.isUptrend &&
    !metrics.isHighVol &&
    metrics.avgCashUtilization !== null &&
    metrics.avgCashUtilization < 0.3
  ) {
    direction += 1;
  }
  if (metrics.isOverconcentrated && (!metrics.isUptrend || metrics.isHighVol)) {
    direction -= 1;
  }

  if (direction === 0) {
    return { updated: false, reason: "no_strong_signal", metrics };
  }

  const baseStep = maxStep;
  const strength = Math.min(1, Math.abs(metrics.equityReturn ?? 0) / 0.1);
  let step = direction * baseStep * strength;

  if (metrics.equityVolatility !== null && metrics.equityVolatility > 0.03) {
    step *= 0.5;
  }

  const oldRisk = policy.risk_level ?? 0.5;
  let newRisk = oldRisk + step;
  newRisk = Math.max(minRisk, Math.min(maxRisk, newRisk));

  if (newRisk === oldRisk) {
    return { updated: false, reason: "risk_clamped", metrics, equityDelta };
  }

  const newPolicy = {
    ...policy,
    version: (policy.version ?? 1) + 1,
    risk_level: newRisk,
    lastTrainedAt: new Date().toISOString(),
    lastEquityDelta: equityDelta,
    lastMetricsSummary: {
      sampleCount: metrics.sampleCount,
      equityReturn: metrics.equityReturn,
      equityVolatility: metrics.equityVolatility,
      maxDrawdown: metrics.maxDrawdown,
      avgCashUtilization: metrics.avgCashUtilization,
      avgGrossExposureRatio: metrics.avgGrossExposureRatio,
      avgMaxPositionWeight: metrics.avgMaxPositionWeight,
    },
    lastTrainingReason: "update",
  };

  return {
    updated: true,
    oldRisk,
    newRisk,
    equityDelta,
    policyVersion: newPolicy.version,
    metrics,
    newPolicy,
  };
}
