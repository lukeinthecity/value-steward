// world/contextUtils.js
import fs from "fs";
import path from "path";

function loadMacroPolicy() {
  const policyPath = path.join(process.cwd(), "config", "macro-policy.json");
  if (!fs.existsSync(policyPath)) {
    return {
      required_tags: [
        "macro_risk",
        "rate_hawkishness",
        "geopolitical_tension",
        "energy_shock_risk",
        "recession_fear",
      ],
      weights: {
        macro_risk: 0.4,
        recession_fear: 0.3,
        geopolitical_tension: 0.15,
        energy_shock_risk: 0.15,
      },
      thresholds: {
        crisis_prone: 0.8,
        stressed: 0.6,
        watchful: 0.3,
      },
    };
  }
  try {
    return JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (err) {
    return {
      required_tags: [
        "macro_risk",
        "rate_hawkishness",
        "geopolitical_tension",
        "energy_shock_risk",
        "recession_fear",
      ],
      weights: {
        macro_risk: 0.4,
        recession_fear: 0.3,
        geopolitical_tension: 0.15,
        energy_shock_risk: 0.15,
      },
      thresholds: {
        crisis_prone: 0.8,
        stressed: 0.6,
        watchful: 0.3,
      },
    };
  }
}

const policy = loadMacroPolicy();
export const REQUIRED_TAGS = policy.required_tags;

/**
 * Validate a world-context entry before appending to world-context.jsonl
 */
export function validateContext(entry) {
  if (!entry || typeof entry !== "object") return false;

  // YYYY-MM-DD
  if (!/\d{4}-\d{2}-\d{2}/.test(entry.date)) return false;
  if (!entry.generated_at) return false;

  if (!entry.tags || typeof entry.tags !== "object") return false;
  for (const tag of REQUIRED_TAGS) {
    if (!(tag in entry.tags)) return false;
  }

  if (!Array.isArray(entry.sources_used)) return false;
  if (typeof entry.raw_count !== "number") return false;
  if (!Array.isArray(entry.errors)) return false;

  return true;
}

/**
 * Filter entries (inbox / hydrated) that are newer than cutoffMs.
 * Expects a `ts` field that Date.parse can read.
 */
export function filterRecent(entries, cutoffMs) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoffMs;
  });
}

/**
 * Determine which time zone the "world date" should use.
 * Order:
 *   1) WORLD_TIMEZONE env var (e.g. "America/New_York")
 *   2) System time zone from Intl.DateTimeFormat
 *   3) UTC fallback
 */
export function getWorldTimeZone() {
  if (process.env.WORLD_TIMEZONE && process.env.WORLD_TIMEZONE.trim()) {
    return process.env.WORLD_TIMEZONE.trim();
  }
  if (process.env.VS_MARKET_TIMEZONE && process.env.VS_MARKET_TIMEZONE.trim()) {
    return process.env.VS_MARKET_TIMEZONE.trim();
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // fall through to UTC
  }

  return "UTC";
}

/**
 * Format a Date into YYYY-MM-DD in the configured world time zone.
 * Used for worldContext.date so the calendar day matches the trading locale.
 */
export function toWorldDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  const tz = getWorldTimeZone();

  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const parts = fmt.formatToParts(d);
    const byType = {};
    for (const part of parts) {
      if (part.type === "year" || part.type === "month" || part.type === "day") {
        byType[part.type] = part.value;
      }
    }

    if (byType.year && byType.month && byType.day) {
      return `${byType.year}-${byType.month}-${byType.day}`;
    }
  } catch {
    // ignore and fall through to UTC ISO slice
  }

  // Last-resort: UTC calendar date
  return d.toISOString().slice(0, 10);
}

/**
 * Compute a macro score + label + observability metadata
 * from the smoothed tag values in [0,1].
 */
export function classifyMacroFromTags(tags) {
  const currentPolicy = loadMacroPolicy();
  const reqTags = currentPolicy.required_tags;
  const weights = currentPolicy.weights;
  const thresholds = currentPolicy.thresholds;

  if (!tags) {
    return {
      macro_score: null,
      macro_label: "n/a",
      inputs_used: [],
      null_count: reqTags.length,
      confidence: 0,
      coverage_note: "no tag signals",
    };
  }

  const values = {};
  let nullCount = 0;
  for (const key of reqTags) {
    const value = tags[key];
    if (value === null || value === undefined) {
      nullCount += 1;
      values[key] = 0;
    } else {
      values[key] = Number(value);
    }
  }

  // Weighted blend of the key risks, clamped to [0,1]
  const rawScore = Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + (values[key] || 0) * weight,
    0
  );

  const macroScore = Math.max(0, Math.min(1, rawScore));

  let macroLabel = "calm";
  if (macroScore >= thresholds.crisis_prone) macroLabel = "crisis-prone";
  else if (macroScore >= thresholds.stressed) macroLabel = "stressed";
  else if (macroScore >= thresholds.watchful) macroLabel = "watchful";

  const inputsUsed = reqTags.filter(
    (key) => tags[key] !== null && tags[key] !== undefined
  );

  const coverage = inputsUsed.length / reqTags.length;

  let confidence = 0;
  let coverageNote = "no tag signals";
  if (inputsUsed.length === 0) {
    confidence = 0;
    coverageNote = "no tag signals";
  } else if (coverage < 0.4) {
    confidence = 0.3;
    coverageNote = "very sparse tags";
  } else if (coverage < 0.8) {
    confidence = 0.7;
    coverageNote = "partial coverage";
  } else {
    confidence = 1.0;
    coverageNote = "full coverage";
  }

  return {
    macro_score: macroScore,
    macro_label: macroLabel,
    inputs_used: inputsUsed,
    null_count: nullCount,
    confidence,
    coverage_note: coverageNote,
  };
}

/**
 * Human-readable one-line summary for logs / inspector.
 */
export function summarizeMacroLine(worldContext) {
  if (!worldContext || !worldContext.tags) {
    return "world context unavailable";
  }

  const date = worldContext.date ?? "n/a";
  const macroView = classifyMacroFromTags(worldContext.tags);

  if (macroView.macro_score === null) {
    return `${date} · macro=n/a (no tag signals yet)`;
  }

  const inputsCount = macroView.inputs_used.length;

  const tagLine = Object.entries(worldContext.tags)
    .map(([key, value]) => `${key}=${fmtTag(value)}`)
    .join(", ");

  return [
    `${date} · macro=${macroView.macro_score.toFixed(2)} (${macroView.macro_label})`,
    `inputs=${inputsCount}/${REQUIRED_TAGS.length}`,
    `nulls=${macroView.null_count}`,
    `confidence=${fmtTag(macroView.confidence)}`,
    macroView.coverage_note,
    `tags: ${tagLine}`,
  ].join(" · ");
}

function fmtTag(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "n/a";
  }
  return Number(value).toFixed(2);
}
