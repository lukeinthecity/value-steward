import test from "node:test";
import assert from "node:assert/strict";

import { fuseMacroRegime } from "../world/contextUtils.js";

test("fuseMacroRegime promotes the more cautious Scout regime", () => {
  const fused = fuseMacroRegime({
    macroView: { macro_label: "calm", macro_score: 0.12 },
    scoutLabel: "stressed",
    scoutScore: 0.71,
  });

  assert.equal(fused.final_label, "stressed");
  assert.equal(fused.source, "scout_more_cautious");
  assert.equal(fused.divergence, true);
  assert.equal(fused.fusion_reason, "scout_more_cautious");
});

test("fuseMacroRegime keeps Guardian when Scout is less cautious or unavailable", () => {
  const fused = fuseMacroRegime({
    macroView: { macro_label: "watchful", macro_score: 0.34 },
    scoutLabel: "calm",
    scoutScore: 0.12,
  });

  assert.equal(fused.final_label, "watchful");
  assert.equal(fused.source, "guardian_more_cautious");
  assert.equal(fused.divergence, true);
});
