import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importModule() {
  const moduleUrl = `${
    pathToFileURL(path.join(repoRoot, "core", "intentReconciliation.js")).href
  }?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

const NOW = new Date("2026-07-02T20:10:00Z"); // 16:10 ET, exchange date 2026-07-02

function buyIntent({
  id = "11111111-1111-1111-1111-111111111111",
  timestamp = "2026-07-02T19:55:00Z",
  symbol = "KALV",
  clientIds = null,
} = {}) {
  return {
    id,
    timestamp,
    action_type: "BUY",
    symbol,
    order_client_ids: clientIds ?? [`${id}:${symbol}`],
    actions: [],
  };
}

test("filled order reconciles via client_order_id", async () => {
  const { reconcileIntents } = await importModule();
  const intent = buyIntent();
  const rows = reconcileIntents({
    intents: [intent],
    orders: [
      {
        id: "ord-1",
        client_order_id: `${intent.id}:KALV`,
        symbol: "KALV",
        side: "buy",
        status: "filled",
        filled_qty: "2",
        filled_avg_price: "10.50",
        submitted_at: "2026-07-02T19:55:01Z",
      },
    ],
    existingOutcomes: [],
    now: NOW,
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.fill_status, "filled");
  assert.equal(row.terminal, true);
  assert.equal(row.filled_notional, 21.0);
  assert.equal(row.match_method, "client_order_id");
  assert.equal(row.reason_code, "INTENT_FILL_RECONCILED");
  assert.ok(row.timestamp.endsWith("Z"));
  assert.equal(row.exchange_date, "2026-07-02");
});

test("expired order marks intent unfilled and terminal", async () => {
  const { reconcileIntents } = await importModule();
  const intent = buyIntent();
  const rows = reconcileIntents({
    intents: [intent],
    orders: [
      {
        id: "ord-2",
        client_order_id: `${intent.id}:KALV`,
        symbol: "KALV",
        side: "buy",
        status: "expired",
        filled_qty: "0",
        filled_avg_price: null,
        submitted_at: "2026-07-02T19:55:01Z",
      },
    ],
    existingOutcomes: [],
    now: NOW,
  });

  assert.equal(rows[0].fill_status, "expired");
  assert.equal(rows[0].terminal, true);
  assert.equal(rows[0].reason_code, "INTENT_UNFILLED");
});

test("missing order is INTENT_NO_ORDER — terminal only after the trading day", async () => {
  const { reconcileIntents } = await importModule();
  const sameDay = reconcileIntents({
    intents: [buyIntent()],
    orders: [],
    existingOutcomes: [],
    now: NOW,
  });
  assert.equal(sameDay[0].fill_status, "none");
  assert.equal(sameDay[0].terminal, false);
  assert.equal(sameDay[0].reason_code, "INTENT_NO_ORDER");

  const priorDay = reconcileIntents({
    intents: [buyIntent({ timestamp: "2026-07-01T19:55:00Z" })],
    orders: [],
    existingOutcomes: [],
    now: NOW,
  });
  assert.equal(priorDay[0].terminal, true);
  assert.equal(priorDay[0].reason_code, "INTENT_NO_ORDER");
});

test("idempotent: unchanged or terminal outcomes are not re-emitted", async () => {
  const { reconcileIntents } = await importModule();
  const intent = buyIntent();
  const orders = [
    {
      id: "ord-1",
      client_order_id: `${intent.id}:KALV`,
      symbol: "KALV",
      side: "buy",
      status: "filled",
      filled_qty: "2",
      filled_avg_price: "10.50",
      submitted_at: "2026-07-02T19:55:01Z",
    },
  ];
  const first = reconcileIntents({
    intents: [intent],
    orders,
    existingOutcomes: [],
    now: NOW,
  });
  const second = reconcileIntents({
    intents: [intent],
    orders,
    existingOutcomes: first,
    now: NOW,
  });
  assert.equal(second.length, 0);
});

test("status change re-emits: open order later fills", async () => {
  const { reconcileIntents } = await importModule();
  const intent = buyIntent();
  const openRows = reconcileIntents({
    intents: [intent],
    orders: [
      {
        id: "ord-1",
        client_order_id: `${intent.id}:KALV`,
        symbol: "KALV",
        side: "buy",
        status: "new",
        submitted_at: "2026-07-02T19:55:01Z",
      },
    ],
    existingOutcomes: [],
    now: NOW,
  });
  assert.equal(openRows[0].fill_status, "open");
  assert.equal(openRows[0].reason_code, "INTENT_ORDER_OPEN");

  const filledRows = reconcileIntents({
    intents: [intent],
    orders: [
      {
        id: "ord-1",
        client_order_id: `${intent.id}:KALV`,
        symbol: "KALV",
        side: "buy",
        status: "filled",
        filled_qty: "2",
        filled_avg_price: "10.50",
        submitted_at: "2026-07-02T19:55:01Z",
      },
    ],
    existingOutcomes: openRows,
    now: NOW,
  });
  assert.equal(filledRows.length, 1);
  assert.equal(filledRows[0].fill_status, "filled");
});

test("pre-linkage intents match heuristically by symbol/side/date", async () => {
  const { reconcileIntents } = await importModule();
  const rows = reconcileIntents({
    intents: [
      {
        id: "old-intent",
        timestamp: "2026-07-02T19:40:00Z",
        action_type: "BUY",
        symbol: "HYNE",
      },
    ],
    orders: [
      {
        id: "ord-9",
        symbol: "HYNE",
        side: "buy",
        status: "filled",
        qty: "0.2178",
        filled_avg_price: "16.82",
        submitted_at: "2026-07-02T19:50:14Z",
      },
    ],
    existingOutcomes: [],
    now: NOW,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].match_method, "heuristic");
  assert.equal(rows[0].fill_status, "filled");
  // filled_qty missing on old snapshots: falls back to ordered qty × price.
  assert.ok(Math.abs(rows[0].filled_notional - 0.2178 * 16.82) < 1e-9);
});

test("intents older than the window are skipped", async () => {
  const { reconcileIntents } = await importModule();
  const rows = reconcileIntents({
    intents: [buyIntent({ timestamp: "2026-06-01T19:55:00Z" })],
    orders: [],
    existingOutcomes: [],
    now: NOW,
    windowDays: 7,
  });
  assert.equal(rows.length, 0);
});

test("NO_ACTION intents produce no attempts", async () => {
  const { reconcileIntents } = await importModule();
  const rows = reconcileIntents({
    intents: [
      {
        id: "noop",
        timestamp: "2026-07-02T19:55:00Z",
        action_type: "NO_ACTION",
        symbol: null,
        reason_code: "BUY_BLOCKED",
      },
    ],
    orders: [],
    existingOutcomes: [],
    now: NOW,
  });
  assert.equal(rows.length, 0);
});

test("summarizeFillAttempts rolls up latest outcome per attempt", async () => {
  const { summarizeFillAttempts } = await importModule();
  const outcomes = [
    // Same attempt reported twice: open then filled — count once, as filled.
    {
      exchange_date: "2026-07-02",
      intent_id: "a",
      order_client_id: "a:KALV",
      symbol: "KALV",
      side: "buy",
      fill_status: "open",
    },
    {
      exchange_date: "2026-07-02",
      intent_id: "a",
      order_client_id: "a:KALV",
      symbol: "KALV",
      side: "buy",
      fill_status: "filled",
      filled_notional: 21,
    },
    {
      exchange_date: "2026-07-02",
      intent_id: "b",
      order_client_id: "b:KALV",
      symbol: "KALV",
      side: "buy",
      fill_status: "expired",
    },
    // Different day: excluded.
    {
      exchange_date: "2026-07-01",
      intent_id: "c",
      order_client_id: "c:PWV",
      symbol: "PWV",
      side: "buy",
      fill_status: "filled",
    },
  ];
  const summary = summarizeFillAttempts(outcomes, "2026-07-02");
  assert.equal(summary.attempts, 2);
  assert.equal(summary.fills, 1);
  assert.deepEqual(summary.bySymbol.KALV, { attempts: 2, fills: 1 });
});

test("runIntentReconciliation reads artifacts and appends outcomes", async (t) => {
  const { runIntentReconciliation } = await importModule();
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-intent-recon-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const intent = buyIntent({ timestamp: new Date().toISOString() });
  fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "logs", "intent_log.jsonl"),
    `${JSON.stringify(intent)}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "data", "portfolio-live.json"),
    JSON.stringify({
      recent_orders: [
        {
          id: "ord-1",
          client_order_id: `${intent.id}:KALV`,
          symbol: "KALV",
          side: "buy",
          status: "filled",
          filled_qty: "2",
          filled_avg_price: "10.50",
          submitted_at: new Date().toISOString(),
        },
      ],
    }),
  );

  const result = runIntentReconciliation();
  assert.equal(result.appended, 1);
  assert.equal(result.fills_today, 1);
  assert.equal(result.attempts_today, 1);

  const written = fs
    .readFileSync(path.join(tmpDir, "logs", "intent_outcomes.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(written.length, 1);
  assert.equal(written[0].fill_status, "filled");

  // Second run appends nothing (terminal outcome already recorded).
  const again = runIntentReconciliation();
  assert.equal(again.appended, 0);
});

test("degrades gracefully when artifacts are missing", async (t) => {
  const { runIntentReconciliation } = await importModule();
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-intent-empty-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = runIntentReconciliation();
  assert.equal(result.appended, 0);
  assert.equal(result.attempts_today, 0);
});
