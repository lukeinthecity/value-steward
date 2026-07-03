function formatLabel(value) {
  if (!value || value === "n/a") return "Unavailable";
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function describeFusionReason(value) {
  switch (value) {
    case "deterministic_only":
    case "guardian_only":
      return "Deterministic only";
    case "probabilistic_only":
    case "scout_only":
      return "Probabilistic only";
    case "probabilistic_more_cautious":
    case "scout_more_cautious":
      return "Probabilistic view more cautious";
    case "deterministic_more_cautious":
    case "guardian_more_cautious":
      return "Deterministic view more cautious";
    case "aligned":
      return "Aligned";
    case "no_valid_inputs":
      return "Inputs unavailable";
    default:
      return formatLabel(value);
  }
}

function decisionImpactForRegime(finalLabel) {
  switch (finalLabel) {
    case "calm":
      return "By EOD, Value Steward may allow normal sandbox buys if signal quality remains intact.";
    case "watchful":
      return "By EOD, Value Steward may filter new buys more aggressively and prefer holds over marginal adds.";
    case "stressed":
      return "By EOD, Value Steward may keep deployment constrained and reject lower-conviction buys.";
    case "crisis-prone":
      return "By EOD, Value Steward may avoid new buys entirely and prioritize capital preservation.";
    default:
      return "By EOD, Value Steward may defer action until regime confidence improves.";
  }
}

export function buildSystemLogicExplanation(worldContext) {
  const deterministic = worldContext?.macro_view?.macro_label ?? null;
  const probabilistic = worldContext?.scout_label ?? null;
  const finalRegime = worldContext?.final_regime ?? null;
  const finalLabel =
    finalRegime?.final_label ?? deterministic ?? probabilistic ?? "n/a";
  const divergence = finalRegime?.divergence === true;
  const fusionReason = describeFusionReason(finalRegime?.fusion_reason);

  const baselineSummary =
    deterministic && deterministic !== "n/a"
      ? `Baseline: Deterministic signals classified conditions as ${formatLabel(deterministic)}.`
      : "Baseline: Deterministic signals were unavailable.";

  const overlaySummary =
    probabilistic && probabilistic !== "n/a"
      ? `Overlay: Probabilistic signals classified conditions as ${formatLabel(probabilistic)}.`
      : "Overlay: Probabilistic signals were unavailable.";

  let resolutionSummary = `Resolution: The system regime resolved to ${formatLabel(finalLabel)}.`;
  if (divergence) {
    resolutionSummary = `Resolution: The two reasoning modes diverged, so the system resolved to ${formatLabel(finalLabel)} because ${fusionReason.toLowerCase()}.`;
  } else if (finalRegime?.fusion_reason === "aligned") {
    resolutionSummary = `Resolution: Both reasoning modes aligned on ${formatLabel(finalLabel)}.`;
  }

  return {
    deterministic_label: formatLabel(deterministic),
    probabilistic_label: formatLabel(probabilistic),
    final_label: formatLabel(finalLabel),
    fusion_reason: fusionReason,
    baseline_summary: baselineSummary,
    overlay_summary: overlaySummary,
    resolution_summary: resolutionSummary,
    decision_impact_summary: decisionImpactForRegime(finalLabel),
  };
}
