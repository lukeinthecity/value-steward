import fs from "fs";
import path from "path";

import { getExchangeDateString } from "./timeUtils.js";

const INTENT_LOG_PATH = path.join(process.cwd(), "logs", "intent_log.jsonl");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function increment(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topEntries(counter, limit = 3) {
  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function normalizeOrderStatus(status) {
  return String(status ?? "")
    .trim()
    .toLowerCase();
}

function orderTimestamp(order) {
  return (
    order?.filled_at ??
    order?.submitted_at ??
    order?.created_at ??
    null
  );
}

function isFilledOrder(order) {
  const status = normalizeOrderStatus(order?.status);
  return status === "filled" || status === "partially_filled" || Boolean(order?.filled_at);
}

function buildOrderActivity(portfolio = null, exchangeDate = null) {
  const orderCounters = new Map();
  const submittedSymbols = new Set();
  const filledSymbols = new Set();
  const seen = new Set();
  const orders = [];

  const candidates = [
    ...(portfolio?.last_order ? [portfolio.last_order] : []),
    ...(Array.isArray(portfolio?.recent_orders) ? portfolio.recent_orders : []),
    ...(Array.isArray(portfolio?.open_orders) ? portfolio.open_orders : []),
  ];

  for (const order of candidates) {
    const key = order?.id ?? [
      order?.symbol ?? "",
      order?.side ?? "",
      order?.status ?? "",
      order?.submitted_at ?? "",
      order?.filled_at ?? "",
    ].join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const timestamp = orderTimestamp(order);
    if (!timestamp) continue;
    if (exchangeDate && getExchangeDateString(new Date(timestamp)) !== exchangeDate) {
      continue;
    }
    orders.push(order);
    increment(orderCounters, normalizeOrderStatus(order?.status) || "unknown");
    if (order?.symbol) {
      submittedSymbols.add(order.symbol);
      if (isFilledOrder(order)) {
        filledSymbols.add(order.symbol);
      }
    }
  }

  const filledOrders = orders.filter((order) => isFilledOrder(order));
  return {
    orders_submitted: orders.length,
    orders_filled: filledOrders.length,
    order_status_counts: Object.fromEntries(orderCounters),
    submitted_symbols: [...submittedSymbols].sort(),
    filled_symbols: [...filledSymbols].sort(),
  };
}

export function loadIntentLog() {
  return readJsonl(INTENT_LOG_PATH);
}

export function summarizeDecisionReview(intents = [], { portfolio = null, exchangeDate = null } = {}) {
  const actions = new Map();
  const reasons = new Map();
  const symbols = new Map();
  const regimes = new Map();
  const executedSymbols = [];
  const blockedReasons = [];
  const actionLedger = [];

  for (const intent of intents) {
    increment(actions, intent?.action_type);
    increment(reasons, intent?.reason_code);
    increment(regimes, intent?.world_regime_label);
    if (intent?.symbol) {
      increment(symbols, intent.symbol);
    }

    if (intent?.action_type === "BUY" || intent?.action_type === "SELL") {
      if (intent?.symbol) executedSymbols.push(intent.symbol);
    }
    if (Array.isArray(intent?.actions)) {
      for (const action of intent.actions) {
        if (action?.symbol) {
          executedSymbols.push(action.symbol);
          increment(symbols, action.symbol);
          actionLedger.push({
            timestamp: intent.timestamp ?? null,
            symbol: action.symbol,
            action_type: String(action.side || "MULTI").toUpperCase(),
            reason_code: action.reason ?? intent.reason_code ?? "n/a",
            regime_label: intent.world_regime_label ?? "n/a",
          });
        }
      }
    }

    if (
      intent?.reason_code &&
      (String(intent.reason_code).includes("BLOCK") ||
        intent.reason_code === "CORRELATED_REDUNDANCY" ||
        intent.reason_code === "WITHIN_BUFFER" ||
        intent.reason_code === "WITHIN_BUFFER_NO_ACTION")
    ) {
      blockedReasons.push(intent.reason_code);
    }
    if (intent?.action_type && intent?.symbol) {
      actionLedger.push({
        timestamp: intent.timestamp ?? null,
        symbol: intent.symbol,
        action_type: intent.action_type,
        reason_code: intent.reason_code ?? "n/a",
        regime_label: intent.world_regime_label ?? "n/a",
      });
    }
  }

  const topReasonEntries = topEntries(reasons, 4);
  const topSymbolEntries = topEntries(symbols, 4);
  const topRegimeEntries = topEntries(regimes, 3);
  const uniqueExecutedSymbols = [...new Set(executedSymbols)];
  const orderActivity = buildOrderActivity(portfolio, exchangeDate);
  actionLedger.sort((left, right) => {
    const leftTs = Date.parse(left.timestamp || "") || 0;
    const rightTs = Date.parse(right.timestamp || "") || 0;
    return leftTs - rightTs || left.symbol.localeCompare(right.symbol);
  });

  let summary = "No decision activity recorded.";
  if (intents.length > 0) {
    const dominantAction = topEntries(actions, 1)[0]?.label ?? "NO_ACTION";
    const dominantReason = topReasonEntries[0]?.label ?? "n/a";
    const dominantRegime = topRegimeEntries[0]?.label ?? "n/a";
    if (orderActivity.orders_submitted === 0) {
      summary =
        `Primary decision activity was ${dominantAction} under ${dominantRegime} ` +
        `conditions, most often driven by ${dominantReason}, but no broker orders were submitted.`;
    } else if (orderActivity.orders_filled === 0) {
      summary =
        `Primary decision activity was ${dominantAction} under ${dominantRegime} ` +
        `conditions, most often driven by ${dominantReason}. ` +
        `Broker orders were submitted, but none filled.`;
    } else {
      summary =
        `Primary decision activity was ${dominantAction} under ${dominantRegime} ` +
        `conditions, most often driven by ${dominantReason}. ` +
        `${orderActivity.orders_filled} broker order(s) filled.`;
    }
  }

  return {
    total_intents: intents.length,
    action_counts: Object.fromEntries(actions),
    top_reasons: topReasonEntries,
    top_symbols: topSymbolEntries,
    dominant_regimes: topRegimeEntries,
    executed_symbols: uniqueExecutedSymbols,
    blocked_reasons: [...new Set(blockedReasons)],
    action_ledger: actionLedger,
    ...orderActivity,
    summary,
  };
}

export function summarizeDecisionsForExchangeDate(intents = [], exchangeDate, options = {}) {
  const filtered = intents.filter((intent) => {
    if (!intent?.timestamp) return false;
    return getExchangeDateString(new Date(intent.timestamp)) === exchangeDate;
  });
  return summarizeDecisionReview(filtered, { ...options, exchangeDate });
}
