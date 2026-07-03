const DEFAULT_ALPHA = 0.4;
const DEFAULT_MAX_DELTA = 0.15;
const DEFAULT_WINDOW = 7;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function isNumeric(value) {
  return typeof value === "number" && !Number.isNaN(value);
}

export function computeSmoothedTags({
  history,
  latestRawTags,
  tagKeys,
  alpha = DEFAULT_ALPHA,
  maxDelta = DEFAULT_MAX_DELTA,
  window = DEFAULT_WINDOW,
}) {
  const keys = tagKeys ?? Object.keys(latestRawTags || {});
  const recent = Array.isArray(history) ? history.slice(-window) : [];

  const result = {};
  for (const key of keys) {
    const priorValues = recent
      .map((entry) => entry?.tags?.[key])
      .filter(isNumeric);

    const prev = priorValues.length
      ? priorValues[priorValues.length - 1]
      : null;

    const raw =
      latestRawTags && isNumeric(latestRawTags[key])
        ? latestRawTags[key]
        : prev;

    if (raw === null || raw === undefined) {
      result[key] = null;
      continue;
    }

    if (!isNumeric(prev)) {
      result[key] = clamp01(raw);
      continue;
    }

    let candidate = alpha * raw + (1 - alpha) * prev;
    const lower = prev - maxDelta;
    const upper = prev + maxDelta;
    candidate = Math.min(upper, Math.max(lower, candidate));
    result[key] = clamp01(candidate);
  }

  return result;
}

export const SMOOTHING_DEFAULTS = {
  alpha: DEFAULT_ALPHA,
  maxDelta: DEFAULT_MAX_DELTA,
  window: DEFAULT_WINDOW,
};
