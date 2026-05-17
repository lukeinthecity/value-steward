# ML Roadmap Backlog — Post-Phase-1 (60-day run)

This is the **post-run-evaluation backlog** for the ML loop. Items here were proposed during the Phase 2 audit and intentionally deferred until we have ~60 days of live data to validate against.

The thesis behind deferring everything below: it's the most common quant-shop mistake to keep adding features and refactors before the existing system has produced evidence. Re-evaluate after 2026-07-17 (60 trading days from Day 1 = 2026-05-18).

---

## Tier 2 — Worth doing if appetite exists

### 2.1 Risk-adjusted training label

**Current state:** Signal weight trainer regresses against `excess_vs_benchmark` (raw alpha vs SPY).

**Issue:** A 1% mean alpha is treated equally whether it came from a stable 0.3-vol position or a wild 2.0-vol gamble. This biases the trainer toward picking high-vol names that occasionally pop.

**Pitch:** Change the target to `excess_vs_benchmark / signal_volatility` — per-trade Sharpe-style.

**Why deferred:** Our universe is large/mid-cap ETFs with relatively homogeneous volatility, so the bias may be small. After 60 days we'll have empirical evidence of whether high-vol picks are systematically overrepresented in the trained policy.

**Cost:** ~30 minutes. One-line change in `signalWeightTrainer.extractSamples`. Hide behind env var `VS_SIGNAL_WEIGHT_RISK_ADJUSTED=true`.

**Decision rule:** Implement IF the post-run scorecard shows the trainer drifting toward weights that overweight `vol_rank` while OOS Sharpe is flat or declining.

---

### 2.2 Audit the pattern library

**Current state:** `core/patterns.py` extracts "regime fingerprints" — combinations of world tags + the historical avg_return of intents matching those tags. The decision engine uses `_apply_pattern_bias` to nudge target exposure based on matched patterns.

**Issue:** I have not verified that these patterns produce returns statistically distinguishable from noise. With limited history and many possible fingerprints, this is exactly the kind of feature that *looks* like quant analysis but might be data mining.

**Pitch:**
1. For each pattern in `data/patterns.jsonl`, compute: sample size, mean return, std return, t-statistic vs zero.
2. Disable any pattern with `n < 10` or `|t| < 2`.
3. If most patterns fail the bar, consider removing `_apply_pattern_bias` entirely.

**Why deferred:** Cannot evaluate without first having enough live decisions to populate the pattern library.

**Cost:** 1–2 days. Audit + statistical filtering pass.

**Decision rule:** Run after 60 days. If <30% of patterns clear the significance bar, strip the feature.

---

## Tier 3 — Wait until end-of-run

### 3.1 Defer Phase 2c regime-conditional training activation

**Current state:** Regime-conditional weight trainer (`trainSignalWeightsByRegime`) ships in Phase 2 with `VS_SIGNAL_WEIGHT_REGIME_MIN_SAMPLES=8`. With ~12 scorecard rows currently spread across 4 regimes, each regime has ~3 rows.

**Action:** **Already implemented** — current env var default (8) keeps it inactive. Consider raising default to 15 or 20 if a future operator might lower it without context.

**Cost:** Trivial — one env var default change.

**Decision rule:** After 60 days, examine `signal_weights.by_regime` in `policy.json`. If any regime triggered training but has fewer than ~20 records, raise the floor.

---

### 3.2 Walk-forward backtest infrastructure

**Current state:** No historical replay. Phase 2 might be optimizing for something that has no historical edge.

**Issue:** A real backtest requires historical `world_context` (Gemini macro labels for each historical day), which we don't have. Building it means either:
- Stubbing macro to "calm" (partial backtest using only price signals)
- Rebuilding macro history (expensive)

**Pitch:** Build the partial backtest first. Replay the decision engine over 6 months of historical bars with a constant "calm" macro. Track hypothetical excess returns. Compare to actual live Phase 1 results.

**Why deferred:** Realistic value is low until we have 30+ days of live data to validate the backtest's predictions against. The backtest is only useful if it correlates with live performance.

**Cost:** 3–5 days. Requires a stub world-context generator and a replay harness.

**Decision rule:** Build after 60 days IF the live results are interesting enough to warrant historical comparison.

---

### 3.3 Transaction cost modeling

**Current state:** Spread costs aren't in the scorecard. The scorecard tracks "did we beat the benchmark in the next 5 days" but doesn't account for the cost of TAKING the trade.

**Issue:** Real-money graduation will reveal that some of our 0.2% 5-day alphas die after bid-ask spread costs. Critical for live trading; irrelevant for paper trading.

**Pitch:** At scorecard refresh time, fetch the bid-ask spread at execution time (or estimate from recent quotes) and net it from `excess_vs_benchmark`.

**Why deferred:** Alpaca paper trading has zero commission. Build it just before live-money cutover, not now.

**Cost:** 1–2 days. Requires fetching historical quotes for executed symbols and adding a `spread_cost` field to scorecard rows.

**Decision rule:** Block live-money cutover until this is in.

---

### 3.4 Prune redundant entry-quality gates

**Current state:** `_allow_buy` stacks: score floor, rel_strength_20d, rel_strength_60d, trend_strength, sector, correlation, macro regime — plus position-cap checks downstream.

**Hypothesis:** `rel60` and `trend_strength` are almost certainly redundant with `rel20` and `momentum_rank` respectively (`rel60/rel20` correlation in equities is ~0.7–0.9; `trend_strength` is essentially `momentum_60d / drawdown`).

**Pitch:** After 30 days of live data, compute the gate-correlation matrix. Remove whichever gate has <5% incremental rejection rate over its neighbor.

**Why deferred:** Need live rejection data to identify redundancy empirically.

**Cost:** 2 days. Data analysis pass + removal of unused gate code paths.

**Decision rule:** Quant standard is "every gate must justify its existence" — but we need data to know which ones can't.

---

## What's NOT on the backlog (deliberately)

These were considered and rejected to avoid hallucinated complexity:

- **Adding more features (fundamentals, sentiment scores, etc.)** — every additional feature multiplies overfitting risk with our sample sizes. The 3-feature setup is appropriately small.
- **Replacing additive scoring with multiplicative** — different tradeoffs, no clear win, would just be churn.
- **Building a champion-challenger system for more than `signal_weights`** — could extend to risk_level / buffer / posteriors, but YAGNI until the weight CC proves valuable.
- **HMM-based regime detection alongside Gemini** — adds complexity for marginal information gain when the current Guardian/Scout fusion is already conservative.

---

## Status of items already shipped

| Tier | Item | Status |
|---|---|---|
| 1 | t-stat significance gating | ✅ Shipped (this PR) |
| 1 | OOS evaluation pipeline | ✅ Shipped (this PR) |
| 1 | Champion-challenger auto-rollback | ✅ Shipped (this PR, behind `VS_CHAMPION_CHALLENGER_ENABLED`) |
| 2.3 | Defer Phase 2c — partial | ✅ Default minSamples already 8; consider raising |

Last updated: 2026-05-17
