import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importStats() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "core", "stats.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("mean handles values, non-finites, and empties", async () => {
  const { mean } = await importStats();
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([1, NaN, 3, null, undefined, "x"]), 2);
  assert.equal(mean([]), null);
  assert.equal(mean(null), null);
});

test("sampleStd matches known value and degenerates to null", async () => {
  const { sampleStd } = await importStats();
  // n=5, mean=4, sum of squared deviations=10 -> sqrt(10/4)
  assert.ok(Math.abs(sampleStd([2, 3, 4, 5, 6]) - Math.sqrt(2.5)) < 1e-12);
  assert.equal(sampleStd([1]), null);
  assert.equal(sampleStd([]), null);
});

test("tStatVsZero matches hand computation", async () => {
  const { tStatVsZero } = await importStats();
  const values = [1, 2, 3, 4, 5]; // mean=3, std=sqrt(2.5), n=5
  const expected = 3 / (Math.sqrt(2.5) / Math.sqrt(5));
  assert.ok(Math.abs(tStatVsZero(values) - expected) < 1e-12);
  assert.equal(tStatVsZero([7]), null);
  assert.equal(tStatVsZero([2, 2, 2]), null); // zero spread
});

test("welchTStat sign and degeneracy", async () => {
  const { welchTStat } = await importStats();
  const high = [10, 11, 12, 13];
  const low = [1, 2, 3, 4];
  assert.ok(welchTStat(high, low) > 0);
  assert.ok(welchTStat(low, high) < 0);
  assert.equal(welchTStat([1], low), null);
  assert.equal(welchTStat([2, 2], [2, 2]), null); // both zero spread
});
