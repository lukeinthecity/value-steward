export function getTradingEnabled() {
  const flag = process.env.TRADING_ENABLED;
  if (!flag) return false;
  return String(flag).toLowerCase() === "true";
}
