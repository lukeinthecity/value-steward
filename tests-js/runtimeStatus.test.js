import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, "scripts", "runtimeStatus.js");

function setupTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-runtime-status-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "steward-state.json"),
    JSON.stringify({
      current_mode: "LIVE",
      trading_enabled: true,
      force_no_trade: false,
      executions_today: 3,
      last_executed_at: "2026-05-20T19:50:13.000Z",
      daily_starting_equity: 99976.22,
      phase1_start_date: "2026-05-18",
    })
  );
  fs.writeFileSync(
    path.join(dir, "config", "policy.json"),
    JSON.stringify({ version: 77 })
  );
  fs.writeFileSync(
    path.join(dir, "data", "training-log.jsonl"),
    [
      JSON.stringify({
        ranAt: "2026-05-18T20:15:00Z",
        source: "scorecard",
        decision: "no_update",
        reason: "insufficient_buy_samples",
      }),
      JSON.stringify({
        ranAt: "2026-05-20T20:15:00Z",
        source: "signal_weights",
        decision: "no_update",
        reason: "insufficient_samples",
      }),
    ].join("\n") + "\n"
  );
  return dir;
}

function runScript(cwd, args = []) {
  const cmd = `node ${SCRIPT} ${args.join(" ")}`;
  return execSync(cmd, { cwd, env: process.env, encoding: "utf8" });
}

test("runtimeStatus: human format includes key sections", (t) => {
  const dir = setupTempEnv();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = runScript(dir);
  assert.match(out, /Value Steward Runtime Status/);
  assert.match(out, /System Pulse/);
  assert.match(out, /Operational State/);
  assert.match(out, /ML Training/);
  assert.match(out, /OOS Evaluation/);
  assert.match(out, /ML Feature Flags/);
});

test("runtimeStatus: human format reports state values", (t) => {
  const dir = setupTempEnv();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = runScript(dir);
  assert.match(out, /current_mode:\s+LIVE/);
  assert.match(out, /trading_enabled: true/);
  assert.match(out, /executions_today: 3/);
});

test("runtimeStatus: jsonl --append writes a single line to runtime.log", (t) => {
  const dir = setupTempEnv();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  runScript(dir, ["--format=jsonl", "--append"]);
  runScript(dir, ["--format=jsonl", "--append"]);

  const logPath = path.join(dir, "data", "runtime.log");
  assert.equal(fs.existsSync(logPath), true);
  const lines = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.operational.mode, "LIVE");
    assert.ok(typeof parsed.today === "string");
  }
});

test("runtimeStatus: jsonl without --append goes to stdout, not file", (t) => {
  const dir = setupTempEnv();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = runScript(dir, ["--format=jsonl"]);
  // Must be one line of compact JSON.
  const trimmed = out.trim();
  const parsed = JSON.parse(trimmed);
  assert.equal(parsed.operational.mode, "LIVE");
  // File should not have been created.
  assert.equal(
    fs.existsSync(path.join(dir, "data", "runtime.log")),
    false
  );
});

test("runtimeStatus: missedDays surfaces gaps in training-log", (t) => {
  const dir = setupTempEnv();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = runScript(dir, ["--format=jsonl"]);
  const parsed = JSON.parse(out.trim());
  // Phase 1 starts 2026-05-18 (Mon). Training entries exist for 5-18 and 5-20.
  // 5-19 (Tue) and 5-21 (Thu) are missing weekdays before today.
  assert.ok(Array.isArray(parsed.missedDays));
  assert.ok(parsed.missedDays.includes("2026-05-19"));
});

test("runtimeStatus: handles missing data files gracefully", (t) => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-empty-"));
  fs.mkdirSync(path.join(emptyDir, "data"));
  fs.mkdirSync(path.join(emptyDir, "config"));
  fs.mkdirSync(path.join(emptyDir, "logs"));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

  const out = runScript(emptyDir);
  assert.match(out, /Value Steward Runtime Status/);
});
