import test from "node:test";
import assert from "node:assert/strict";

import { extractLatestOrderFromPortfolioSnapshot } from "../core/runtimeArtifacts.js";

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
