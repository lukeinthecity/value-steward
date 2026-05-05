import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizeDecisionReview,
  summarizeDecisionsForExchangeDate,
} from "../core/decisionReview.js";

test("decision review summarizes actions, reasons, and symbols", () => {
  const review = summarizeDecisionReview([
    {
      timestamp: "2026-03-27T19:30:00.000Z",
      action_type: "BUY",
      symbol: "TPH",
      reason_code: "UNDER_TARGET_BUY",
      world_regime_label: "watchful",
    },
    {
      timestamp: "2026-03-27T19:40:00.000Z",
      action_type: "NO_ACTION",
      symbol: "XMAR",
      reason_code: "BUY_BLOCKED",
      world_regime_label: "watchful",
    },
    {
      timestamp: "2026-03-27T19:50:00.000Z",
      action_type: "BUY",
      symbol: "TPH",
      reason_code: "UNDER_TARGET_BUY",
      world_regime_label: "watchful",
    },
  ]);

  assert.equal(review.total_intents, 3);
  assert.deepEqual(review.action_counts, { BUY: 2, NO_ACTION: 1 });
  assert.equal(review.top_reasons[0].label, "UNDER_TARGET_BUY");
  assert.equal(review.top_symbols[0].label, "TPH");
  assert.deepEqual(review.executed_symbols, ["TPH"]);
  assert.deepEqual(review.action_ledger, [
    {
      timestamp: "2026-03-27T19:30:00.000Z",
      symbol: "TPH",
      action_type: "BUY",
      reason_code: "UNDER_TARGET_BUY",
      regime_label: "watchful",
    },
    {
      timestamp: "2026-03-27T19:40:00.000Z",
      symbol: "XMAR",
      action_type: "NO_ACTION",
      reason_code: "BUY_BLOCKED",
      regime_label: "watchful",
    },
    {
      timestamp: "2026-03-27T19:50:00.000Z",
      symbol: "TPH",
      action_type: "BUY",
      reason_code: "UNDER_TARGET_BUY",
      regime_label: "watchful",
    },
  ]);
  assert.equal(
    review.summary,
    "Primary decision activity was BUY under watchful conditions, most often driven by UNDER_TARGET_BUY, but no broker orders were submitted."
  );
});

test("decision review filters to one exchange date", () => {
  const review = summarizeDecisionsForExchangeDate(
    [
      {
        timestamp: "2026-03-27T19:30:00.000Z",
        action_type: "BUY",
        symbol: "TPH",
        reason_code: "UNDER_TARGET_BUY",
        world_regime_label: "watchful",
      },
      {
        timestamp: "2026-03-26T19:30:00.000Z",
        action_type: "NO_ACTION",
        symbol: "XMAR",
        reason_code: "BUY_BLOCKED",
        world_regime_label: "crisis-prone",
      },
    ],
    "2026-03-27"
  );

  assert.equal(review.total_intents, 1);
  assert.deepEqual(review.action_counts, { BUY: 1 });
});

test("decision review includes multi-action ledger entries", () => {
  const review = summarizeDecisionReview([
    {
      timestamp: "2026-03-27T19:30:00.000Z",
      action_type: "MULTI",
      reason_code: "REBALANCE",
      world_regime_label: "watchful",
      actions: [
        { symbol: "TLT", side: "sell", reason: "trim" },
        { symbol: "SPY", side: "buy", reason: "add" },
      ],
    },
  ]);

  assert.deepEqual(review.executed_symbols, ["TLT", "SPY"]);
  assert.deepEqual(review.action_ledger, [
    {
      timestamp: "2026-03-27T19:30:00.000Z",
      symbol: "SPY",
      action_type: "BUY",
      reason_code: "add",
      regime_label: "watchful",
    },
    {
      timestamp: "2026-03-27T19:30:00.000Z",
      symbol: "TLT",
      action_type: "SELL",
      reason_code: "trim",
      regime_label: "watchful",
    },
  ]);
});

test("decision review separates intents from submitted and filled broker orders", () => {
  const review = summarizeDecisionReview(
    [
      {
        timestamp: "2026-03-30T19:30:00.000Z",
        action_type: "BUY",
        symbol: "TDTT",
        reason_code: "UNDER_TARGET_BUY",
        world_regime_label: "calm",
      },
      {
        timestamp: "2026-03-30T19:40:00.000Z",
        action_type: "BUY",
        symbol: "TDTT",
        reason_code: "UNDER_TARGET_BUY",
        world_regime_label: "calm",
      },
    ],
    {
      exchangeDate: "2026-03-30",
      portfolio: {
        recent_orders: [
          {
            id: "o1",
            symbol: "TDTT",
            side: "buy",
            status: "expired",
            submitted_at: "2026-03-30T19:50:16.378704+00:00",
          },
        ],
      },
    }
  );

  assert.equal(review.orders_submitted, 1);
  assert.equal(review.orders_filled, 0);
  assert.deepEqual(review.order_status_counts, { expired: 1 });
  assert.deepEqual(review.submitted_symbols, ["TDTT"]);
  assert.deepEqual(review.filled_symbols, []);
  assert.equal(
    review.summary,
    "Primary decision activity was BUY under calm conditions, most often driven by UNDER_TARGET_BUY. Broker orders were submitted, but none filled."
  );
});
