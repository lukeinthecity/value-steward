import test from "node:test";
import assert from "node:assert/strict";

import { evaluateOos, _internals } from "../core/oosEvaluator.js";

const { summarize } = _internals;

function buildRow({ policyVersion, excess5, intentId }) {
  return {
    intent_id: intentId,
    timestamp: "2026-05-01T20:00:00.000Z",
    policy_version: policyVersion,
    horizons: {
      "5": { excess_vs_benchmark: excess5 },
    },
  };
}

test("summarize: empty input returns nulls", () => {
  assert.deepEqual(summarize([]), {
    sampleCount: 0,
    mean: null,
    std: null,
    sharpe: null,
    hitRate: null,
  });
});

test("summarize: single value has null std and sharpe", () => {
  const s = summarize([0.01]);
  assert.equal(s.sampleCount, 1);
  assert.equal(s.mean, 0.01);
  assert.equal(s.std, 0);
  assert.equal(s.sharpe, null);
  assert.equal(s.hitRate, 1);
});

test("summarize: computes mean, std, sharpe, hit rate", () => {
  const s = summarize([0.01, 0.02, -0.005, 0.015]);
  assert.equal(s.sampleCount, 4);
  assert.ok(Math.abs(s.mean - 0.01) < 1e-9);
  assert.ok(s.std > 0);
  assert.ok(s.sharpe > 0);
  assert.equal(s.hitRate, 0.75);
});

test("evaluateOos: strict block filters by current policy_version", () => {
  const records = [
    buildRow({ policyVersion: 5, excess5: 0.01, intentId: "old-1" }),
    buildRow({ policyVersion: 5, excess5: -0.02, intentId: "old-2" }),
    buildRow({ policyVersion: 6, excess5: 0.015, intentId: "cur-1" }),
    buildRow({ policyVersion: 6, excess5: 0.025, intentId: "cur-2" }),
    buildRow({ policyVersion: 6, excess5: -0.005, intentId: "cur-3" }),
  ];
  const oos = evaluateOos({
    records,
    currentPolicyVersion: 6,
    horizon: 5,
    minSamples: 2,
  });
  assert.equal(oos.strict.sampleCount, 3);
  assert.ok(Math.abs(oos.strict.mean - (0.015 + 0.025 - 0.005) / 3) < 1e-9);
});

test("evaluateOos: rolling block ignores policy_version, uses recency", () => {
  const records = Array.from({ length: 25 }, (_, i) =>
    buildRow({
      policyVersion: i,
      excess5: i * 0.001,
      intentId: `r${i}`,
    })
  );
  const oos = evaluateOos({
    records,
    currentPolicyVersion: 24,
    rollingWindow: 10,
    minSamples: 5,
  });
  // Rolling should grab last 10 records.
  assert.equal(oos.rolling.sampleCount, 10);
  // strict should grab only policy_version === 24 → 1 record → flagged insufficient.
  assert.equal(oos.strict.sampleCount, 1);
  assert.equal(oos.strict.insufficient, true);
});

test("evaluateOos: missing horizon values are skipped silently", () => {
  const records = [
    buildRow({ policyVersion: 1, excess5: 0.01, intentId: "1" }),
    buildRow({ policyVersion: 1, excess5: null, intentId: "2" }),
    buildRow({ policyVersion: 1, excess5: 0.02, intentId: "3" }),
  ];
  const oos = evaluateOos({
    records,
    currentPolicyVersion: 1,
    minSamples: 2,
  });
  assert.equal(oos.strict.sampleCount, 2);
});

test("evaluateOos: minSamples flag marks insufficient blocks", () => {
  const records = [buildRow({ policyVersion: 1, excess5: 0.01, intentId: "1" })];
  const oos = evaluateOos({
    records,
    currentPolicyVersion: 1,
    minSamples: 5,
  });
  assert.equal(oos.strict.insufficient, true);
  assert.equal(oos.rolling.insufficient, true);
});

test("evaluateOos: handles null currentPolicyVersion gracefully", () => {
  const records = [buildRow({ policyVersion: 1, excess5: 0.01, intentId: "1" })];
  const oos = evaluateOos({ records, currentPolicyVersion: null });
  assert.equal(oos.strict.sampleCount, 0);
  // Rolling still works.
  assert.equal(oos.rolling.sampleCount, 1);
});

test("evaluateOos: empty/missing records yields zero counts", () => {
  const oos = evaluateOos({ records: [], currentPolicyVersion: 1 });
  assert.equal(oos.strict.sampleCount, 0);
  assert.equal(oos.rolling.sampleCount, 0);
});
