export async function runValueSteward({ alpaca, policy }) {
  const now = new Date().toISOString();

  // 1. Read account info from Alpaca (READ-ONLY)
  const account = await alpaca.getAccount();

  const equityNum = parseFloat(account.equity);
  const buyingPowerNum = parseFloat(account.buying_power);

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
    buyingPowerNum > 0 ? equityNum / buyingPowerNum : null;

  let cashUtilization = null;
  if (equityNum > 0) {
    const raw = 1 - buyingPowerNum / equityNum;
    cashUtilization = Math.max(0, Math.min(1, raw));
  }

  const targetCashFraction = 1 - policy.risk_level;

  const result = {
    ranAt: now,
    accountStatus: account.status,
    equity: equityNum,
    buyingPower: buyingPowerNum,
    mode: policy.mode,
    risk_level: policy.risk_level,
    targetCashFraction,
    numPositions,
    longMarketValue,
    shortMarketValue,
    isMarketOpen,
    nextOpen,
    nextClose,
    equityToBuyingPower,
    cashUtilization,
  };

  return result;
}
