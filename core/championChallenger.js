/**
 * Champion / challenger promotion + auto-rollback for signal_weights.
 *
 * Maintains a "champion" snapshot of weights that demonstrated good rolling
 * OOS performance. After each weight training, compare current OOS Sharpe to
 * the champion's recorded Sharpe:
 *
 *   - current_sharpe >= champion_sharpe + PROMOTE_MARGIN
 *     → PROMOTE: champion becomes the current weights (with the new metric).
 *   - current_sharpe <= champion_sharpe - REVERT_MARGIN
 *     → increment a deficit counter; if it reaches REVERT_CYCLES, REVERT
 *       weights to the champion snapshot.
 *   - otherwise: HOLD (counter resets toward zero if performance recovers).
 *
 * The asymmetric margins prevent flip-flopping at the boundary. Behavior is
 * conservative — we only revert after sustained underperformance.
 *
 * Returns an action plus a new champion block to store back in
 * signal_weights.champion. Caller is responsible for applying any weight
 * revert and writing the updated policy.
 */

const DEFAULT_PROMOTE_MARGIN = 0.10;
const DEFAULT_REVERT_MARGIN = 0.10;
const DEFAULT_REVERT_CYCLES = 3;
const DEFAULT_MIN_SAMPLES = 5;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object} args
 * @param {object} args.currentSignalWeights - Full signal_weights block from policy.
 *   Should contain { momentum, vol, drawdown, champion?: {...} }.
 * @param {object} args.currentWeights - The base weight triplet to consider
 *   ({ momentum, vol, drawdown }) — usually equals the top-level signal_weights.
 * @param {object} args.oosMetrics - Output of oosEvaluator (uses `rolling` block).
 * @param {number} args.promoteMargin - Sharpe headroom to promote (default 0.10).
 * @param {number} args.revertMargin - Sharpe deficit to count toward revert (default 0.10).
 * @param {number} args.revertCycles - Consecutive deficit cycles before revert (default 3).
 * @param {number} args.minSamples - Min OOS samples required to act (default 5).
 * @returns {object} {
 *   action: "init" | "promote" | "hold" | "revert" | "skip_insufficient_data",
 *   reason: string,
 *   newChampion: object,     // updated champion snapshot
 *   revertWeights: object|null,  // weights to restore (only set on revert)
 * }
 */
export function evaluateChampionChallenger({
  currentSignalWeights = {},
  currentWeights = null,
  oosMetrics = null,
  promoteMargin = DEFAULT_PROMOTE_MARGIN,
  revertMargin = DEFAULT_REVERT_MARGIN,
  revertCycles = DEFAULT_REVERT_CYCLES,
  minSamples = DEFAULT_MIN_SAMPLES,
} = {}) {
  const existingChampion =
    currentSignalWeights && typeof currentSignalWeights.champion === "object"
      ? currentSignalWeights.champion
      : null;

  const rolling = oosMetrics?.rolling || null;
  const currentSharpe = rolling?.sharpe;
  const currentSamples = rolling?.sampleCount ?? 0;

  // Refuse to act when the OOS signal itself is unreliable.
  if (
    !rolling ||
    rolling.insufficient ||
    currentSamples < minSamples ||
    !isFiniteNumber(currentSharpe)
  ) {
    return {
      action: "skip_insufficient_data",
      reason: `oos_samples=${currentSamples}<${minSamples} or no_sharpe`,
      newChampion: existingChampion,
      revertWeights: null,
    };
  }

  const nowIso = new Date().toISOString();
  const snapshotFromCurrent = () => ({
    momentum: currentWeights?.momentum ?? currentSignalWeights?.momentum ?? null,
    vol: currentWeights?.vol ?? currentSignalWeights?.vol ?? null,
    drawdown: currentWeights?.drawdown ?? currentSignalWeights?.drawdown ?? null,
    oos_sharpe: currentSharpe,
    oos_sample_count: currentSamples,
    snapshot_at: nowIso,
    consecutive_deficit_cycles: 0,
  });

  // First time we've seen valid metrics → initialize champion.
  if (!existingChampion || !isFiniteNumber(existingChampion.oos_sharpe)) {
    return {
      action: "init",
      reason: `init_champion_sharpe=${currentSharpe.toFixed(3)}`,
      newChampion: snapshotFromCurrent(),
      revertWeights: null,
    };
  }

  const championSharpe = existingChampion.oos_sharpe;
  const deficitCycles =
    Number.isInteger(existingChampion.consecutive_deficit_cycles)
      ? existingChampion.consecutive_deficit_cycles
      : 0;

  // Promote on sustained improvement.
  if (currentSharpe >= championSharpe + promoteMargin) {
    return {
      action: "promote",
      reason:
        `current_sharpe=${currentSharpe.toFixed(3)} ` +
        `>= champion=${championSharpe.toFixed(3)} + margin=${promoteMargin}`,
      newChampion: snapshotFromCurrent(),
      revertWeights: null,
    };
  }

  // Underperformance — accumulate deficit.
  if (currentSharpe <= championSharpe - revertMargin) {
    const newDeficit = deficitCycles + 1;
    if (newDeficit >= revertCycles) {
      const revertWeights = {
        momentum: existingChampion.momentum,
        vol: existingChampion.vol,
        drawdown: existingChampion.drawdown,
      };
      // Reset deficit on the now-restored champion, but keep its Sharpe as
      // the bar to beat.
      return {
        action: "revert",
        reason:
          `current_sharpe=${currentSharpe.toFixed(3)} ` +
          `<= champion=${championSharpe.toFixed(3)} - margin=${revertMargin} ` +
          `for ${newDeficit} cycles >= ${revertCycles}`,
        newChampion: {
          ...existingChampion,
          consecutive_deficit_cycles: 0,
          last_revert_at: nowIso,
        },
        revertWeights,
      };
    }
    return {
      action: "hold",
      reason:
        `deficit cycle ${newDeficit}/${revertCycles}: ` +
        `current=${currentSharpe.toFixed(3)} vs ` +
        `champion=${championSharpe.toFixed(3)}`,
      newChampion: {
        ...existingChampion,
        consecutive_deficit_cycles: newDeficit,
      },
      revertWeights: null,
    };
  }

  // Within tolerance — hold, decay deficit toward zero.
  return {
    action: "hold",
    reason:
      `within_tolerance: current=${currentSharpe.toFixed(3)} ` +
      `vs champion=${championSharpe.toFixed(3)}`,
    newChampion: {
      ...existingChampion,
      consecutive_deficit_cycles: Math.max(0, deficitCycles - 1),
    },
    revertWeights: null,
  };
}

export const _internals = {
  DEFAULT_PROMOTE_MARGIN,
  DEFAULT_REVERT_MARGIN,
  DEFAULT_REVERT_CYCLES,
};
