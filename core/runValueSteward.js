export async function runValueSteward({ alpaca, policy }) {
  const now = new Date().toISOString();

  // 1. Read account info from Alpaca (READ-ONLY)
  const account = await alpaca.getAccount();

  const equityParsed = parseFloat(account.equity);
  const buyingPowerParsed = parseFloat(account.buying_power);
  const equityNum = Number.isNaN(equityParsed) ? null : equityParsed;
  const buyingPowerNum = Number.isNaN(buyingPowerParsed) ? null : buyingPowerParsed;
  const cashParsed = account.cash ? parseFloat(account.cash) : NaN;
  const cash = Number.isNaN(cashParsed) ? null : cashParsed;
  const portfolioParsed = account.portfolio_value
    ? parseFloat(account.portfolio_value)
    : equityParsed;
  const portfolioValue = Number.isNaN(portfolioParsed) ? null : portfolioParsed;
  const patternDayTrader =
    typeof account.pattern_day_trader === "boolean"
      ? account.pattern_day_trader
      : null;
  const marginMultiplier = account.multiplier
    ? parseFloat(account.multiplier)
    : null;

  const positionsSummary = [];
  let numPositions = 0;
  let longMarketValue = 0;
  let shortMarketValue = 0;

  try {
    const positions = await alpaca.getPositions();
    numPositions = positions.length;

    for (const pos of positions) {
      const mv = parseFloat(pos.market_value ?? "0");
      const qty = parseFloat(pos.qty ?? "0");
      if (Number.isNaN(mv) || Number.isNaN(qty)) continue;

      const avgEntryPrice = parseFloat(pos.avg_entry_price ?? "0");
      const unrealizedPl = parseFloat(pos.unrealized_pl ?? "0");
      const unrealizedPlPc = parseFloat(pos.unrealized_plpc ?? "0");
      const side = qty >= 0 ? "long" : "short";
      positionsSummary.push({
        symbol: pos.symbol,
        qty,
        side,
        marketValue: mv,
        avgEntryPrice: Number.isNaN(avgEntryPrice) ? null : avgEntryPrice,
        unrealizedPl: Number.isNaN(unrealizedPl) ? null : unrealizedPl,
        unrealizedPlPc: Number.isNaN(unrealizedPlPc) ? null : unrealizedPlPc,
        assetClass: pos.asset_class ?? null,
      });

      if (qty > 0) {
        longMarketValue += mv;
      } else if (qty < 0) {
        shortMarketValue += Math.abs(mv);
      }
    }
  } catch (err) {
    console.error("Error fetching positions:", err?.message ?? err);
  }

  let isMarketOpen = null;
  let nextOpen = null;
  let nextClose = null;

  try {
    const clock = await alpaca.getClock();
    isMarketOpen = !!clock.is_open;
    nextOpen = clock.next_open ?? null;
    nextClose = clock.next_close ?? null;
  } catch (err) {
    console.error("Error fetching clock:", err?.message ?? err);
  }

  const equityToBuyingPower =
    buyingPowerNum && buyingPowerNum > 0 && equityNum !== null
      ? equityNum / buyingPowerNum
      : null;

  let cashUtilization = null;
  if (equityNum && equityNum > 0 && buyingPowerNum !== null) {
    const raw = 1 - buyingPowerNum / equityNum;
    cashUtilization = Math.max(0, Math.min(1, raw));
  }

  const targetCashFraction = 1 - policy.risk_level;
  const grossExposure = longMarketValue + shortMarketValue;
  const netExposure = longMarketValue - shortMarketValue;
  const maxPositionWeight =
    portfolioValue !== null &&
    portfolioValue > 0 &&
    positionsSummary.length > 0
      ? Math.max(
          ...positionsSummary.map((pos) =>
            Math.abs(pos.marketValue) / portfolioValue
          )
        )
      : null;
  const worldContext = { summary: null, tags: [], sources: [] };

  const result = {
    ranAt: now,
    accountStatus: account.status,
    equity: equityNum,
    buyingPower: buyingPowerNum,
    cash,
    portfolioValue,
    patternDayTrader,
    marginMultiplier: Number.isNaN(marginMultiplier) ? null : marginMultiplier,
    mode: policy.mode,
    risk_level: policy.risk_level,
    targetCashFraction,
    equityToBuyingPower,
    cashUtilization,
    numPositions,
    longMarketValue,
    shortMarketValue,
    grossExposure,
    netExposure,
    maxPositionWeight,
    positions: positionsSummary,
    isMarketOpen,
    nextOpen,
    nextClose,
    worldContext,
  };

  return result;
}
