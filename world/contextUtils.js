// world/contextUtils.js

// Tags we expect on every world context entry
export const REQUIRED_TAGS = [
  "macro_risk",
  "rate_hawkishness",
  "geopolitical_tension",
  "energy_shock_risk",
  "recession_fear",
];

// ---- TIME ZONE HELPERS -----------------------------------------------------

/**
 * Determine the "world" time zone to use for worldContext.date.
 *
 * Priority:
 *   1. process.env.WORLD_TIMEZONE (explicit override, e.g. "America/New_York")
 *   2. Node / OS default time zone via Intl.DateTimeFormat
 *   3. Fallback to "UTC"
 */
export function getWorldTimeZone() {
  if (process.env.WORLD_TIMEZONE && typeof process.env.WORLD_TIMEZONE === "string") {
    return process.env.WORLD_TIMEZONE;
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === "string") return tz;
  } catch (err) {
    // ignore and fall through to UTC
  }

  return "UTC";
}

/**
 * Format a JS Date (or timestamp / ISO string) as `YYYY-MM-DD` in the
 * configured world time zone, *not* in UTC.
 *
 * This is what you should use for worldContext.date so that the trading
 * "calendar day" matches the system's local trading day (or WORLD_TIMEZONE).
 */
export function toWorldDateString(input) {
  const tz = getWorldTimeZone();
  const date = input instanceof Date ? input : new Date(input);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    if (p.type === "year" || p.type === "month" || p.type === "day") {
      map[p.type] = p.value;
    }
  }

  // en-CA gives us YYYY-MM-DD already; this just makes it explicit.
  return `${map.year}-${map.month}-${map.day}`;
}

// ---- CONTEXT VALIDATION / FILTERING ----------------------------------------

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

/**
 * Filter hydrated entries to those whose `ts` is newer than the cutoff.
 * `cutoffMs` is a numeric timestamp (Date.now() - window).
 */
export function filterRecent(entries, cutoffMs) {
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoffMs;
  });
}

// ---- MACRO CLASSIFICATION / SUMMARY ----------------------------------------

export function classifyMacroFromTags(tags) {
  if (!tags) {
    return {
      macro_score: null,
      macro_label: "n/a",
      inputs_used: [],
      null_count: REQUIRED_TAGS.length,
    };
  }

  const values = {};
  let nullCount = 0;

  for (const key of REQUIRED_TAGS) {
    const value = tags[key];
    if (value === null || value === undefined) {
      nullCount += 1;
      values[key] = 0;
    } else {
      values[key] = value;
    }
  }

  // Weighted macro score in [0,1]
  const macroScore = Math.max(
    0,
    Math.min(
      1,
      values.macro_risk * 0.4 +
        values.recession_fear * 0.3 +
        values.geopolitical_tension * 0.15 +
        values.energy_shock_risk * 0.15
    )
  );

  let macroLabel = "calm";
  if (macroScore >= 0.8) {
    macroLabel = "crisis-prone";
  } else if (macroScore >= 0.6) {
    macroLabel = "stressed";
  } else if (macroScore >= 0.3) {
    macroLabel = "watchful";
  }

  const inputsUsed = REQUIRED_TAGS.filter(
    (key) => tags[key] !== null && tags[key] !== undefined
  );

  return {
    macro_score: macroScore,
    macro_label: macroLabel,
    inputs_used: inputsUsed,
    null_count: nullCount,
  };
}

/**
 * One-line human summary for logs / inspection.
 *
 * Example:
 *   "2026-01-24 · macro=0.42 (watchful) · tags: macro_risk=0.50, recession_fear=0.30, rate_hawkishness=0.40"
 */
export function summarizeMacroLine(worldContext) {
  if (!worldContext || !worldContext.tags) {
    return "world context unavailable";
  }

  const date = worldContext.date ?? "n/a";
  const macroView = classifyMacroFromTags(worldContext.tags);

  if (macroView.macro_score === null) {
    return `${date} · macro=n/a (no tags yet)`;
  }

  const tagLine = [
    `macro_risk=${fmtTag(worldContext.tags.macro_risk)}`,
    `recession_fear=${fmtTag(worldContext.tags.recession_fear)}`,
    `rate_hawkishness=${fmtTag(worldContext.tags.rate_hawkishness)}`,
  ].join(", ");

  return `${date} · macro=${macroView.macro_score.toFixed(2)} (${macroView.macro_label}) · tags: ${tagLine}`;
}

function fmtTag(value) {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toFixed(2);
}
