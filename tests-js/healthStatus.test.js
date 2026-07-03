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

async function importHealthStatus() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "core", "healthStatus.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("phase email gating respects final-decision requirement", async (t) => {
  const { shouldSendPhaseEmail } = await importHealthStatus();

  const previous = process.env.VS_PHASE_EMAIL_EOD_ONLY;
  process.env.VS_PHASE_EMAIL_EOD_ONLY = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.VS_PHASE_EMAIL_EOD_ONLY;
    else process.env.VS_PHASE_EMAIL_EOD_ONLY = previous;
  });

  const decision = shouldSendPhaseEmail({
    agentState: {
      phase1_milestones_sent: [],
      phase1_ready_notified: false,
    },
    phase: {
      trading_days: 15,
      milestones: [15, 30, 45, 60],
      ready_for_review: false,
    },
    isFinalDecision: false,
  });

  assert.equal(decision.send, false);
  assert.equal(decision.reason, "eod_only");
});

test("health snapshot reads policyVersionAfter from training log", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-health-status-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJsonl(path.join("data", "training-log.jsonl"), [
    {
      ranAt: "2026-03-13T20:55:00.000Z",
      reason: "update",
      policyVersionAfter: 9,
    },
  ]);

  const { buildHealthSnapshot } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      last_run_at: "2026-03-13T20:55:00.000Z",
      last_executed_at: null,
      last_executed_date: null,
      executions_today: 0,
    },
    policy: {
      version: 8,
      mode: "rebalance",
      risk_level: 0.2,
    },
    worldContext: {
      generated_at: "2026-03-13T20:30:00.000Z",
      date: "2026-03-13",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["source-a"],
      raw_count: 10,
    },
  });

  assert.equal(snapshot.training.policy_version, 9);
});

test("health snapshot filters scorecard progress to the configured phase1 start date", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-health-phase1-"));
  process.chdir(tmpDir);
  const previousStart = process.env.VS_PHASE1_START_DATE;
  process.env.VS_PHASE1_START_DATE = "2026-03-16";

  t.after(() => {
    process.chdir(prevCwd);
    if (previousStart === undefined) delete process.env.VS_PHASE1_START_DATE;
    else process.env.VS_PHASE1_START_DATE = previousStart;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "scorecard-summary.json"), {
    generated_at: "2026-03-13T20:15:00.000Z",
    phase1_start_date: "2026-03-13",
    horizons: {
      1: {
        avg_excess_benchmark: 0.01,
      },
    },
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    { entry_date: "2026-03-13", timestamp: "2026-03-13T19:55:00.000Z" },
    { entry_date: "2026-03-16", timestamp: "2026-03-16T19:55:00.000Z" },
  ]);

  const { buildHealthSnapshot, buildPhase1Status } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      phase1_start_date: "2026-03-16",
      last_run_at: "2026-03-16T20:00:00.000Z",
      last_executed_at: null,
      last_executed_date: null,
      executions_today: 0,
    },
    policy: {
      version: 8,
      mode: "rebalance",
      risk_level: 0.2,
    },
    worldContext: {
      generated_at: "2026-03-16T19:30:00.000Z",
      date: "2026-03-16",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["source-a"],
      raw_count: 10,
    },
  });
  const phase = buildPhase1Status({
    agentState: {
      phase1_start_date: "2026-03-16",
    },
  });

  assert.equal(snapshot.scorecard.trading_days, 1);
  assert.equal(snapshot.scorecard.records, 1);
  assert.equal(snapshot.scorecard.summary_generated_at, null);
  assert.equal(phase.trading_days, 1);
  assert.equal(phase.records, 1);
  assert.deepEqual(phase.horizons, {});
});

test("health snapshot flags stale tick and portfolio artifacts", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-health-artifacts-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "steward-state.json"), {
    current_mode: "LIVE",
    last_run_at: "2026-03-20T15:00:00.000Z",
    executions_today: 0,
  });
  writeJson(path.join("data", "latest-tick.json"), {
    generated_at: "2026-03-19T20:00:00.000Z",
    exchange_date: "2026-03-19",
    result: {
      ranAt: "2026-03-19T20:00:00.000Z",
    },
  });
  writeJson(path.join("data", "portfolio-live.json"), {
    updated_at: "2026-03-15T20:00:00.000Z",
    snapshot: {
      timestamp: "2026-03-15T20:00:00.000Z",
      equity: 100000,
      cash: 100000,
    },
    positions: [],
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: "2026-03-20T16:00:00.000Z",
    sources: {},
  });

  const { buildHealthSnapshot } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      current_mode: "LIVE",
      last_run_at: "2026-03-20T15:00:00.000Z",
      executions_today: 0,
    },
    policy: {
      version: 8,
      mode: "rebalance",
      risk_level: 0.2,
    },
    worldContext: {
      generated_at: "2026-03-20T15:30:00.000Z",
      date: "2026-03-20",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["source-a"],
      raw_count: 10,
    },
  });

  const issueCodes = snapshot.issues.map((issue) => issue.code);
  assert.equal(snapshot.artifacts.latest_tick.exchange_date, "2026-03-19");
  assert.equal(snapshot.artifacts.portfolio.exchange_date, "2026-03-15");
  assert.equal(issueCodes.includes("tick_artifact_stale"), true);
  assert.equal(issueCodes.includes("portfolio_artifact_stale"), true);
});

test("health snapshot accepts prior trading-day tick artifacts on market holidays", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-health-holiday-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "steward-state.json"), {
    current_mode: "LIVE",
    last_run_at: "2026-04-02T19:55:12.000Z",
    executions_today: 0,
  });
  writeJson(path.join("data", "latest-tick.json"), {
    generated_at: "2026-04-02T19:55:12.000Z",
    exchange_date: "2026-04-02",
    result: {
      ranAt: "2026-04-02T19:55:12.000Z",
    },
  });
  writeJson(path.join("data", "portfolio-live.json"), {
    updated_at: "2026-04-03T13:00:04.000Z",
    snapshot: {
      timestamp: "2026-04-03T13:00:04.000Z",
      equity: 100000,
      cash: 100000,
    },
    positions: [],
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: "2026-04-03T20:00:00.000Z",
    sources: {},
  });

  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(value) {
      super(value ?? "2026-04-03T20:15:00.000Z");
    }

    static now() {
      return new RealDate("2026-04-03T20:15:00.000Z").getTime();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  };
  t.after(() => {
    global.Date = RealDate;
  });

  const { buildHealthSnapshot } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      current_mode: "LIVE",
      last_run_at: "2026-04-02T19:55:12.000Z",
      executions_today: 0,
    },
    policy: {
      version: 8,
      mode: "rebalance",
      risk_level: 0.2,
    },
    worldContext: {
      generated_at: "2026-04-03T19:30:00.000Z",
      date: "2026-04-03",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      sources_used: ["source-a"],
      raw_count: 10,
    },
  });

  const issueCodes = snapshot.issues.map((issue) => issue.code);
  assert.equal(snapshot.tick.expected_exchange_date, "2026-04-02");
  assert.equal(issueCodes.includes("tick_stale"), false);
  assert.equal(issueCodes.includes("tick_artifact_stale"), false);
});

test("null last_run_at reports unreadable state, not tick_stale", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vs-health-unreadable-"),
  );
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: new Date().toISOString(),
    sources: {},
  });

  const { buildHealthSnapshot } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      current_mode: "LIVE",
      last_run_at: null,
      executions_today: 0,
    },
    policy: { version: 8, mode: "rebalance", risk_level: 0.2 },
    worldContext: {
      generated_at: new Date().toISOString(),
      date: "2026-06-28",
      slot: "pre_open",
    },
  });

  const codes = snapshot.issues.map((issue) => issue.code);
  assert.equal(codes.includes("tick_state_unreadable"), true);
  assert.equal(codes.includes("tick_stale"), false);
});

test("fresh world-context file with stale parsed entry reports a read anomaly, not stale", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vs-health-world-anomaly-"),
  );
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: new Date().toISOString(),
    sources: {},
  });
  // Fresh file (mtime now); the injected context simulates a transient old read.
  writeJsonl(path.join("data", "world-context.jsonl"), [
    { generated_at: "2026-06-28T10:00:00.000Z", date: "2026-06-28" },
  ]);

  const { buildHealthSnapshot } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      current_mode: "LIVE",
      last_run_at: new Date().toISOString(),
      executions_today: 0,
    },
    policy: { version: 8, mode: "rebalance", risk_level: 0.2 },
    worldContext: {
      generated_at: "2026-03-20T15:30:00.000Z",
      date: "2026-03-20",
      slot: "pre_close",
    },
  });

  const codes = snapshot.issues.map((issue) => issue.code);
  assert.equal(codes.includes("world_context_read_anomaly"), true);
  assert.equal(codes.includes("world_context_stale"), false);
});

test("genuinely stale world (no fresh file) still flags world_context_stale", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vs-health-world-stale-"),
  );
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    version: 8,
    mode: "rebalance",
    risk_level: 0.2,
  });
  writeJson(path.join("data", "world-health.json"), {
    last_checked: new Date().toISOString(),
    sources: {},
  });
  // No world-context.jsonl on disk — nothing vouches for a live pipeline.

  const { buildHealthSnapshot } = await importHealthStatus();
  const snapshot = await buildHealthSnapshot({
    agentState: {
      current_mode: "LIVE",
      last_run_at: new Date().toISOString(),
      executions_today: 0,
    },
    policy: { version: 8, mode: "rebalance", risk_level: 0.2 },
    worldContext: {
      generated_at: "2026-03-20T15:30:00.000Z",
      date: "2026-03-20",
      slot: "pre_close",
    },
  });

  const codes = snapshot.issues.map((issue) => issue.code);
  assert.equal(codes.includes("world_context_stale"), true);
  assert.equal(codes.includes("world_context_read_anomaly"), false);
});
