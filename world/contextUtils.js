export const REQUIRED_TAGS = [
  "macro_risk",
  "rate_hawkishness",
  "geopolitical_tension",
  "energy_shock_risk",
  "recession_fear",
];

export function validateContext(entry) {
  if (!/\d{4}-\d{2}-\d{2}/.test(entry.date)) return false;
  if (!entry.generated_at) return false;
  if (!entry.tags) return false;
  for (const tag of REQUIRED_TAGS) {
    if (!(tag in entry.tags)) return false;
  }
  if (!Array.isArray(entry.sources_used)) return false;
  if (typeof entry.raw_count !== "number") return false;
  if (!Array.isArray(entry.errors)) return false;
  return true;
}

export function filterRecent(entries, cutoffMs) {
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoffMs;
  });
}
