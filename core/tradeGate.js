// core/tradeGate.js
import { MODES } from "./modes.js";
import { loadStateSync } from "./stewardState.js";

/**
 * Gate logic to decide if the bot is allowed to submit actual orders.
 * Infrastructure health (internet, broker) is not pre-checked here — it is
 * validated implicitly by the Python process's Alpaca retry logic — so this
 * resolves to a definitive boolean rather than a tri-state. This flag is
 * advisory/reporting only (it feeds the tick artifact + email summary); the
 * authoritative order gate lives in the Python execution engine.
 */
export function computeCanTrade({ mode }, { loadState = loadStateSync } = {}) {
  const state = loadState();

  const tradingEnabled = state.trading_enabled === true;
  const forceNoTrade = state.force_no_trade === true;

  // Trading is allowed only if:
  // 1. The master toggle is ON (tradingEnabled)
  // 2. The safety kill-switch is OFF (forceNoTrade)
  // 3. The mode is NOT Inactive or Read-Only
  let canTrade = true;
  if (
    tradingEnabled !== true ||
    forceNoTrade === true ||
    mode === MODES.INACTIVE ||
    mode === MODES.READ_ONLY
  ) {
    canTrade = false;
  }

  return {
    canTrade,
    tradingEnabled,
    forceNoTrade,
    mode,
  };
}
