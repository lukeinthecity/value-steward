import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemLogicExplanation } from "../core/systemLogicExplanation.js";

test("system logic explanation resolves divergent views into one narrative", () => {
  const explanation = buildSystemLogicExplanation({
    macro_view: { macro_label: "calm", macro_score: 0.1 },
    scout_label: "stressed",
    final_regime: {
      final_label: "stressed",
      divergence: true,
      fusion_reason: "scout_more_cautious",
    },
  });

  assert.equal(explanation.final_label, "Stressed");
  assert.equal(explanation.fusion_reason, "Probabilistic view more cautious");
  assert.equal(
    explanation.baseline_summary,
    "Baseline: Deterministic signals classified conditions as Calm.",
  );
  assert.equal(
    explanation.overlay_summary,
    "Overlay: Probabilistic signals classified conditions as Stressed.",
  );
  assert.equal(
    explanation.resolution_summary,
    "Resolution: The two reasoning modes diverged, so the system resolved to Stressed because probabilistic view more cautious.",
  );
  assert.equal(
    explanation.decision_impact_summary,
    "By EOD, Value Steward may keep deployment constrained and reject lower-conviction buys.",
  );
});
