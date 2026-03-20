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
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
}

function buildPositiveScorecardRecord(intentId, entryDate = "2026-03-13") {
  return {
    intent_id: intentId,
    timestamp: `${entryDate}T20:55:00.000Z`,
    entry_date: entryDate,
    horizons: {
      "5": {
        signed_return: 0.02,
        benchmark_return: 0.01,
        excess_vs_benchmark: 0.01,
        excess_vs_cash: 0.02,
      },
      "20": {
        signed_return: 0.04,
        benchmark_return: 0.01,
        excess_vs_benchmark: 0.03,
        excess_vs_cash: 0.04,
      },
    },
  };
}

function buildPositiveHistory() {
  return Array.from({ length: 10 }, (_, index) => ({
    ranAt: `2026-03-13T2${index % 4}:00:00.000Z`,
    equity: 100 + index,
    cashUtilization: 0.1,
    grossExposure: 50,
    portfolioValue: 100 + index,
    maxPositionWeight: 0.1,
  }));
}

async function importLocalTrainer() {
  const moduleUrl =
    `${pathToFileURL(path.join(repoRoot, "core", "localTrainer.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("local trainer applies scorecard learning in rebalance mode", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-trainer-scorecard-"));
  process.chdir(tmpDir);

  const envKeys = [
    "VS_PHASE1_START_DATE",
    "VS_SCORECARD_LEARN",
    "VS_SCORECARD_MIN_SAMPLES",
    "VS_TRAIN_ONCE_PER_DAY",
  ];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.VS_SCORECARD_LEARN = "true";
  process.env.VS_SCORECARD_MIN_SAMPLES = "1";
  process.env.VS_TRAIN_ONCE_PER_DAY = "true";

  t.after(() => {
    process.chdir(prevCwd);
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    schema_version: 1,
    version: 1,
    mode: "rebalance",
    risk_level: 0.2,
    rebalance_buffer_pct: 0.02,
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildPositiveScorecardRecord("intent-1"),
  ]);

  const { trainPolicyFromHistoryLocal } = await importLocalTrainer();
  const result = trainPolicyFromHistoryLocal();

  assert.equal(result.updated, true);
  assert.equal(result.reason, "scorecard_update");
  assert.equal(result.source, "scorecard");

  const savedPolicy = JSON.parse(
    fs.readFileSync(path.join("config", "policy.json"), "utf8")
  );
  assert.equal(savedPolicy.version, 2);
  assert.equal(savedPolicy.lastTrainingReason, "scorecard_update");
});

test("local trainer falls back to history and only attempts once per day", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-trainer-history-"));
  process.chdir(tmpDir);

  const envKeys = [
    "VS_SCORECARD_LEARN",
    "VS_TRAIN_ONCE_PER_DAY",
  ];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.VS_SCORECARD_LEARN = "false";
  process.env.VS_TRAIN_ONCE_PER_DAY = "true";

  t.after(() => {
    process.chdir(prevCwd);
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    schema_version: 1,
    version: 1,
    mode: "rebalance",
    risk_level: 0.2,
    rebalance_buffer_pct: 0.02,
  });
  writeJsonl(path.join("data", "history.jsonl"), buildPositiveHistory());

  const { trainPolicyFromHistoryLocal } = await importLocalTrainer();

  const first = trainPolicyFromHistoryLocal({ force: true });
  assert.equal(first.updated, true);
  assert.equal(first.reason, "update");

  const second = trainPolicyFromHistoryLocal();
  assert.equal(second.updated, false);
  assert.equal(second.reason, "already_attempted_today");

  const savedPolicy = JSON.parse(
    fs.readFileSync(path.join("config", "policy.json"), "utf8")
  );
  assert.equal(savedPolicy.version, 2);
});

test("local trainer force bypasses scorecard cooldown guards", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-trainer-force-"));
  process.chdir(tmpDir);

  const envKeys = [
    "VS_SCORECARD_LEARN",
    "VS_SCORECARD_MIN_SAMPLES",
    "VS_TRAIN_ONCE_PER_DAY",
  ];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.VS_SCORECARD_LEARN = "true";
  process.env.VS_SCORECARD_MIN_SAMPLES = "1";
  process.env.VS_TRAIN_ONCE_PER_DAY = "true";

  t.after(() => {
    process.chdir(prevCwd);
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    schema_version: 1,
    version: 3,
    mode: "rebalance",
    risk_level: 0.2,
    rebalance_buffer_pct: 0.02,
    lastScorecardAt: "2026-03-13T20:55:00.000Z",
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildPositiveScorecardRecord("intent-1"),
  ]);

  const { trainPolicyFromHistoryLocal } = await importLocalTrainer();
  const result = trainPolicyFromHistoryLocal({ force: true });

  assert.equal(result.updated, true);
  assert.equal(result.reason, "scorecard_update");
  assert.equal(result.source, "scorecard");

  const savedPolicy = JSON.parse(
    fs.readFileSync(path.join("config", "policy.json"), "utf8")
  );
  assert.equal(savedPolicy.version, 4);
});

test("local trainer ignores scorecard records from before the phase1 start date", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-trainer-phase1-"));
  process.chdir(tmpDir);

  const envKeys = [
    "VS_SCORECARD_LEARN",
    "VS_SCORECARD_MIN_SAMPLES",
    "VS_TRAIN_ONCE_PER_DAY",
  ];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.VS_PHASE1_START_DATE = "2026-03-16";
  process.env.VS_SCORECARD_LEARN = "true";
  process.env.VS_SCORECARD_MIN_SAMPLES = "1";
  process.env.VS_TRAIN_ONCE_PER_DAY = "false";

  t.after(() => {
    process.chdir(prevCwd);
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  writeJson(path.join("config", "policy.json"), {
    schema_version: 1,
    version: 3,
    mode: "rebalance",
    risk_level: 0.2,
    rebalance_buffer_pct: 0.02,
  });
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    buildPositiveScorecardRecord("intent-1", "2026-03-13"),
  ]);

  const { trainPolicyFromHistoryLocal } = await importLocalTrainer();
  const result = trainPolicyFromHistoryLocal({ force: true });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "no_history");
});
