// core/tradeGate.js
import { MODES } from "./modes.js";
import { loadStateSync } from "./stewardState.js";

/**
 * Gate logic to decide if the bot is allowed to submit actual orders.
 */
export function computeCanTrade({ mode, internetOk, brokerOk }) {
  const state = loadStateSync();

  const tradingEnabled = state.trading_enabled === true;
  const forceNoTrade = state.force_no_trade === true;

  // Trading is only allowed if:
  // 1. The master toggle is ON (tradingEnabled)
  // 2. The safety kill-switch is OFF (forceNoTrade)
  // 3. Infrastructure is healthy (internet, broker)
  // 4. The mode is NOT Inactive or Read-Only
  const canTrade =
    tradingEnabled &&
    !forceNoTrade &&
    internetOk &&
    brokerOk &&
    mode !== MODES.INACTIVE &&
    mode !== MODES.READ_ONLY;

  return {
    canTrade,
    tradingEnabled,
    forceNoTrade,
    mode,
    internetOk,
    brokerOk,
  };
}
