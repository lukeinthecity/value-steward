import { MODES } from "./modes.js";
import { getTradingEnabled } from "./tradingEnabled.js";

export function computeCanTrade({ mode, internetOk, brokerOk }) {
  const tradingEnabled = getTradingEnabled();

  const canTrade =
    tradingEnabled &&
    internetOk &&
    brokerOk &&
    mode === MODES.LIVE;

  return {
    canTrade,
    tradingEnabled,
    internetOk,
    brokerOk,
    mode,
  };
}
