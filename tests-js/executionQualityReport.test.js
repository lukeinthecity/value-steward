import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importModule() {
  const moduleUrl = `${pathToFileURL(
    path.join(repoRoot, "core", "executionQualityReport.js")
  ).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

const NOW = new Date("2026-07-02T21:00:00Z");

function outcome({ intentId, symbol = "AAA", filled, date = "2026-07-01" }) {
  return {
    exchange_date: date,
    intent_id: intentId,
    order_client_id: `${intentId}:${symbol}`,
    symbol,
    side: "buy",
    fill_status: filled ? "filled" : "expired",
    filled_notional: filled ? 10 : null,
  };
}

function scorecardRow({ intentId, score, excess5d }) {
  return {
    intent_id: intentId,
    signal_score: score,
    horizons: { 5: { excess_vs_benchmark: excess5d } },
  };
}

test("snapshot computes fill rate, buckets, and adverse selection", async () => {
  const { buildExecutionQualitySnapshot } = await importModule();

  // 6 attempts: scores 1..6; the three high-score ones expired (adverse case),
  // the three low-score ones filled.
  const outcomes = [];
  const scorecard = [];
  for (let i = 1; i <= 6; i += 1) {
    const id = `intent-${i}`;
    const filled = i <= 3;
    outcomes.push(outcome({ intentId: id, filled }));
    scorecard.push(
      scorecardRow({
        intentId: id,
        score: i,
        // Unfilled (high-score) names outperformed: +2%; filled ones: 0%.
        excess5d: filled ? 0.0 + i * 0.001 : 0.02 + i * 0.001,
      })
    );
  }

  const snap = buildExecutionQualitySnapshot({
    outcomes,
    scorecardRecords: scorecard,
    now: NOW,
    windowDays: 30,
  });

  assert.equal(snap.attempts, 6);
  assert.equal(snap.fills, 3);
  assert.equal(snap.fill_rate, 0.5);
  assert.ok(snap.timestamp.endsWith("Z"));
  assert.equal(snap.reason_code, "EXECUTION_QUALITY_SNAPSHOT");

  assert.equal(snap.by_score_bucket.length, 3);
  const [low, , high] = snap.by_score_bucket;
  assert.equal(low.bucket, "low");
  assert.equal(low.fill_rate, 1); // scores 1,2 both filled
  assert.equal(high.bucket, "high");
  assert.equal(high.fill_rate, 0); // scores 5,6 both expired

  const adv = snap.adverse_selection;
  assert.equal(adv.n_filled, 3);
  assert.equal(adv.n_unfilled, 3);
  assert.ok(adv.diff > 0.015); // unfilled outperformed filled
  assert.ok(adv.t_stat > 0);
});

test("duplicate outcome rows collapse to the latest per attempt", async () => {
  const { buildExecutionQualitySnapshot } = await importModule();
  const open = { ...outcome({ intentId: "a", filled: false }), fill_status: "open" };
  const done = outcome({ intentId: "a", filled: true });
  const snap = buildExecutionQualitySnapshot({
    outcomes: [open, done],
    scorecardRecords: [],
    now: NOW,
    windowDays: 30,
  });
  assert.equal(snap.attempts, 1);
  assert.equal(snap.fills, 1);
});

test("attempts outside the window are excluded", async () => {
  const { buildExecutionQualitySnapshot } = await importModule();
  const snap = buildExecutionQualitySnapshot({
    outcomes: [outcome({ intentId: "old", filled: true, date: "2026-05-01" })],
    scorecardRecords: [],
    now: NOW,
    windowDays: 30,
  });
  assert.equal(snap.attempts, 0);
  assert.equal(snap.fill_rate, null);
  assert.deepEqual(snap.by_score_bucket, []);
});

test("unscored and unmatured attempts degrade gracefully", async () => {
  const { buildExecutionQualitySnapshot } = await importModule();
  const snap = buildExecutionQualitySnapshot({
    outcomes: [outcome({ intentId: "no-scorecard", filled: true })],
    scorecardRecords: [],
    now: NOW,
    windowDays: 30,
  });
  assert.equal(snap.attempts, 1);
  assert.deepEqual(snap.by_score_bucket, []);
  assert.equal(snap.adverse_selection.diff, null);
  assert.equal(snap.adverse_selection.t_stat, null);
});

test("runExecutionQualityReport appends a snapshot row", async (t) => {
  const { runExecutionQualityReport } = await importModule();
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-exec-quality-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(tmpDir, "logs", "intent_outcomes.jsonl"),
    `${JSON.stringify(outcome({ intentId: "x", filled: true, date: today }))}\n`
  );

  const snapshot = runExecutionQualityReport({ windowDays: 30 });
  assert.equal(snapshot.attempts, 1);

  const written = fs
    .readFileSync(path.join(tmpDir, "data", "execution-quality.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(written.length, 1);
  assert.equal(written[0].reason_code, "EXECUTION_QUALITY_SNAPSHOT");
});

test("degrades gracefully with no artifacts at all", async (t) => {
  const { runExecutionQualityReport } = await importModule();
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-exec-empty-"));
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const snapshot = runExecutionQualityReport();
  assert.equal(snapshot.attempts, 0);
});
