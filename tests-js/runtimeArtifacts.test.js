import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertMatchingCycleIds,
  appendIntradayObservation,
  buildArtifactCycleId,
  buildHistoryEntryFromTickResult,
  extractLatestOrderFromPortfolioSnapshot,
  getArtifactCycleId,
  loadIntradayObservations,
  readJsonl,
  writeJsonlAtomic,
} from "../core/runtimeArtifacts.js";

test("extractLatestOrderFromPortfolioSnapshot prefers most recent same-day order", () => {
  const portfolio = {
    recent_orders: [
      {
        symbol: "OLD",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-19T19:30:00.000Z",
        filled_at: "2026-03-19T19:31:00.000Z",
      },
      {
        symbol: "WMB",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-20T19:39:00.000Z",
        filled_at: "2026-03-20T19:40:00.000Z",
        filled_avg_price: "54.32",
      },
      {
        symbol: "CUB",
        side: "buy",
        status: "new",
        submitted_at: "2026-03-20T19:20:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
  });

  assert.equal(latest.symbol, "WMB");
  assert.equal(latest.status, "filled");
  assert.equal(latest.filled_avg_price, "54.32");
});

test("extractLatestOrderFromPortfolioSnapshot returns null when no order matches exchange date", () => {
  const portfolio = {
    recent_orders: [
      {
        symbol: "OLD",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-19T19:30:00.000Z",
        filled_at: "2026-03-19T19:31:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
  });

  assert.equal(latest, null);
});

test("extractLatestOrderFromPortfolioSnapshot ignores newer non-executed orders by default", () => {
  const portfolio = {
    last_order: {
      symbol: "WMB",
      side: "buy",
      status: "filled",
      submitted_at: "2026-03-20T19:39:00.000Z",
      filled_at: "2026-03-20T19:40:00.000Z",
    },
    recent_orders: [
      {
        symbol: "WMB",
        side: "buy",
        status: "filled",
        submitted_at: "2026-03-20T19:39:00.000Z",
        filled_at: "2026-03-20T19:40:00.000Z",
      },
      {
        symbol: "CUB",
        side: "buy",
        status: "new",
        submitted_at: "2026-03-20T19:55:00.000Z",
      },
    ],
  };

  const latest = extractLatestOrderFromPortfolioSnapshot(portfolio, {
    exchangeDate: "2026-03-20",
  });

  assert.equal(latest.symbol, "WMB");
  assert.equal(latest.status, "filled");
});

test("buildHistoryEntryFromTickResult preserves lean training fields", () => {
  const entry = buildHistoryEntryFromTickResult({
    exchangeDate: "2026-04-06",
    generatedAt: "2026-04-06T19:55:10.000Z",
    cycleId: "2026-04-06:pre_close:2026-04-06T19:00:00.000Z",
    policy: { mode: "rebalance", risk_level: 0.2 },
    result: {
      ranAt: "2026-04-06T19:55:04.000Z",
      agentMode: "LIVE",
      snapshotStatus: "node_enriched",
      equity: 100000,
      buyingPower: 200000,
      cash: 99995,
      portfolioValue: 100000,
      cashUtilization: 0.00005,
      grossExposure: 5,
      netExposure: 5,
      maxPositionWeight: 0.00005,
      numPositions: 1,
      positions: [
        {
          symbol: "SPY",
          qty: 0.05,
          side: "long",
          marketValue: 5,
          avgEntryPrice: 100,
          unrealizedPl: 0.1,
          unrealizedPlPc: 0.02,
          assetClass: "us_equity",
        },
      ],
    },
  });

  assert.equal(entry.exchange_date, "2026-04-06");
  assert.equal(entry.cycle_id, "2026-04-06:pre_close:2026-04-06T19:00:00.000Z");
  assert.equal(entry.positions.length, 1);
  assert.equal(entry.positions[0].symbol, "SPY");
  assert.equal(entry.positions[0].unrealizedPl, 0.1);
  assert.equal(entry.mode, "rebalance");
  assert.equal(entry.risk_level, 0.2);
});

test("artifact cycle helpers build and validate matching provenance", () => {
  const cycleId = buildArtifactCycleId({
    exchangeDate: "2026-04-29",
    worldContextGeneratedAt: "2026-04-29T19:00:00.000Z",
    worldContextSlot: "pre_close",
  });

  assert.equal(cycleId, "2026-04-29:pre_close:2026-04-29T19:00:00.000Z");
  assert.equal(
    getArtifactCycleId({ result: { cycle_id: cycleId } }),
    cycleId
  );
  assert.equal(
    assertMatchingCycleIds([
      { label: "tick", payload: { cycle_id: cycleId } },
      { label: "portfolio", payload: { cycle_id: cycleId } },
      { label: "world", payload: { cycle_id: cycleId } },
    ]),
    cycleId
  );
});

test("artifact cycle helper rejects mismatched provenance", () => {
  assert.throws(
    () =>
      assertMatchingCycleIds([
        { label: "tick", payload: { cycle_id: "a" } },
        { label: "portfolio", payload: { cycle_id: "b" } },
      ]),
    /Artifact cycle mismatch/
  );
});

test("artifact cycle helper rejects missing provenance", () => {
  assert.throws(
    () =>
      assertMatchingCycleIds([
        { label: "tick", payload: { cycle_id: "a" } },
        { label: "portfolio", payload: {} },
      ]),
    /Artifact cycle provenance missing/
  );
});

test("loadIntradayObservations filters to the requested exchange date", (t) => {
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-intraday-artifacts-"));
  process.chdir(tmpDir);

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  appendIntradayObservation({
    exchange_date: "2026-04-13",
    exchange_time: "10:00",
    top_candidates: [{ symbol: "AAA" }],
  });
  appendIntradayObservation({
    exchange_date: "2026-04-14",
    exchange_time: "10:00",
    top_candidates: [{ symbol: "BBB" }],
  });

  const rows = loadIntradayObservations("2026-04-13");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exchange_time, "10:00");
  assert.equal(rows[0].top_candidates[0].symbol, "AAA");
});

test("writeJsonlAtomic round-trips and leaves no .tmp file behind", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-jsonl-atomic-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const target = path.join(tmpDir, "nested", "inbox.jsonl");
  const entries = [{ id: 1, t: "a" }, { id: 2, t: "b" }];
  writeJsonlAtomic(target, entries);

  // Round-trips through the guarded reader.
  assert.deepEqual(readJsonl(target), entries);
  // Trailing newline, one object per line.
  const raw = fs.readFileSync(target, "utf8");
  assert.equal(raw, '{"id":1,"t":"a"}\n{"id":2,"t":"b"}\n');
  // No stray temp files survive the rename.
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((f) => f.includes(".tmp")),
    []
  );
});

test("writeJsonlAtomic writes empty file for no entries; readJsonl skips corrupt lines", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-jsonl-corrupt-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const target = path.join(tmpDir, "inbox.jsonl");
  writeJsonlAtomic(target, []);
  assert.equal(fs.readFileSync(target, "utf8"), "");
  assert.deepEqual(readJsonl(target), []);

  // A truncated/garbled line must be skipped, not throw.
  fs.writeFileSync(target, '{"ok":1}\n{not valid json\n{"ok":2}\n');
  assert.deepEqual(readJsonl(target), [{ ok: 1 }, { ok: 2 }]);
});
