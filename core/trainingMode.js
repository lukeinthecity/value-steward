function parseAllowedModes() {
  const raw = String(
    process.env.VS_TRAIN_ALLOWED_POLICY_MODES ?? "read-only,rebalance"
  );
  const values = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return new Set(values.length ? values : ["read-only", "rebalance"]);
}

export function isTrainingModeAllowed(policyMode) {
  const normalized = String(policyMode ?? "").trim().toLowerCase();
  return parseAllowedModes().has(normalized);
}
