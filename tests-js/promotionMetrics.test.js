import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

async function importPromotionMetrics() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "core", "promotionMetrics.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("daily promotion snapshot flags cap breaches and reconciliation mismatches", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-promotion-daily-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 53,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: "2026-03-20T19:40:00.000Z",
    sources: {},
  });
  writeJson(path.join("data", "steward-state.json"), {
    current_mode: "LIVE",
    last_run_at: "2026-03-20T19:55:00.000Z",
    trading_enabled: true,
    force_no_trade: false,
    executions_today: 1,
    version: 1,
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    { entry_date: "2026-03-20", timestamp: "2026-03-20T19:55:00.000Z" },
  ]);

  const { buildDailyPromotionSnapshot } = await importPromotionMetrics();
  const snapshot = await buildDailyPromotionSnapshot({
    state: {
      current_mode: "LIVE",
      last_run_at: "2026-03-20T19:55:00.000Z",
      trading_enabled: true,
      force_no_trade: false,
      executions_today: 1,
    },
    policy: {
      version: 53,
      mode: "rebalance",
      risk_level: 0.2,
    },
    tickSnapshot: {
      result: {
        ranAt: "2026-03-20T20:15:00.000Z",
        equity: 100000,
        positions: [{ symbol: "SMALL" }],
      },
    },
    portfolio: {
      updated_at: "2026-03-20T20:15:00.000Z",
      account: { equity: 99980 },
      positions: [
        { symbol: "MARM", market_value: 15985.61 },
        { symbol: "SPY", market_value: 5.0 },
      ],
    },
    worldContext: {
      generated_at: "2026-03-20T20:00:00.000Z",
      date: "2026-03-20",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["a"],
      raw_count: 10,
    },
  });

  assert.equal(snapshot.cap_compliance.pass, false);
  assert.equal(snapshot.cap_compliance.oversized_count, 1);
  assert.equal(snapshot.reconciliation.pass, false);
  assert.match(snapshot.blockers.join(","), /cap_breach/);
  assert.match(
    snapshot.blockers.join(","),
    /position_count_mismatch|equity_mismatch/,
  );
  assert.equal(snapshot.verdict, "not_eligible");
});

test("daily promotion snapshot fails cap compliance when total deployed exceeds sandbox cap", async () => {
  const { buildDailyPromotionSnapshot } = await importPromotionMetrics();

  const snapshot = await buildDailyPromotionSnapshot({
    state: {
      current_mode: "LIVE",
      last_run_at: "2026-04-13T19:55:00.000Z",
      trading_enabled: true,
      force_no_trade: false,
      executions_today: 1,
    },
    policy: {
      version: 57,
      mode: "rebalance",
      risk_level: 0.2,
      max_effective_capital_dollars: 20,
      max_trade_notional_dollars: 5,
    },
    tickSnapshot: {
      result: {
        ranAt: "2026-04-13T20:15:00.000Z",
        equity: 100000,
        positions: [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }],
      },
    },
    portfolio: {
      updated_at: "2026-04-13T20:15:00.000Z",
      account: { equity: 100000 },
      positions: [
        { symbol: "A", market_value: 10.0 },
        { symbol: "B", market_value: 5.0 },
        { symbol: "C", market_value: 6.0 },
      ],
    },
    worldContext: {
      generated_at: "2026-04-13T20:00:00.000Z",
      date: "2026-04-13",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["a"],
      raw_count: 10,
    },
  });

  assert.equal(snapshot.cap_compliance.total_deployed_dollars, 21);
  assert.equal(snapshot.cap_compliance.total_deployed_over_cap, true);
  assert.equal(snapshot.cap_compliance.pass, false);
  assert.match(snapshot.blockers.join(","), /cap_breach/);
});

test("daily promotion snapshot treats health warnings as readiness blockers", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-promotion-health-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 53,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: "2026-03-19T00:00:00.000Z",
    sources: {},
  });
  writeJson(path.join("data", "steward-state.json"), {
    current_mode: "LIVE",
    last_run_at: "2026-03-18T19:55:00.000Z",
    trading_enabled: true,
    force_no_trade: false,
    executions_today: 0,
    version: 1,
  });

  const { buildDailyPromotionSnapshot } = await importPromotionMetrics();
  const snapshot = await buildDailyPromotionSnapshot({
    state: {
      current_mode: "LIVE",
      last_run_at: "2026-03-18T19:55:00.000Z",
      trading_enabled: true,
      force_no_trade: false,
      executions_today: 0,
    },
    policy: {
      version: 53,
      mode: "rebalance",
      risk_level: 0.2,
    },
    tickSnapshot: {
      result: {
        ranAt: "2026-03-20T20:15:00.000Z",
        equity: 100000,
        positions: [],
      },
    },
    portfolio: {
      updated_at: "2026-03-20T20:15:00.000Z",
      account: { equity: 100000 },
      positions: [],
    },
    worldContext: {
      generated_at: "2026-03-20T20:00:00.000Z",
      date: "2026-03-20",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["a"],
      raw_count: 10,
    },
  });

  assert.equal(snapshot.integrity.pass, false);
  assert.match(snapshot.blockers.join(","), /health_tick_stale/);
  assert.equal(snapshot.verdict, "not_eligible");
});

test("weekly promotion summary uses weekly blockers and keeps current blockers separate", async () => {
  const { buildWeeklyPromotionSummary } = await importPromotionMetrics();

  const records = Array.from({ length: 10 }, (_, index) => ({
    entry_date: `2026-04-${String(index + 1).padStart(2, "0")}`,
    timestamp: `2026-04-${String(index + 1).padStart(2, "0")}T19:55:00.000Z`,
    action_type: "BUY",
    horizons: {
      1: {
        excess_vs_benchmark: 0.002,
        excess_vs_cash: 0.003,
        directional_correct: true,
      },
    },
  }));
  const intents = records.map((record) => ({
    timestamp: record.timestamp,
    action_type: "BUY",
    policy_version: 53,
  }));

  const summary = buildWeeklyPromotionSummary({
    records,
    intents,
    latestDailyPromotion: {
      blockers: ["cap_breach"],
      cap_compliance: { pass: true },
    },
  });

  assert.equal(summary.stage, "behavioral_competence");
  assert.equal(summary.verdict, "watchlist");
  assert.equal(summary.metrics.trading_days, 10);
  assert.equal(summary.risk_score, 100);
  assert.deepEqual(summary.blockers, []);
  assert.deepEqual(summary.current_blockers, ["cap_breach"]);
});
