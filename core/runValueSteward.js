export async function runValueSteward({ alpaca, policy }) {
  const now = new Date().toISOString();

  // 1. Read account info from Alpaca (READ-ONLY)
  const account = await alpaca.getAccount();

  // 2. (Optional) stub for future: fetch quotes, positions, etc.
  // e.g., const clock = await alpaca.getClock();

  const equityNum = parseFloat(account.equity);
  const buyingPowerNum = parseFloat(account.buying_power);
  const targetCashFraction = 1 - policy.risk_level;

  const result = {
    ranAt: now,
    accountStatus: account.status,
    equity: equityNum,
    buyingPower: buyingPowerNum,
    mode: policy.mode,
    risk_level: policy.risk_level,
    targetCashFraction,
  };

  return result;
}
