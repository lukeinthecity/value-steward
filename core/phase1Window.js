import { loadStateSync } from "./stewardState.js";
import { getExchangeDateString } from "./timeUtils.js";

function normalizeExchangeDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : getExchangeDateString(value);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : getExchangeDateString(parsed);
}

export function getPhase1StartDate({ state } = {}) {
  const currentState = state ?? loadStateSync();
  return (
    normalizeExchangeDate(currentState?.phase1_start_date) ??
    normalizeExchangeDate(process.env.VS_PHASE1_START_DATE)
  );
}

export function getRecordExchangeDate(record) {
  if (!record || typeof record !== "object") return null;
  return normalizeExchangeDate(
    record.entry_date ??
      record.date ??
      record.timestamp ??
      record.generated_at ??
      record.ranAt ??
      null
  );
}

export function isWithinPhase1Window(value, { state } = {}) {
  const candidate = normalizeExchangeDate(value);
  if (!candidate) return false;
  const startDate = getPhase1StartDate({ state });
  return !startDate || candidate >= startDate;
}

export function filterPhase1Records(records, { state } = {}) {
  if (!Array.isArray(records)) return [];
  const startDate = getPhase1StartDate({ state });
  if (!startDate) {
    return records.slice();
  }
  return records.filter((record) => {
    const candidate = getRecordExchangeDate(record);
    return candidate && candidate >= startDate;
  });
}
