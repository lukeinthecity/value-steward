/**
 * Shared vocabulary for reading scorecard rows correctly.
 *
 * Two independent hazards live here, both discovered 2026-08-06:
 *
 * 1. SIGN. The three row populations have different sign semantics on
 *    `excess_vs_benchmark`:
 *      - taken (BUY/MULTI): we bought. Positive = good decision.
 *      - declined (NO_ACTION with a BUY_* reason_code): we did NOT buy, and the
 *        row records what the candidate did anyway. `src/valuesteward/cli.py`
 *        assigns direction = +1, so positive = the candidate rose = we wrongly
 *        blocked a winner = BAD decision. Inverted relative to a taken row.
 *      - sell (SELL): rebalance / VOL_STOP / CAP_BREACH_SELL rows carry their
 *        own inverted signed_return semantics and belong to neither population.
 *    Averaging taken and declined without orientation is what made the rolling
 *    OOS metric report a 0.00 hit rate while the system was in fact declining
 *    losers correctly.
 *
 * 2. REPLICATION. `VS_EXECUTION_SLOT_MINUTES_BEFORE_CLOSE` defaults to
 *    [30,20,10,5], so one decision produces up to four intents and therefore
 *    four scorecard rows with identical forward returns. Left uncollapsed this
 *    divides every minSamples floor by ~4 and understates variance, inflating
 *    Sharpe.
 *
 * Honesty note for anyone reading the pooled metric: an oriented mean over both
 * populations is a DECISION-QUALITY score in excess-return units, not a
 * portfolio return. We did not earn the loss we avoided. Realized P&L quality
 * lives in the `taken` block alone.
 */

function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Rows where we actually took a position. */
export function isTakenBuyRecord(record) {
  const action = normalizeToken(record?.action_type);
  return action === "BUY" || action === "MULTI";
}

/** Rows where a buy was considered and declined; sign is inverted. */
export function isDeclinedBuyRecord(record) {
  if (normalizeToken(record?.action_type) !== "NO_ACTION") return false;
  const reason = normalizeToken(record?.reason_code);
  return reason !== null && reason.startsWith("BUY_");
}

/**
 * Either population — "does buying this symbol work?" evidence.
 * The Thompson score-gate posteriors deliberately pool both.
 */
export function isBuyRelatedRecord(record) {
  return isTakenBuyRecord(record) || isDeclinedBuyRecord(record);
}

/**
 * Identity of the underlying decision a row describes.
 *
 * A symbol-day has exactly one forward return and may contribute exactly one
 * observation. Rows lacking symbol or entry_date carry too little identity to
 * be called replicas, so they are always kept distinct.
 */
export function scorecardDecisionKey(record, index) {
  const symbol = normalizeToken(record?.symbol);
  const entryDate = normalizeToken(record?.entry_date);
  if (!symbol || !entryDate) return `row:${index}`;
  return `decision:${symbol}|${entryDate}`;
}

// An executed action outranks a block. On 2026-07-14 KCCA was BUY at the 19:30
// slot and BUY_BLOCKED at 19:40 once it was already at target; the portfolio
// fact is the BUY. Keying on action_type instead would keep both rows, and
// after sign orientation they would carry OPPOSITE signs for one forward return.
function decisionRank(record) {
  return normalizeToken(record?.action_type) === "NO_ACTION" ? 0 : 1;
}

/**
 * Collapse per-slot replicas to one row per decision, preserving file order.
 *
 * Order preservation is load-bearing: `evaluateOos` walks the array backwards
 * for recency and `summarizeScorecard` uses `records.slice(-limit)`.
 */
export function dedupeScorecardRecords(records) {
  if (!Array.isArray(records)) return [];
  const chosen = new Map();
  records.forEach((record, index) => {
    const key = scorecardDecisionKey(record, index);
    const current = chosen.get(key);
    // Ties go to the later row — the writer sorts by timestamp, so that is the
    // slot nearest the close, i.e. the state the engine actually acted on.
    if (!current || decisionRank(record) >= decisionRank(current.record)) {
      chosen.set(key, { record, index });
    }
  });
  return [...chosen.values()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.record);
}
