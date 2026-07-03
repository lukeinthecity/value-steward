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

function buildScorecardRecord({
  intentId,
  actionType,
  excess5,
  excess20,
  reasonCode = null,
}) {
  return {
    intent_id: intentId,
    timestamp: "2026-04-28T20:15:00.000Z",
    entry_date: "2026-04-28",
    action_type: actionType,
    reason_code: reasonCode,
    horizons: {
      5: {
        signed_return: 0.02,
        benchmark_return: 0.01,
        excess_vs_benchmark: excess5,
        excess_vs_cash: 0.02,
      },
      20: {
        signed_return: 0.03,
        benchmark_return: 0.01,
        excess_vs_benchmark: excess20,
        excess_vs_cash: 0.03,
      },
    },
  };
}

async function importScorecardTrainer() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "core", "scorecardTrainer.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("scorecard trainer updates from buy rows without dilution from no-action rows", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vs-scorecard-trainer-"),
  );
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("data", "steward-state.json"), {
    phase1_start_date: "2026-03-30",
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildScorecardRecord({
      intentId: "buy-1",
      actionType: "BUY",
      excess5: 0.02,
      excess20: 0.03,
    }),
    buildScorecardRecord({
      intentId: "no-1",
      actionType: "NO_ACTION",
      excess5: -0.05,
      excess20: -0.06,
    }),
  ]);

  const { trainPolicyWithScorecard } = await importScorecardTrainer();
  const result = trainPolicyWithScorecard({
    policy: {
      version: 1,
      mode: "rebalance",
      risk_level: 0.2,
      rebalance_buffer_pct: 0.02,
    },
    minSamples: 1,
    benchmarkThreshold: 0,
    force: true,
  });

  assert.equal(result.updated, true);
  assert.equal(result.reason, "scorecard_update");
  assert.equal(result.scorecardSummary.training.sampleCount, 1);
  assert.equal(result.scorecardSummary.noAction.sampleCount, 1);
  assert.equal(
    result.scorecardSummary.training.horizons["5"].avgExcessBenchmark,
    0.02,
  );
});

test("scorecard trainer ignores no-action rows that lack a trainable reason_code", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vs-scorecard-buy-samples-"),
  );
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("data", "steward-state.json"), {
    phase1_start_date: "2026-03-30",
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildScorecardRecord({
      intentId: "no-1",
      actionType: "NO_ACTION",
      excess5: 0.01,
      excess20: 0.02,
      reasonCode: "NO_SIGNAL",
    }),
    buildScorecardRecord({
      intentId: "no-2",
      actionType: "NO_ACTION",
      excess5: 0.02,
      excess20: 0.03,
      reasonCode: "MACRO_CRISIS",
    }),
  ]);

  const { trainPolicyWithScorecard } = await importScorecardTrainer();
  const result = trainPolicyWithScorecard({
    policy: {
      version: 1,
      mode: "rebalance",
      risk_level: 0.2,
      rebalance_buffer_pct: 0.02,
    },
    minSamples: 1,
    benchmarkThreshold: 0,
    force: true,
  });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "insufficient_buy_samples");
  assert.equal(result.scorecardSummary.training.sampleCount, 0);
  assert.equal(result.scorecardSummary.noAction.sampleCount, 2);
});

test("scorecard trainer includes BUY_BLOCKED counterfactuals in training", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vs-scorecard-counterfactual-"),
  );
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("data", "steward-state.json"), {
    phase1_start_date: "2026-03-30",
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildScorecardRecord({
      intentId: "blocked-1",
      actionType: "NO_ACTION",
      reasonCode: "BUY_BLOCKED",
      excess5: 0.015,
      excess20: 0.025,
    }),
    buildScorecardRecord({
      intentId: "blocked-2",
      actionType: "NO_ACTION",
      reasonCode: "BUY_BLOCKED",
      excess5: 0.02,
      excess20: 0.03,
    }),
    buildScorecardRecord({
      intentId: "no-signal",
      actionType: "NO_ACTION",
      reasonCode: "NO_SIGNAL",
      excess5: -0.05,
      excess20: -0.06,
    }),
  ]);

  const { trainPolicyWithScorecard } = await importScorecardTrainer();
  const result = trainPolicyWithScorecard({
    policy: {
      version: 1,
      mode: "rebalance",
      risk_level: 0.2,
      rebalance_buffer_pct: 0.02,
    },
    minSamples: 2,
    benchmarkThreshold: 0,
    force: true,
  });

  assert.equal(
    result.updated,
    true,
    "counterfactuals should drive a policy update",
  );
  assert.equal(result.reason, "scorecard_update");
  assert.equal(
    result.scorecardSummary.training.sampleCount,
    2,
    "only BUY_BLOCKED rows should be in training, not the NO_SIGNAL row",
  );
  assert.equal(
    result.scorecardSummary.buyBlockedCounterfactual.sampleCount,
    2,
    "buyBlockedCounterfactual summary should show 2 rows",
  );
  // Positive avgExcessBenchmark on counterfactuals → trainer raises risk
  assert.ok(
    result.newRisk > result.oldRisk,
    "positive counterfactual excess return should raise risk_level",
  );
});

test("scorecard trainer respects custom trainingReasonPrefixes", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-scorecard-prefix-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("data", "steward-state.json"), {
    phase1_start_date: "2026-03-30",
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildScorecardRecord({
      intentId: "blocked-1",
      actionType: "NO_ACTION",
      reasonCode: "BUY_BLOCKED",
      excess5: 0.02,
      excess20: 0.03,
    }),
  ]);

  const { trainPolicyWithScorecard } = await importScorecardTrainer();
  // Pass empty prefix list — counterfactuals should NOT be included.
  const result = trainPolicyWithScorecard({
    policy: {
      version: 1,
      mode: "rebalance",
      risk_level: 0.2,
      rebalance_buffer_pct: 0.02,
    },
    minSamples: 1,
    benchmarkThreshold: 0,
    trainingReasonPrefixes: [],
    force: true,
  });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "insufficient_buy_samples");
  assert.equal(result.scorecardSummary.training.sampleCount, 0);
});
