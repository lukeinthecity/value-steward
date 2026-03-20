import fs from "fs";
import path from "path";

import { loadStateSync, updateStateSync } from "./stewardState.js";

const DEFAULT_GPIO_PATH = path.join(process.cwd(), "data", "gpio-state.json");

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return null;
}

export function loadGpioState(filePath = DEFAULT_GPIO_PATH) {
  if (!fs.existsSync(filePath)) {
    return {
      trading_enabled: null,
      force_no_trade: null,
      reason: null,
      updated_at: null,
      source: "gpio",
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      trading_enabled: normalizeBoolean(raw.trading_enabled),
      force_no_trade: normalizeBoolean(raw.force_no_trade),
      reason: raw.reason ?? null,
      updated_at: raw.updated_at ?? null,
      source: raw.source ?? "gpio",
    };
  } catch {
    return {
      trading_enabled: null,
      force_no_trade: null,
      reason: null,
      updated_at: null,
      source: "gpio",
    };
  }
}

export function applyGpioStateToControl({ filePath } = {}) {
  const gpioState = loadGpioState(filePath);
  const state = loadStateSync();

  const next = {
    trading_enabled:
      gpioState.trading_enabled !== null
        ? gpioState.trading_enabled
        : state.trading_enabled,
    force_no_trade:
      gpioState.force_no_trade !== null
        ? gpioState.force_no_trade
        : state.force_no_trade,
    control_reason: gpioState.reason ?? state.control_reason,
    control_updated_at: gpioState.updated_at ?? new Date().toISOString(),
  };

  const changed =
    next.trading_enabled !== state.trading_enabled ||
    next.force_no_trade !== state.force_no_trade ||
    next.control_reason !== state.control_reason;

  if (!changed) {
    return { updated: false, state, gpio: gpioState };
  }

  const saved = updateStateSync((draft) => {
    draft.trading_enabled = next.trading_enabled;
    draft.force_no_trade = next.force_no_trade;
    draft.control_reason = next.control_reason;
    draft.control_updated_at = next.control_updated_at;
    return draft;
  });
  return { updated: true, state: saved, gpio: gpioState };
}
