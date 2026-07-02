/**
 * Intent → broker-order reconciliation (ML_BACKLOG item 2.7).
 *
 * The intent log records what the engine wanted to do; whether the order
 * actually filled lives separately in portfolio-live.json recent_orders.
 * Unlinked, the intent log misleads (four "BUY KALV" rows can mean zero
 * shares bought). This module joins intents to broker outcomes by
 * client_order_id (stamped as `${intent.id}:${symbol}` at submission, with a
 * symbol/side/date heuristic for pre-linkage history) and appends outcome
 * rows to logs/intent_outcomes.jsonl. Observation only — never rewrites the
 * primary audit log and feeds no decisions.
 */

import path from "path";

import {
  appendJsonlLineSync,
  getPortfolioLivePath,
  readJson,
  readJsonl,
} from "./runtimeArtifacts.js";

export function getIntentLogPath() {
  return path.join(process.cwd(), "logs", "intent_log.jsonl");
}

export function getIntentOutcomesPath() {
  return path.join(process.cwd(), "logs", "intent_outcomes.jsonl");
}

const TERMINAL_STATUSES = new Set(["filled", "canceled", "expired"]);
const OPEN_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "held",
]);

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toExchangeDate(value) {
  const ms = Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function normalizeStatus(status) {
  return String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^orderstatus\./, "")
    .replace("cancelled", "canceled");
}

function normalizeSide(side) {
  return String(side ?? "")
    .trim()
    .toLowerCase()
    .replace(/^orderside\./, "");
}

function normalizeSymbol(symbol) {
  const trimmed = String(symbol ?? "").trim().toUpperCase();
  return trimmed.length ? trimmed : null;
}

/**
 * Every (order_client_id | symbol+side) the intent tried to execute.
 * Linkage-era rows carry order_client_ids; older rows fall back to a
 * symbol/side/date heuristic.
 */
function extractAttempts(intent) {
  const attempts = [];
  const intentId = String(intent?.id ?? "");
  const clientIds = Array.isArray(intent?.order_client_ids)
    ? intent.order_client_ids.filter((cid) => typeof cid === "string" && cid)
    : [];

  if (clientIds.length) {
    const actions = Array.isArray(intent?.actions) ? intent.actions : [];
    for (const cid of clientIds) {
      const action = actions.find((a) => a?.order_client_id === cid) ?? null;
      const symbol = normalizeSymbol(
        action?.symbol ?? cid.slice(intentId.length + 1)
      );
      const side =
        normalizeSide(action?.side) ||
        (["BUY", "SELL"].includes(String(intent?.action_type))
          ? String(intent.action_type).toLowerCase()
          : null);
      if (symbol) {
        attempts.push({ orderClientId: cid, symbol, side, method: "client_order_id" });
      }
    }
    return attempts;
  }

  const actionType = String(intent?.action_type ?? "");
  if (actionType === "BUY" || actionType === "SELL") {
    const symbol = normalizeSymbol(intent?.symbol);
    if (symbol) {
      attempts.push({
        orderClientId: null,
        symbol,
        side: actionType.toLowerCase(),
        method: "heuristic",
      });
    }
    return attempts;
  }

  if (actionType === "MULTI" && Array.isArray(intent?.actions)) {
    for (const action of intent.actions) {
      const symbol = normalizeSymbol(action?.symbol);
      const side = normalizeSide(action?.side);
      if (symbol && side) {
        attempts.push({ orderClientId: null, symbol, side, method: "heuristic" });
      }
    }
  }
  return attempts;
}

function filledNotional(order) {
  const qty = safeNumber(order?.filled_qty);
  const price = safeNumber(order?.filled_avg_price);
  if (qty !== null && price !== null) return qty * price;
  // Older portfolio snapshots lack filled_qty; approximate fully filled
  // orders from ordered qty.
  if (normalizeStatus(order?.status) === "filled") {
    const orderedQty = safeNumber(order?.qty);
    if (orderedQty !== null && price !== null) return orderedQty * price;
    const notional = safeNumber(order?.notional);
    if (notional !== null) return notional;
  }
  return null;
}

function classify(order, intentDate, today) {
  const dayClosed = intentDate !== null && today !== null && intentDate < today;
  if (!order) {
    return {
      fillStatus: "none",
      terminal: dayClosed,
      reasonCode: "INTENT_NO_ORDER",
    };
  }
  const status = normalizeStatus(order.status);
  const notional = filledNotional(order);
  const fillStatus = TERMINAL_STATUSES.has(status)
    ? status
    : OPEN_STATUSES.has(status)
      ? status === "partially_filled"
        ? "partially_filled"
        : "open"
      : "unknown";
  // DAY orders cannot change after their trading day ends.
  const terminal = TERMINAL_STATUSES.has(status) || dayClosed;
  const reasonCode =
    status === "filled" || (notional ?? 0) > 0
      ? "INTENT_FILL_RECONCILED"
      : terminal
        ? "INTENT_UNFILLED"
        : "INTENT_ORDER_OPEN";
  return { fillStatus, terminal, reasonCode };
}

function outcomeKey(intentId, orderClientId, symbol, side) {
  return `${intentId}|${orderClientId ?? `${symbol}:${side}`}`;
}

/**
 * Heuristic match: nearest unconsumed order submitted at/after the intent
 * (falling back to nearest overall), so several same-day attempts on one
 * symbol each get their own order instead of all matching the latest.
 */
function pickHeuristicOrder(bucket, intentTimestamp, consumed) {
  const intentMs = Date.parse(intentTimestamp ?? "");
  const candidates = (bucket ?? [])
    .filter((order) => !consumed.has(order))
    .map((order) => ({
      order,
      delta: Date.parse(order?.submitted_at ?? "") - intentMs,
    }))
    .filter((c) => Number.isFinite(c.delta));
  if (!candidates.length) return null;
  const after = candidates
    .filter((c) => c.delta >= 0)
    .sort((a, b) => a.delta - b.delta);
  const chosen = after.length
    ? after[0]
    : candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  consumed.add(chosen.order);
  return chosen.order;
}

/**
 * Pure join of intents × broker orders → new outcome rows.
 *
 * Idempotent: rows are only emitted when the (intent, attempt) pair has no
 * prior outcome or its fill_status/terminal changed. Already-terminal
 * outcomes are never re-emitted.
 */
export function reconcileIntents({
  intents,
  orders,
  existingOutcomes,
  now = new Date(),
  windowDays = 7,
} = {}) {
  const today = toExchangeDate(now.toISOString());
  const cutoff = toExchangeDate(
    new Date(now.getTime() - windowDays * 86400000).toISOString()
  );

  const byClientId = new Map();
  const bySymbolSideDate = new Map();
  for (const order of orders ?? []) {
    const cid = order?.client_order_id;
    if (typeof cid === "string" && cid) byClientId.set(cid, order);
    const symbol = normalizeSymbol(order?.symbol);
    const side = normalizeSide(order?.side);
    const date = toExchangeDate(order?.submitted_at);
    if (symbol && side && date) {
      const key = `${symbol}|${side}|${date}`;
      const bucket = bySymbolSideDate.get(key) ?? [];
      bucket.push(order);
      bySymbolSideDate.set(key, bucket);
    }
  }

  const latestOutcome = new Map();
  for (const row of existingOutcomes ?? []) {
    latestOutcome.set(
      outcomeKey(row?.intent_id, row?.order_client_id, row?.symbol, row?.side),
      row
    );
  }

  const rows = [];
  const nowIso = now.toISOString();
  const consumedOrders = new Set();
  for (const intent of intents ?? []) {
    const intentDate = toExchangeDate(intent?.timestamp);
    if (!intentDate || (cutoff && intentDate < cutoff)) continue;

    for (const attempt of extractAttempts(intent)) {
      const key = outcomeKey(
        intent.id,
        attempt.orderClientId,
        attempt.symbol,
        attempt.side
      );
      const prior = latestOutcome.get(key);
      if (prior?.terminal) continue;

      let order = null;
      if (attempt.orderClientId) {
        order = byClientId.get(attempt.orderClientId) ?? null;
      } else {
        order = pickHeuristicOrder(
          bySymbolSideDate.get(
            `${attempt.symbol}|${attempt.side}|${intentDate}`
          ),
          intent?.timestamp,
          consumedOrders
        );
      }

      const { fillStatus, terminal, reasonCode } = classify(
        order,
        intentDate,
        today
      );
      if (prior && prior.fill_status === fillStatus && Boolean(prior.terminal) === terminal) {
        continue;
      }

      const row = {
        timestamp: nowIso,
        exchange_date: intentDate,
        intent_id: intent.id ?? null,
        order_client_id: attempt.orderClientId,
        order_id: order?.id ?? null,
        symbol: attempt.symbol,
        side: attempt.side,
        fill_status: fillStatus,
        terminal,
        filled_notional: order ? filledNotional(order) : null,
        filled_avg_price: order ? safeNumber(order.filled_avg_price) : null,
        match_method: attempt.method,
        reason_code: reasonCode,
      };
      rows.push(row);
      latestOutcome.set(key, row);
    }
  }
  return rows;
}

/**
 * "Fills vs attempts" rollup for one exchange date, using the latest outcome
 * per (intent, attempt).
 */
export function summarizeFillAttempts(outcomes, exchangeDate) {
  const latest = new Map();
  for (const row of outcomes ?? []) {
    if (row?.exchange_date !== exchangeDate) continue;
    latest.set(
      outcomeKey(row?.intent_id, row?.order_client_id, row?.symbol, row?.side),
      row
    );
  }
  const bySymbol = {};
  let attempts = 0;
  let fills = 0;
  for (const row of latest.values()) {
    const symbol = row.symbol ?? "?";
    if (!bySymbol[symbol]) bySymbol[symbol] = { attempts: 0, fills: 0 };
    bySymbol[symbol].attempts += 1;
    attempts += 1;
    const filled =
      row.fill_status === "filled" || (safeNumber(row.filled_notional) ?? 0) > 0;
    if (filled) {
      bySymbol[symbol].fills += 1;
      fills += 1;
    }
  }
  return { attempts, fills, bySymbol };
}

/**
 * Read the live artifacts, reconcile, and append any new outcome rows.
 */
export function runIntentReconciliation({ now = new Date(), windowDays = 7 } = {}) {
  const intents = readJsonl(getIntentLogPath());
  const portfolio = readJson(getPortfolioLivePath());
  const orders = Array.isArray(portfolio?.recent_orders)
    ? portfolio.recent_orders
    : [];
  const outcomesPath = getIntentOutcomesPath();
  const existingOutcomes = readJsonl(outcomesPath);

  const rows = reconcileIntents({
    intents,
    orders,
    existingOutcomes,
    now,
    windowDays,
  });
  for (const row of rows) {
    appendJsonlLineSync(outcomesPath, row);
  }

  const today = toExchangeDate(now.toISOString());
  const summary = summarizeFillAttempts([...existingOutcomes, ...rows], today);
  return {
    appended: rows.length,
    attempts_today: summary.attempts,
    fills_today: summary.fills,
    outcomes_path: outcomesPath,
  };
}

export const _internals = {
  extractAttempts,
  classify,
  filledNotional,
  toExchangeDate,
};
