export async function runValueSteward({ alpaca, github }) {
  const now = new Date().toISOString();

  // 1. Read Alpaca account (READ-ONLY)
  const account = await alpaca.getAccount();

  // 2. Construct a diagnostic snapshot
  const result = {
    ranAt: now,
    accountStatus: account.status,
    equity: account.equity,
    buyingPower: account.buying_power,
    mode: "read-only",
  };

  // 3. Return structured result
  return result;
}
