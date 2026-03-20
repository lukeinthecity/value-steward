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

async function importShadowObserver() {
  const moduleUrl =
    `${pathToFileURL(path.join(repoRoot, "world", "shadowObserver.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("scout audit packet includes recent decisions, scorecard, training, patterns, and promotion state", async (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-scout-audit-"));
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
    last_checked: new Date().toISOString(),
    sources: {},
  });
  writeJson(path.join("data", "steward-state.json"), {
    current_mode: "LIVE",
    last_run_at: new Date().toISOString(),
    trading_enabled: true,
    force_no_trade: false,
    executions_today: 1,
    version: 1,
  });
  writeJsonl(path.join("logs", "intent_log.jsonl"), [
    {
      timestamp: new Date().toISOString(),
      action_type: "BUY",
      reason_code: "UNDER_TARGET_BUY",
      policy_version: 53,
    },
    {
      timestamp: new Date().toISOString(),
      action_type: "NO_ACTION",
      reason_code: "CORRELATED_REDUNDANCY",
      policy_version: 53,
    },
  ]);
  writeJsonl(path.join("data", "signal-scorecard.jsonl"), [
    {
      timestamp: new Date().toISOString(),
      entry_date: "2026-03-20",
      action_type: "BUY",
      horizons: {
        "1": {
          excess_vs_benchmark: 0.01,
          excess_vs_cash: 0.01,
        },
      },
    },
  ]);
  writeJsonl(path.join("data", "patterns.jsonl"), [
    {
      pattern_id: "abc123",
      status: "active",
      sample_size: 4,
      avg_return: 0.02,
      max_drawdown: -0.01,
    },
  ]);
  writeJsonl(path.join("data", "training-log.jsonl"), [
    {
      ranAt: new Date().toISOString(),
      decision: "no_update",
      reason: "insufficient_samples",
      policyVersionBefore: 53,
      policyVersionAfter: 53,
    },
  ]);
  writeJson(path.join("data", "latest-tick.json"), {
    result: {
      ranAt: new Date().toISOString(),
      equity: 100000,
      positions: [],
    },
  });
  writeJson(path.join("data", "portfolio-live.json"), {
    updated_at: new Date().toISOString(),
    account: { equity: 100000 },
    positions: [],
  });
  writeJsonl(path.join("data", "world-context.jsonl"), [
    {
      generated_at: new Date().toISOString(),
      date: "2026-03-20",
      slot: "pre_close",
      macro_view: { macro_label: "watchful", macro_score: 0.35 },
      massive_macro_summary:
        "UST 2Y=4.10 10Y=3.95 | CPI YoY=3.20% | unemployment=4.10%",
      sources_used: ["a"],
      raw_count: 10,
    },
  ]);

  const { buildScoutAuditPacket } = await importShadowObserver();
  const packet = await buildScoutAuditPacket();

  assert.match(packet, /Recent Intent Summary/);
  assert.match(packet, /Scorecard Snapshot/);
  assert.match(packet, /Pattern Library/);
  assert.match(packet, /Training & Policy/);
  assert.match(packet, /Latest Cycle Artifacts/);
  assert.match(packet, /Portfolio refresh:/);
  assert.match(packet, /Massive macro:/);
  assert.match(packet, /Promotion & Integrity/);
});
