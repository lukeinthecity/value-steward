const DEFAULT_POLICY_CAPS = Object.freeze({
  max_effective_capital_dollars: 20,
  max_trade_notional_dollars: 5,
  min_trade_notional_dollars: 1,
});

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizePolicySnapshot(policy) {
  const base =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? policy
      : {};

  return {
    ...base,
    max_effective_capital_dollars: normalizePositiveNumber(
      base.max_effective_capital_dollars,
      DEFAULT_POLICY_CAPS.max_effective_capital_dollars,
    ),
    max_trade_notional_dollars: normalizePositiveNumber(
      base.max_trade_notional_dollars,
      DEFAULT_POLICY_CAPS.max_trade_notional_dollars,
    ),
    min_trade_notional_dollars: normalizePositiveNumber(
      base.min_trade_notional_dollars,
      DEFAULT_POLICY_CAPS.min_trade_notional_dollars,
    ),
  };
}

export { DEFAULT_POLICY_CAPS };
