import { evaluateHistoryMetrics } from "./evalMetrics.js";
import { isTrainingModeAllowed } from "./trainingMode.js";

export function trainPolicyWithMetrics({
  history,
  policy,
  minHistory = 10,
  equityDeltaThreshold = 0,
  maxStep = 0.01,
  minRisk = 0.1,
  maxRisk = 0.9,
  minRiskDelta = 0,
}) {
  if (!isTrainingModeAllowed(policy.mode)) {
    return {
      updated: false,
      reason: "non_trainable_mode",
      equityDelta: null,
      oldRisk: policy.risk_level ?? 0.5,
      newRisk: policy.risk_level ?? 0.5,
      policyVersion: policy.version ?? 1,
      metrics: null,
    };
  }

  if (!history.length) {
    return {
      updated: false,
      reason: "no_history",
      equityDelta: null,
      oldRisk: policy.risk_level ?? 0.5,
      newRisk: policy.risk_level ?? 0.5,
      policyVersion: policy.version ?? 1,
      metrics: null,
    };
  }

  if (history.length < minHistory) {
    return {
      updated: false,
      reason: "not_enough_history",
      count: history.length,
      equityDelta: null,
      oldRisk: policy.risk_level ?? 0.5,
      newRisk: policy.risk_level ?? 0.5,
      policyVersion: policy.version ?? 1,
      metrics: null,
    };
  }

  const metrics = evaluateHistoryMetrics(history);
  if (metrics.equityFirst === null || metrics.equityLast === null) {
    return {
      updated: false,
      reason: "not_enough_equity_points",
      equityDelta: null,
      oldRisk: policy.risk_level ?? 0.5,
      newRisk: policy.risk_level ?? 0.5,
      policyVersion: policy.version ?? 1,
      metrics,
    };
  }

  const equityDelta = metrics.equityLast - metrics.equityFirst;
  if (Math.abs(equityDelta) <= equityDeltaThreshold) {
    return {
      updated: false,
      reason: "equity_delta_small",
      metrics,
      equityDelta,
      oldRisk: policy.risk_level ?? 0.5,
      newRisk: policy.risk_level ?? 0.5,
      policyVersion: policy.version ?? 1,
    };
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
    return {
      updated: false,
      reason: "no_strong_signal",
      metrics,
      equityDelta,
      oldRisk: policy.risk_level ?? 0.5,
      newRisk: policy.risk_level ?? 0.5,
      policyVersion: policy.version ?? 1,
    };
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

  if (Math.abs(newRisk - oldRisk) < minRiskDelta) {
    return {
      updated: false,
      reason: "risk_delta_small",
      metrics,
      equityDelta,
      oldRisk,
      newRisk: oldRisk,
      policyVersion: policy.version ?? 1,
    };
  }

  if (newRisk === oldRisk) {
    return {
      updated: false,
      reason: "risk_clamped",
      metrics,
      equityDelta,
      oldRisk,
      newRisk,
      policyVersion: policy.version ?? 1,
    };
  }

  const newPolicy = {
    ...policy,
    schema_version: policy.schema_version ?? 1,
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
    reason: "update",
    oldRisk,
    newRisk,
    equityDelta,
    policyVersion: newPolicy.version,
    metrics,
    newPolicy,
  };
}
