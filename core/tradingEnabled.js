// core/tradingEnabled.js
import { loadStateSync } from "./stewardState.js";

/**
 * High-level check for the 'master switch'.
 */
export function getTradingEnabled() {
  const state = loadStateSync();
  return state.trading_enabled === true;
}
