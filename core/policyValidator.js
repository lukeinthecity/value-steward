const SUPPORTED_SCHEMA_VERSION = 1;

export function validatePolicy(policy) {
  const warnings = [];
  if (!policy || typeof policy !== "object") {
    return { valid: false, warnings: ["Policy must be an object."] };
  }

  const schemaVersion =
    typeof policy.schema_version === "number" ? policy.schema_version : 1;
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    warnings.push(
      `Unsupported schema_version=${schemaVersion}; expected ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }

  const percentKeys = [
    "risk_level",
    "target_risk_exposure_pct_low",
    "rebalance_buffer_pct",
  ];
  for (const key of percentKeys) {
    if (policy[key] === undefined || policy[key] === null) continue;
    if (typeof policy[key] !== "number" || policy[key] < 0 || policy[key] > 1) {
      warnings.push(`Invalid ${key}=${policy[key]}; expected 0..1.`);
    }
  }

  if (
    policy.trade_gate_overrides !== undefined &&
    policy.trade_gate_overrides !== null
  ) {
    if (typeof policy.trade_gate_overrides !== "object") {
      warnings.push("trade_gate_overrides must be an object.");
    } else if (
      "force_no_trade" in policy.trade_gate_overrides &&
      typeof policy.trade_gate_overrides.force_no_trade !== "boolean"
    ) {
      warnings.push("trade_gate_overrides.force_no_trade must be boolean.");
    }
  }

  return { valid: warnings.length === 0, warnings };
}
