import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importModule() {
  const moduleUrl = `${
    pathToFileURL(path.join(repoRoot, "core", "gateCalibration.js")).href
  }?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("classifyGate maps every decision-engine note shape", async () => {
  const { classifyGate } = await importModule();
  const cases = [
    ["Buy blocked: entry_quality score=1.2345<1.55", "score_floor"],
    ["Buy blocked: entry_quality rel20=-0.0100<=0.00", "rel_strength_20d"],
    ["Buy blocked: entry_quality rel60=-0.0566<=0.00", "rel_strength_60d"],
    ["Buy blocked: entry_quality trend=-0.1000<=0.00", "trend_strength"],
    [
      "Buy blocked: thompson_gate sample=0.412<0.55 alpha=2.0 beta=5.0 n=3",
      "thompson_gate",
    ],
    ["Buy blocked: signal_score=-0.2000", "negative_score"],
    [
      "Buy blocked: macro_label=stressed signal_score=0.0300<0.05",
      "macro_score_floor",
    ],
    ["Buy blocked: macro_label=stressed sector=TECH", "macro_sector"],
    ["Buy blocked: sandbox_headroom=$0.42 < min $1.00", "sandbox_headroom"],
    ["Buy blocked: sandbox_headroom_exhausted", "sandbox_headroom"],
    ["Buy blocked: something novel", "other"],
  ];
  for (const [explanation, expected] of cases) {
    assert.equal(classifyGate(explanation), expected, explanation);
  }
});

function blockedRecord({ intentId, excess }) {
  return {
    intent_id: intentId,
    reason_code: "BUY_BLOCKED",
    horizons: { 5: { excess_vs_benchmark: excess } },
  };
}

test("buildGateCalibration groups by gate and computes stats", async () => {
  const { buildGateCalibration } = await importModule();

  const intents = [];
  const records = [];
  // 12 rel60 blocks with mean negative excess (gate justified).
  for (let i = 0; i < 12; i += 1) {
    const id = `rel60-${i}`;
    intents.push({
      id,
      explanation: "Buy blocked: entry_quality rel60=-0.05<=0.00",
    });
    records.push(blockedRecord({ intentId: id, excess: -0.01 - i * 0.001 }));
  }
  // 3 score-floor blocks (insufficient).
  for (let i = 0; i < 3; i += 1) {
    const id = `score-${i}`;
    intents.push({
      id,
      explanation: "Buy blocked: entry_quality score=1.40<1.55",
    });
    records.push(blockedRecord({ intentId: id, excess: 0.02 + i * 0.001 }));
  }
  // A non-blocked row and an unmatched blocked row: both excluded from gates.
  records.push({ intent_id: "buy-1", reason_code: "BUY_FILLED" });
  records.push(blockedRecord({ intentId: "ghost", excess: 0.5 }));

  const result = buildGateCalibration({
    scorecardRecords: records,
    intents,
    horizon: 5,
    now: new Date("2026-07-02T21:00:00Z"),
  });

  assert.ok(result.generated_at.endsWith("Z"));
  assert.equal(result.total_blocked, 16);
  assert.equal(result.unmatched_intents, 1);
  assert.equal(result.gates.length, 2);

  const [rel60, score] = result.gates; // sorted by count desc
  assert.equal(rel60.gate, "rel_strength_60d");
  assert.equal(rel60.count, 12);
  assert.ok(rel60.mean_excess < 0);
  assert.ok(rel60.t_stat < -2);
  assert.equal(rel60.insufficient, false);

  assert.equal(score.gate, "score_floor");
  assert.equal(score.count, 3);
  assert.equal(score.insufficient, true);
});

test("markdown render includes the observation-only header and verdicts", async () => {
  const { buildGateCalibration, renderGateCalibrationMarkdown } =
    await importModule();
  const intents = [
    { id: "a", explanation: "Buy blocked: entry_quality rel60=-0.05<=0.00" },
  ];
  const records = Array.from({ length: 11 }, (_, i) =>
    blockedRecord({ intentId: "a", excess: -0.01 - i * 0.001 }),
  );
  const md = renderGateCalibrationMarkdown(
    buildGateCalibration({ scorecardRecords: records, intents, horizon: 5 }),
  );
  assert.match(md, /Observation only — do not act mid-run/);
  assert.match(md, /rel_strength_60d/);
  assert.match(md, /justified/);
});

test("runGateCalibration writes the markdown atomically in cwd", async (t) => {
  const { runGateCalibration } = await importModule();
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-gate-cal-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "logs", "intent_log.jsonl"),
    `${JSON.stringify({ id: "a", explanation: "Buy blocked: entry_quality rel20=-0.01<=0.00" })}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "data", "signal-scorecard.jsonl"),
    `${JSON.stringify(blockedRecord({ intentId: "a", excess: 0.01 }))}\n`,
  );

  const result = runGateCalibration();
  assert.equal(result.gates.length, 1);
  const md = fs.readFileSync(
    path.join(tmpDir, "data", "gate-calibration.md"),
    "utf8",
  );
  assert.match(md, /rel_strength_20d/);
});

test("degrades gracefully with no artifacts", async (t) => {
  const { runGateCalibration } = await importModule();
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-gate-empty-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = runGateCalibration();
  assert.equal(result.total_blocked, 0);
  assert.deepEqual(result.gates, []);
  assert.ok(fs.existsSync(path.join(tmpDir, "data", "gate-calibration.md")));
});
