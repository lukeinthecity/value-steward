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

/**
 * Calculates a weight based on age (Time-Decay).
 * maxAge is dynamic (48h normally, 72h on Mondays).
 */
function calculateDecayWeight(entryTs, nowMs, maxAge) {
  const ts = Date.parse(entryTs);
  if (Number.isNaN(ts)) return 0;
  const ageHours = (nowMs - ts) / (1000 * 60 * 60);
  
  if (ageHours > maxAge) return 0;
  
  if (ageHours <= 6) return 1.0;
  if (ageHours <= 24) return 0.5;
  if (ageHours <= maxAge) return 0.25;
  return 0;
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
    const isMonday = (now instanceof Date ? now : new Date(nowMs)).getDay() === 1;
    // Elite Quant: Expand window to 72h on Mondays to capture Friday's close data.
    const maxAge = isMonday ? 72 : 48;
    
    const docsWithWeights = [];
    for (const entry of hydratedEntries) {
        const weight = calculateDecayWeight(entry.ts, nowMs, maxAge);
        if (weight > 0) {
            const title = entry.title ?? "";
            const text = entry.content_text ?? "";
            docsWithWeights.push({
                text: `${title} ${text}`.toLowerCase(),
                weight
            });
        }
    }

    if (!docsWithWeights.length) {
      return {
        tags: nullTags(),
        debugNote: `rule-v1: no recent docs found (maxAge=${maxAge}h)`,
      };
    }

    let weightedHawk = 0;
    let weightedDove = 0;
    
    // For ratio tags (Hawk/Dove)
    for (const doc of docsWithWeights) {
      const hasHawk = containsAny(doc.text, KEYWORDS.rate_hawkishness.hawk);
      const hasDove = containsAny(doc.text, KEYWORDS.rate_hawkishness.dove);
      
      if (hasHawk) weightedHawk += doc.weight;
      if (hasDove) weightedDove += doc.weight;
    }

    const hawkScoreRaw = (weightedHawk - weightedDove) / (weightedHawk + weightedDove + 1);
    const rateHawkishness = clamp01((hawkScoreRaw + 1) / 2);

    // For absolute risk tags
    const totalPossibleWeight = docsWithWeights.reduce((sum, d) => sum + d.weight, 0);
    
    const calculateWeightedTag = (keywords) => {
        const matchingWeight = docsWithWeights.reduce((sum, d) => {
            return sum + (containsAny(d.text, keywords) ? d.weight : 0);
        }, 0);
        return clamp01(matchingWeight / (totalPossibleWeight || 1));
    };

    const tags = {
      macro_risk: calculateWeightedTag(KEYWORDS.macro_risk),
      rate_hawkishness: rateHawkishness,
      geopolitical_tension: calculateWeightedTag(KEYWORDS.geopolitical_tension),
      energy_shock_risk: calculateWeightedTag(KEYWORDS.energy_shock_risk),
      recession_fear: calculateWeightedTag(KEYWORDS.recession_fear),
    };

    const debugNote = `rule-v1-decay: docs=${docsWithWeights.length}, totalWeight=${totalPossibleWeight.toFixed(2)}, maxAge=${maxAge}h`;

    return { tags, debugNote };
  } catch (err) {
    return {
      tags: nullTags(),
      debugNote: `rule-v1: error ${(err?.message ?? err).toString()}`,
    };
  }
}

function nullTags() {
  return TAG_KEYS.reduce((acc, key) => {
    acc[key] = null;
    return acc;
  }, {});
}
