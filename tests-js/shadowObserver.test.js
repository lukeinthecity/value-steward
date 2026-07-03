import test from "node:test";
import assert from "node:assert/strict";

import { buildScoutSystemInstruction } from "../world/shadowObserver.js";

test("scout prompt includes apprenticeship-phase and anti-gaming guidance", () => {
  const prompt = buildScoutSystemInstruction({
    internalAudit: "Internal Audit (Last 7 Days):\n- BUY: 2",
  });

  assert.match(prompt, /small-capital apprenticeship phase/i);
  assert.match(
    prompt,
    /operational integrity, truthful reporting, and bounded risk/i,
  );
  assert.match(prompt, /do not game metrics/i);
  assert.match(prompt, /advisory macro scout/i);
});
