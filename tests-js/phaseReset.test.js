import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importModule() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "core", "phaseReset.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

function setupTmpRepo(t) {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-phase-reset-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "data", "signal-scorecard.jsonl"),
    '{"intent_id":"a"}\n',
  );
  fs.writeFileSync(
    path.join(tmpDir, "logs", "intent_log.jsonl"),
    '{"id":"a"}\n',
  );
  fs.writeFileSync(
    path.join(tmpDir, "config", "policy.json"),
    JSON.stringify({
      schema_version: 1,
      version: 42,
      mode: "rebalance",
      risk_level: 0.2,
      rebalance_buffer_pct: 0.021,
      max_effective_capital_dollars: 20,
      max_trade_notional_dollars: 8,
      min_trade_notional_dollars: 1,
      signal_weights: {
        momentum: 0.95,
        vol: 0.55,
        drawdown: 0.4,
        by_regime: { calm: { momentum: 1 } },
        champion: { oos_sharpe: 0.3 },
      },
      score_gate_posteriors: { FVAL: { alpha: 0, beta: 3 } },
      score_gate_posteriors_meta: { sample_count: 3 },
      lastTrainingReason: "signal_weights_update",
    }),
  );
  return tmpDir;
}

test("plan lists only existing artifacts and validates inputs", async (t) => {
  setupTmpRepo(t);
  const { planPhaseReset } = await importModule();

  const plan = planPhaseReset({ runLabel: "run3", startDate: "2026-07-06" });
  const fromNames = plan.archives.map((m) => path.basename(m.from)).sort();
  assert.deepEqual(fromNames, ["intent_log.jsonl", "signal-scorecard.jsonl"]);
  assert.equal(plan.policy_reset, true);
  assert.equal(plan.state_patch.phase1_start_date, "2026-07-06");

  assert.throws(
    () => planPhaseReset({ runLabel: "Run 3!", startDate: "2026-07-06" }),
    /invalid run label/,
  );
  assert.throws(
    () => planPhaseReset({ runLabel: "run3", startDate: "07/06/2026" }),
    /invalid start date/,
  );
  assert.throws(
    () =>
      planPhaseReset({
        runLabel: "run3",
        startDate: "2026-07-06",
        capOverrides: { cap: -5 },
      }),
    /invalid cap/,
  );
  assert.throws(
    () =>
      planPhaseReset({
        runLabel: "run3",
        startDate: "2026-07-06",
        capOverrides: { cap: 2000, maxTrade: 5000 },
      }),
    /must not exceed cap/,
  );
});

test("caps are preserved when no overrides are given", async (t) => {
  const tmpDir = setupTmpRepo(t);
  const { executePhaseReset } = await importModule();

  executePhaseReset({
    runLabel: "run3",
    startDate: "2026-07-06",
    applyStatePatch: () => {},
  });
  const policy = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "config", "policy.json"), "utf8"),
  );
  assert.equal(policy.max_effective_capital_dollars, 20);
  assert.equal(policy.max_trade_notional_dollars, 8);
  assert.equal(policy.min_trade_notional_dollars, 1);
});

test("execute archives, truncates, resets learned policy, patches state", async (t) => {
  const tmpDir = setupTmpRepo(t);
  const { executePhaseReset } = await importModule();

  let appliedPatch = null;
  const result = executePhaseReset({
    runLabel: "run3",
    startDate: "2026-07-06",
    capOverrides: { cap: 2000, maxTrade: 500, minTrade: 100 },
    now: new Date("2026-07-05T12:00:00Z"),
    applyStatePatch: (patch) => {
      appliedPatch = patch;
    },
  });

  assert.equal(result.reason_code, "PHASE_RESET_EXECUTED");
  assert.equal(result.archived.length, 2);
  assert.ok(result.timestamp.endsWith("Z"));

  // Archived copies exist; originals are gone.
  assert.ok(
    fs.existsSync(
      path.join(tmpDir, "data", "archive", "run3", "signal-scorecard.jsonl"),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(tmpDir, "logs", "archive", "run3", "intent_log.jsonl"),
    ),
  );
  assert.ok(
    !fs.existsSync(path.join(tmpDir, "data", "signal-scorecard.jsonl")),
  );
  assert.ok(!fs.existsSync(path.join(tmpDir, "logs", "intent_log.jsonl")));

  // Learned policy blocks wiped, operator fields preserved, version back to 1.
  const policy = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "config", "policy.json"), "utf8"),
  );
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.signal_weights, {});
  assert.deepEqual(policy.score_gate_posteriors, {});
  assert.equal(policy.score_gate_posteriors_meta, undefined);
  assert.equal(policy.lastTrainingReason, "phase1_run3_reset");
  assert.equal(policy.risk_level, 0.2);
  assert.equal(policy.rebalance_buffer_pct, 0.021);

  // Cap overrides applied.
  assert.equal(policy.max_effective_capital_dollars, 2000);
  assert.equal(policy.max_trade_notional_dollars, 500);
  assert.equal(policy.min_trade_notional_dollars, 100);

  // Phase fields patched.
  assert.equal(appliedPatch.phase1_start_date, "2026-07-06");
  assert.deepEqual(appliedPatch.phase1_milestones_sent, []);
  assert.equal(appliedPatch.phase1_ready_notified, false);
  assert.equal(appliedPatch.executions_today, 0);
});

test("execute is safe to re-run — nothing left to archive", async (t) => {
  setupTmpRepo(t);
  const { executePhaseReset } = await importModule();
  const noopPatch = () => {};

  executePhaseReset({
    runLabel: "run3",
    startDate: "2026-07-06",
    applyStatePatch: noopPatch,
  });
  const second = executePhaseReset({
    runLabel: "run3",
    startDate: "2026-07-06",
    applyStatePatch: noopPatch,
  });
  assert.equal(second.archived.length, 0);
});
