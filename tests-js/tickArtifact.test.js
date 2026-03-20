import test from "node:test";
import assert from "node:assert/strict";

import { buildFallbackTickResult } from "../core/tick.js";

test("fallback tick artifact preserves authoritative context and unknown gate state", () => {
  const result = buildFallbackTickResult({
    now: "2026-03-13T20:55:00.000Z",
    policy: { mode: "rebalance", risk_level: 0.2 },
    state: {
      current_mode: "LIVE",
      last_run_at: "2026-03-13T20:54:59.000Z",
      last_known_positions: [{ symbol: "SPY", qty: 1 }],
    },
    marketOpen: false,
    clock: {
      next_open: "2026-03-16T13:30:00Z",
      next_close: "2026-03-13T20:00:00Z",
    },
    worldContext: {
      generated_at: "2026-03-13T20:30:00.000Z",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
    },
    tradeGate: {
      canTrade: null,
      tradingEnabled: true,
      forceNoTrade: false,
      internetOk: null,
      brokerOk: null,
      mode: "LIVE",
    },
    snapshotError: "broker unavailable",
  });

  assert.equal(result.ranAt, "2026-03-13T20:54:59.000Z");
  assert.equal(result.tradeGate.canTrade, null);
  assert.equal(result.worldContext.macro_view.macro_label, "watchful");
  assert.equal(result.snapshotStatus, "python_authoritative_node_degraded");
  assert.equal(result.snapshotError, "broker unavailable");
  assert.equal(result.numPositions, 1);
});
