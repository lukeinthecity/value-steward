export function evaluateHistoryMetrics(historyEntries) {
  const entries = Array.isArray(historyEntries) ? historyEntries : [];
  const equities = entries
    .map((h) => parseFloat(h.equity))
    .filter((n) => !Number.isNaN(n));

  const sampleCount = entries.length;
  const equityFirst = equities.length ? equities[0] : null;
  const equityLast = equities.length ? equities[equities.length - 1] : null;
  const equityReturn =
    equityFirst && equityLast && equityFirst !== 0
      ? (equityLast - equityFirst) / equityFirst
      : null;

  const returns = [];
  for (let i = 1; i < equities.length; i += 1) {
    const prev = equities[i - 1];
    const curr = equities[i];
    if (prev === 0) continue;
    returns.push((curr - prev) / prev);
  }

  const equityVolatility = returns.length >= 2 ? stdDev(returns) : null;

  let maxDrawdown = null;
  if (equities.length >= 2) {
    let peak = equities[0];
    let worst = 0;
    for (const value of equities) {
      if (value > peak) peak = value;
      if (peak > 0) {
        const drawdown = (value - peak) / peak;
        if (drawdown < worst) worst = drawdown;
      }
    }
    maxDrawdown = Math.abs(worst);
  }

  const avgCashUtilization = mean(
    entries
      .map((h) =>
        typeof h.cashUtilization === "number" ? h.cashUtilization : null,
      )
      .filter((n) => n !== null),
  );

  const avgGrossExposureRatio = mean(
    entries
      .map((h) => {
        const gross =
          typeof h.grossExposure === "number" ? h.grossExposure : null;
        const pv =
          typeof h.portfolioValue === "number" ? h.portfolioValue : null;
        if (gross === null || pv === null || pv === 0) return null;
        return gross / pv;
      })
      .filter((n) => n !== null),
  );

  const avgMaxPositionWeight = mean(
    entries
      .map((h) =>
        typeof h.maxPositionWeight === "number" ? h.maxPositionWeight : null,
      )
      .filter((n) => n !== null),
  );

  const isUptrend = equityReturn !== null ? equityReturn > 0 : false;
  const isDowntrend = equityReturn !== null ? equityReturn < 0 : false;
  const isHighVol = equityVolatility !== null ? equityVolatility > 0.03 : false;
  const isUnderinvested =
    avgCashUtilization !== null ? avgCashUtilization < 0.2 : false;
  const isOverconcentrated =
    avgMaxPositionWeight !== null ? avgMaxPositionWeight > 0.3 : false;

  return {
    sampleCount,
    equityFirst,
    equityLast,
    equityReturn,
    equityVolatility,
    maxDrawdown,
    avgCashUtilization,
    avgGrossExposureRatio,
    avgMaxPositionWeight,
    isUptrend,
    isDowntrend,
    isHighVol,
    isUnderinvested,
    isOverconcentrated,
  };
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
}

function stdDev(values) {
  if (values.length < 2) return null;
  const avg = values.reduce((acc, val) => acc + val, 0) / values.length;
  const variance =
    values.reduce((acc, val) => acc + (val - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
