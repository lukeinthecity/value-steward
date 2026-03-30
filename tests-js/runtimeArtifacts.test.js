import test from "node:test";
import assert from "node:assert/strict";

import {
  assertMatchingCycleIds,
  buildArtifactCycleId,
  extractLatestOrderFromPortfolioSnapshot,
  getArtifactCycleId,
} from "../core/runtimeArtifacts.js";

test("extractLatestOrderFromPortfolioSnapshot prefers most recent same-day order", () => {
  const portfolio = {
    recent_orders: [
      {
        symbol: "OLD",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-19T19:30:00.000Z",
        filled_at: "2026-03-19T19:31:00.000Z",
      },
      {
        symbol: "WMB",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-20T19:39:00.000Z",
        filled_at: "2026-03-20T19:40:00.000Z",
        filled_avg_price: "54.32",
      },
      {
        symbol: "CUB",
        side: "buy",
        status: "new",
        submitted_at: "2026-03-20T19:20:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
  });

  assert.equal(latest.symbol, "WMB");
  assert.equal(latest.status, "filled");
  assert.equal(latest.filled_avg_price, "54.32");
});

test("extractLatestOrderFromPortfolioSnapshot returns null when no order matches exchange date", () => {
  const portfolio = {
    recent_orders: [
      {
        symbol: "OLD",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-19T19:30:00.000Z",
        filled_at: "2026-03-19T19:31:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
  });

  assert.equal(latest, null);
});

test("extractLatestOrderFromPortfolioSnapshot ignores newer non-executed orders by default", () => {
  const portfolio = {
    last_order: {
      symbol: "WMB",
      side: "buy",
      status: "filled",
      submitted_at: "2026-03-20T19:39:00.000Z",
      filled_at: "2026-03-20T19:40:00.000Z",
    },
    recent_orders: [
      {
        symbol: "WMB",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-20T19:39:00.000Z",
        filled_at: "2026-03-20T19:40:00.000Z",
      },
      {
        symbol: "CUB",
        side: "buy",
        status: "new",
        submitted_at: "2026-03-20T19:55:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
  });

  assert.equal(latest.symbol, "WMB");
  assert.equal(latest.status, "filled");
});

test("extractLatestOrderFromPortfolioSnapshot can return latest same-day non-executed order", () => {
  const portfolio = {
    recent_orders: [
      {
        symbol: "WMB",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-20T19:39:00.000Z",
        filled_at: "2026-03-20T19:40:00.000Z",
      },
      {
        symbol: "CUB",
        side: "buy",
        status: "expired",
        submitted_at: "2026-03-20T19:55:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
    requireExecuted: false,
  });

  assert.equal(latest.symbol, "CUB");
  assert.equal(latest.status, "expired");
});

test("artifact cycle helpers normalize and validate same-cycle snapshots", () => {
  const cycleId = buildArtifactCycleId({
    exchangeDate: "2026-03-30",
    slot: "pre_close",
    sourceTimestamp: "2026-03-30T19:25:00.000Z",
  });

  assert.equal(cycleId, "2026-03-30:pre_close:2026-03-30T19:25:00.000Z");
  assert.equal(getArtifactCycleId({ cycle_id: cycleId }), cycleId);
  assert.equal(getArtifactCycleId({ result: { cycle_id: cycleId } }), cycleId);

  const check = assertMatchingCycleIds([
    { label: "tick", cycleId },
    { label: "portfolio", cycleId },
    { label: "world", cycleId },
  ]);
  assert.equal(check.ok, true);
  assert.equal(check.expectedCycleId, cycleId);
});

test("artifact cycle helpers report mismatches", () => {
  const check = assertMatchingCycleIds([
    { label: "tick", cycleId: "2026-03-30:pre_close:a" },
    { label: "portfolio", cycleId: "2026-03-30:pre_close:b" },
    { label: "world", cycleId: "2026-03-30:pre_close:a" },
  ]);

  assert.equal(check.ok, false);
  assert.equal(check.expectedCycleId, "2026-03-30:pre_close:a");
  assert.deepEqual(check.mismatches, [
    { label: "portfolio", cycleId: "2026-03-30:pre_close:b" },
  ]);
});
