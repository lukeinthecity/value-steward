const TAG_KEYS = [
  "macro_risk",
  "rate_hawkishness",
  "geopolitical_tension",
  "energy_shock_risk",
  "recession_fear",
];

const KEYWORDS = {
  rate_hawkishness: {
    hawk: [
      "rate hike",
      "raise rates",
      "tightening",
      "restrictive",
      "higher for longer",
      "increase in the target range",
    ],
    dove: [
      "rate cut",
      "lower rates",
      "easing",
      "accommodative",
      "reduction in the target range",
    ],
  },
  macro_risk: [
    "uncertainty",
    "tightening financial conditions",
    "credit stress",
    "default",
    "instability",
    "fragile",
    "vulnerabilities",
    "turmoil",
  ],
  geopolitical_tension: [
    "sanctions",
    "conflict",
    "war",
    "tensions",
    "military",
    "invasion",
    "embargo",
    "trade dispute",
  ],
  energy_shock_risk: [
    "oil prices",
    "energy prices",
    "gasoline prices",
    "supply disruption",
    "shortage",
    "spike in prices",
    "opec",
  ],
  recession_fear: [
    "recession",
    "downturn",
    "contraction",
    "negative growth",
    "hard landing",
    "severe slowdown",
  ],
};

function clamp01(value) {
  if (value === null || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function containsAny(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

export function scoreWorldTags({ hydratedEntries, now = new Date() }) {
  try {
    if (!Array.isArray(hydratedEntries)) {
      return {
        tags: nullTags(),
        debugNote: "rule-v1: hydratedEntries not an array, tags left null",
      };
    }

    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const cutoff = nowMs - 48 * 60 * 60 * 1000;
    const recent = hydratedEntries.filter((entry) => {
      const ts = Date.parse(entry.ts);
      return Number.isNaN(ts) ? false : ts >= cutoff;
    });

    if (!recent.length) {
      return {
        tags: nullTags(),
        debugNote: "rule-v1: no recent hydrated entries, tags left null",
      };
    }

    const docs = recent.map((entry) => {
      const title = entry.title ?? "";
      const text = entry.content_text ?? "";
      return `${title} ${text}`.toLowerCase();
    });

    let hawkCount = 0;
    let doveCount = 0;
    for (const doc of docs) {
      if (containsAny(doc, KEYWORDS.rate_hawkishness.hawk)) hawkCount += 1;
      if (containsAny(doc, KEYWORDS.rate_hawkishness.dove)) doveCount += 1;
    }

    const hawkScoreRaw =
      (hawkCount - doveCount) / (hawkCount + doveCount + 1);
    const rateHawkishness = clamp01((hawkScoreRaw + 1) / 2);

    const macroRisk = clamp01(
      countDocsWith(KEYWORDS.macro_risk, docs) / docs.length
    );
    const geoTension = clamp01(
      countDocsWith(KEYWORDS.geopolitical_tension, docs) / docs.length
    );
    const energyShock = clamp01(
      countDocsWith(KEYWORDS.energy_shock_risk, docs) / docs.length
    );
    const recessionFear = clamp01(
      countDocsWith(KEYWORDS.recession_fear, docs) / docs.length
    );

    const tags = {
      macro_risk: macroRisk,
      rate_hawkishness: rateHawkishness,
      geopolitical_tension: geoTension,
      energy_shock_risk: energyShock,
      recession_fear: recessionFear,
    };

    const debugNote = `rule-v1: docs=${docs.length}, hawk=${hawkCount}, dove=${doveCount}`;

    return { tags, debugNote };
  } catch (err) {
    return {
      tags: nullTags(),
      debugNote: `rule-v1: error ${(err?.message ?? err).toString()}`,
    };
  }
}

function countDocsWith(keywords, docs) {
  let count = 0;
  for (const doc of docs) {
    if (containsAny(doc, keywords)) count += 1;
  }
  return count;
}

function nullTags() {
  return TAG_KEYS.reduce((acc, key) => {
    acc[key] = null;
    return acc;
  }, {});
}
