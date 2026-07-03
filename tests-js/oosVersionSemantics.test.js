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

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Rows stamped with the policy version they were decided under (v1).
function buyRecord(intentId, entryDate = "2026-03-13") {
  return {
    intent_id: intentId,
    timestamp: `${entryDate}T20:55:00.000Z`,
    entry_date: entryDate,
    action_type: "BUY",
    policy_version: 1,
    symbol: `SYM${intentId.slice(-1)}`,
    horizons: {
      5: {
        signed_return: 0.02,
        benchmark_return: 0.01,
        excess_vs_benchmark: 0.01,
        excess_vs_cash: 0.02,
      },
      20: {
        signed_return: 0.04,
        benchmark_return: 0.01,
        excess_vs_benchmark: 0.03,
        excess_vs_cash: 0.04,
      },
    },
  };
}

async function importLocalTrainer() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "core", "localTrainer.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

function setupTmpRepo(t) {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-oos-version-"));
  process.chdir(tmpDir);

  const envKeys = [
    "VS_PHASE1_START_DATE",
    "VS_SCORECARD_LEARN",
    "VS_SCORECARD_MIN_SAMPLES",
    "VS_TRAIN_ONCE_PER_DAY",
    "VS_OOS_EVAL_ENABLED",
    "VS_OOS_MIN_SAMPLES",
    "VS_CHAMPION_CHALLENGER_ENABLED",
  ];
  const oldEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  process.env.VS_SCORECARD_LEARN = "true";
  process.env.VS_SCORECARD_MIN_SAMPLES = "1";
  process.env.VS_TRAIN_ONCE_PER_DAY = "false";
  process.env.VS_OOS_EVAL_ENABLED = "true";
  process.env.VS_OOS_MIN_SAMPLES = "1";
  process.env.VS_CHAMPION_CHALLENGER_ENABLED = "false";

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
    buyRecord("intent-1"),
    buyRecord("intent-2"),
  ]);
  return tmpDir;
}

test("strict OOS matches rows decided under the pre-chain version", async (t) => {
  setupTmpRepo(t);
  const { trainPolicyFromHistoryLocal } = await importLocalTrainer();

  trainPolicyFromHistoryLocal({ force: true });

  // The chain bumped the policy past v1 (scorecard and/or posteriors)...
  const savedPolicy = JSON.parse(
    fs.readFileSync(path.join("config", "policy.json"), "utf8"),
  );
  assert.ok(savedPolicy.version > 1, "trainer chain should bump the version");

  // ...yet strict OOS still evaluated the v1 rows (pre-fix: sampleCount 0,
  // insufficient forever).
  const oosRows = readJsonl(path.join("data", "oos-eval.jsonl"));
  const strict = oosRows[oosRows.length - 1].strict;
  assert.equal(strict.sampleCount, 2);
  assert.notEqual(strict.insufficient, true);
});

test("unchanged posteriors rebuild does not bump the policy version", async (t) => {
  setupTmpRepo(t);
  const { trainPolicyFromHistoryLocal } = await importLocalTrainer();

  trainPolicyFromHistoryLocal({ force: true });
  const versionAfterFirst = JSON.parse(
    fs.readFileSync(path.join("config", "policy.json"), "utf8"),
  ).version;

  trainPolicyFromHistoryLocal({ force: true });

  const trainingRows = readJsonl(path.join("data", "training-log.jsonl"));
  const posteriorRows = trainingRows.filter(
    (row) => row.source === "score_gate_posteriors",
  );
  assert.equal(posteriorRows.length, 2);
  assert.equal(posteriorRows[0].decision, "rebuild");
  assert.equal(posteriorRows[1].decision, "no_update");
  assert.equal(posteriorRows[1].reason, "posteriors_unchanged");
  assert.equal(
    posteriorRows[1].policyVersionAfter,
    posteriorRows[1].policyVersionBefore,
  );

  // No-samples cycles keep the historical reason.
  const secondRunVersion = JSON.parse(
    fs.readFileSync(path.join("config", "policy.json"), "utf8"),
  ).version;
  // The scorecard trainer may legitimately bump on the second run; the
  // posteriors specifically must not (asserted via the log rows above).
  assert.ok(secondRunVersion >= versionAfterFirst);
});
