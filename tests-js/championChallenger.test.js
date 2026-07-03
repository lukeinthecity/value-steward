import test from "node:test";
import assert from "node:assert/strict";

import { evaluateChampionChallenger } from "../core/championChallenger.js";

function oosWith(sharpe, sampleCount = 20) {
  return {
    rolling: {
      sampleCount,
      mean: 0.01,
      std: sharpe ? 0.01 / sharpe : 0.01,
      sharpe,
      hitRate: 0.6,
    },
  };
}

const baseWeights = { momentum: 1.0, vol: 0.4, drawdown: 0.4 };

test("evaluateChampionChallenger: skips when OOS samples below threshold", () => {
  const result = evaluateChampionChallenger({
    currentSignalWeights: baseWeights,
    currentWeights: baseWeights,
    oosMetrics: oosWith(0.5, 2),
    minSamples: 5,
  });
  assert.equal(result.action, "skip_insufficient_data");
  assert.equal(result.revertWeights, null);
});

test("evaluateChampionChallenger: skips when sharpe is null", () => {
  const result = evaluateChampionChallenger({
    currentSignalWeights: baseWeights,
    currentWeights: baseWeights,
    oosMetrics: oosWith(null, 20),
  });
  assert.equal(result.action, "skip_insufficient_data");
});

test("evaluateChampionChallenger: initializes champion on first valid metric", () => {
  const result = evaluateChampionChallenger({
    currentSignalWeights: baseWeights, // no existing champion
    currentWeights: baseWeights,
    oosMetrics: oosWith(0.5),
  });
  assert.equal(result.action, "init");
  assert.equal(result.newChampion.oos_sharpe, 0.5);
  assert.equal(result.newChampion.momentum, 1.0);
  assert.equal(result.newChampion.consecutive_deficit_cycles, 0);
});

test("evaluateChampionChallenger: promotes on sustained improvement", () => {
  const currentSignalWeights = {
    momentum: 1.2,
    vol: 0.5,
    drawdown: 0.5,
    champion: {
      momentum: 1.0,
      vol: 0.4,
      drawdown: 0.4,
      oos_sharpe: 0.3,
      consecutive_deficit_cycles: 0,
    },
  };
  const result = evaluateChampionChallenger({
    currentSignalWeights,
    currentWeights: {
      momentum: currentSignalWeights.momentum,
      vol: currentSignalWeights.vol,
      drawdown: currentSignalWeights.drawdown,
    },
    oosMetrics: oosWith(0.5),
    promoteMargin: 0.1,
  });
  assert.equal(result.action, "promote");
  assert.equal(result.newChampion.momentum, 1.2);
  assert.equal(result.newChampion.oos_sharpe, 0.5);
});

test("evaluateChampionChallenger: holds in tolerance, decays deficit", () => {
  const currentSignalWeights = {
    momentum: 1.0,
    vol: 0.4,
    drawdown: 0.4,
    champion: {
      momentum: 1.0,
      vol: 0.4,
      drawdown: 0.4,
      oos_sharpe: 0.5,
      consecutive_deficit_cycles: 2,
    },
  };
  const result = evaluateChampionChallenger({
    currentSignalWeights,
    currentWeights: baseWeights,
    oosMetrics: oosWith(0.48), // slightly worse but within margin
    revertMargin: 0.1,
  });
  assert.equal(result.action, "hold");
  // Deficit cycle should decay by 1 since within tolerance.
  assert.equal(result.newChampion.consecutive_deficit_cycles, 1);
});

test("evaluateChampionChallenger: increments deficit on underperformance, no revert yet", () => {
  const currentSignalWeights = {
    momentum: 1.0,
    vol: 0.4,
    drawdown: 0.4,
    champion: {
      momentum: 0.8,
      vol: 0.3,
      drawdown: 0.3,
      oos_sharpe: 0.5,
      consecutive_deficit_cycles: 0,
    },
  };
  const result = evaluateChampionChallenger({
    currentSignalWeights,
    currentWeights: baseWeights,
    oosMetrics: oosWith(0.3),
    revertMargin: 0.1,
    revertCycles: 3,
  });
  assert.equal(result.action, "hold");
  assert.equal(result.newChampion.consecutive_deficit_cycles, 1);
  assert.equal(result.revertWeights, null);
});

test("evaluateChampionChallenger: reverts after revertCycles of underperformance", () => {
  const currentSignalWeights = {
    momentum: 1.5,
    vol: 0.5,
    drawdown: 0.6,
    champion: {
      momentum: 1.0,
      vol: 0.4,
      drawdown: 0.4,
      oos_sharpe: 0.5,
      consecutive_deficit_cycles: 2, // one more cycle below trigger threshold
    },
  };
  const result = evaluateChampionChallenger({
    currentSignalWeights,
    currentWeights: {
      momentum: 1.5,
      vol: 0.5,
      drawdown: 0.6,
    },
    oosMetrics: oosWith(0.3),
    revertMargin: 0.1,
    revertCycles: 3,
  });
  assert.equal(result.action, "revert");
  // Revert weights should be the champion's.
  assert.equal(result.revertWeights.momentum, 1.0);
  assert.equal(result.revertWeights.vol, 0.4);
  assert.equal(result.revertWeights.drawdown, 0.4);
  // Deficit counter resets.
  assert.equal(result.newChampion.consecutive_deficit_cycles, 0);
});

test("evaluateChampionChallenger: asymmetric margins prevent flip-flop", () => {
  // Just below promote margin (champion + 0.05 < +0.10)
  const currentSignalWeights = {
    momentum: 1.1,
    vol: 0.4,
    drawdown: 0.4,
    champion: {
      momentum: 1.0,
      vol: 0.4,
      drawdown: 0.4,
      oos_sharpe: 0.4,
      consecutive_deficit_cycles: 0,
    },
  };
  const result = evaluateChampionChallenger({
    currentSignalWeights,
    currentWeights: baseWeights,
    oosMetrics: oosWith(0.45), // +0.05 above champion, below +0.10 promote margin
    promoteMargin: 0.1,
    revertMargin: 0.1,
  });
  assert.equal(result.action, "hold");
});
