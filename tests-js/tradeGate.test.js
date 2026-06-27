import test from "node:test";
import assert from "node:assert/strict";

import { computeCanTrade } from "../core/tradeGate.js";
import { MODES } from "../core/modes.js";

// computeCanTrade's `canTrade` is advisory — it feeds the tick artifact + email
// summary, not the order path (the authoritative gate is the Python execution
// engine). State is injected so these tests never touch the live data tree.

const enabled = () => ({ trading_enabled: true, force_no_trade: false });

test("canTrade is true when enabled, not kill-switched, and mode is active", () => {
  const r = computeCanTrade({ mode: MODES.LIVE }, { loadState: enabled });
  assert.equal(r.canTrade, true);
  assert.equal(r.tradingEnabled, true);
  assert.equal(r.forceNoTrade, false);
});

test("canTrade is false when the master toggle is off", () => {
  const r = computeCanTrade(
    { mode: MODES.LIVE },
    { loadState: () => ({ trading_enabled: false, force_no_trade: false }) }
  );
  assert.equal(r.canTrade, false);
});

test("canTrade is false when the kill-switch (force_no_trade) is on", () => {
  const r = computeCanTrade(
    { mode: MODES.LIVE },
    { loadState: () => ({ trading_enabled: true, force_no_trade: true }) }
  );
  assert.equal(r.canTrade, false);
});

test("canTrade is false in INACTIVE mode", () => {
  const r = computeCanTrade({ mode: MODES.INACTIVE }, { loadState: enabled });
  assert.equal(r.canTrade, false);
});

test("the removed internetOk/brokerOk fields are no longer returned", () => {
  const r = computeCanTrade({ mode: MODES.LIVE }, { loadState: enabled });
  assert.equal("internetOk" in r, false);
  assert.equal("brokerOk" in r, false);
  assert.equal(r.canTrade, true);
});
