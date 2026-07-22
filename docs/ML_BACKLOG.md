# ML Roadmap Backlog — Post-Phase-1 (60-day run)

This is the **post-run-evaluation backlog** for the ML loop. Items here were proposed during the Phase 2 audit and intentionally deferred until we have ~60 days of live data to validate against.

The thesis behind deferring everything below: it's the most common quant-shop mistake to keep adding features and refactors before the existing system has produced evidence. Re-evaluate after **≈ 2026-09-28** (60 trading days from Phase 1 Run 3 Day 1 = 2026-07-06).

**Evaluate every item below through the lens in [`docs/COUNTERFACTUAL_LEARNING.md`](COUNTERFACTUAL_LEARNING.md):** the system learns only from counterfactuals the market actually printed, never from assumed outcomes. Each item's "Layer" (per that doc) tells you whether its signal is ground truth or a hypothesis.

**[`docs/POST_RUN_REVIEW.md`](POST_RUN_REVIEW.md) is the consolidated rubric** for the day this backlog unlocks — it collects every "decide this at the post-run review" marker below into one checklist alongside the actual pass/fail verdict criteria for the run itself. Read it first at Day 60; this file stays the source of detail for each item.

**Run history.** Run 1 (2026-05-18 → 05-29) was reset after PR #16 added
structural cap-breach sell logic mid-experiment. Run 2 (2026-06-01 → 07-04)
was reset after the version-semantics fix (#65) restored the strict-OOS
metric, which had been structurally empty for its whole duration — so Run 2's
evaluation could not cleanly attribute results to a policy version. **Run 3
(Day 1 = 2026-07-06)** starts fresh with strict-OOS working, sandbox caps
raised to \$2,000 / \$500 / \$100 (was \$20 / \$8 / \$1), and Run-2 artifacts
archived under `data/archive/run3/`. The three observation tools below
(2.4 / 2.7 / 2.8) shipped just before Run 3 and collect data from Day 1.

---

## Known limitations (observed, not yet actioned)

### ~~OOS `strict` metric is structurally always empty~~ — ✅ RESOLVED (2026-07-21)

**Fixed.** `maybeRunOosAndChampionChallenger` now receives the
pre-trainer-chain policy version, so `strict` matches the rows today's
decisions were actually made under; and the posteriors rebuild only bumps
`policy.version` on a material change (was +1 every cycle). Note: the fix
was authored 2026-07-03 (#65) but a stacked-PR base mishap merged it into
its base branch instead of main; the branch-cleanup audit on 2026-07-21
caught this and restored it — so Run-3 days 1–8 ran with the old
semantics (strict empty, versions inflating; decisions unaffected).
Original observation preserved below for the record.

`oosEvaluator.evaluateOos` produces two blocks: `strict` (rows whose
`policy_version === currentPolicyVersion`) and `rolling` (most recent N rows,
version-agnostic). The champion-challenger consumes `rolling`, which works
correctly.

The `strict` block, however, never populates: the EOD trainer chain bumps
`policy.version` 1–4× per cycle (each of scorecard / signal_weights /
by_regime / posteriors increments it), and `maybeRunOosAndChampionChallenger`
runs *last*, passing the already-incremented version. No scorecard row was
ever decided under a version that was minted seconds ago, so `strict` always
shows `insufficient: true`.

Not harmful (champion-challenger uses `rolling`), but the `strict` block is
dead weight in every `oos-eval.jsonl` row. Two possible fixes, both deferred
as they touch version semantics (regression risk mid-run):
  1. Only bump `policy.version` when a trainer materially changes state
     (fixes both this and general version inflation).
  2. Capture the pre-trainer-chain version and pass it to the OOS evaluator.

Decision rule: address during the post-run review alongside any version-
semantics cleanup. Do NOT change mid-run.

### Score-gate posteriors have no recency decay

`scoreGatePosteriors.buildScoreGatePosteriors` rebuilds each symbol's
Beta(α, β) from scratch every cycle, counting every Phase-1 outcome with equal
weight forever. A benchmark beat from week 1 counts exactly as much as
yesterday's — there is no notion of evidence going stale, even though the
regime that produced the old outcome may be long gone.

Possible fixes, post-run: exponential down-weighting by age (tunable
half-life) or a sliding sample window. Both change what the Thompson gate
sees, so they are decision-affecting.

Decision rule: revisit alongside the posteriors work at the post-run review.
Do NOT change mid-run.

### Thompson prior is uninformed Beta(2, 2)

`VS_SCORE_GATE_THOMPSON_PRIOR_ALPHA` / `_BETA` default to 2.0 / 2.0
(`decision_engine.py`), i.e. "assume a 50% hit rate worth 4
pseudo-observations." That number was picked for symmetry, not from data. If
the realized cross-symbol base rate of beating the benchmark is materially
different from 50%, every young posterior is mis-centered.

Post-run option: empirical-Bayes prior — set the prior mean to the observed
Phase-1 cross-symbol hit rate (with the same ~4-observation strength).

Decision rule: compute the observed base rate at the post-run review;
recalibrate only if it deviates materially from 0.5.

### Champion-challenger margins sit below the Sharpe noise floor

The promote/revert margins are ±0.10 Sharpe (`championChallenger.js`,
`DEFAULT_PROMOTE_MARGIN` / `DEFAULT_REVERT_MARGIN`) evaluated on a rolling
window of ~20 samples. The standard error of a Sharpe estimate at n=20 is
roughly 0.22–0.3 (worse with overlapping 5-day horizons), so a ±0.10 margin
is well inside one standard error: promotions and reverts are likely reacting
to estimation noise, not real performance drift.

Post-run options: sensitivity grid (margin × window) replayed over the
accumulated `oos-eval.jsonl` history, or replace the fixed margin with a
significance-based criterion.

Decision rule: analyze at the post-run review with the accumulated history.
Do NOT retune mid-run — the champion-challenger is the only rollback guard.

### Hyperparameters without sensitivity analysis (inventory)

None of the following constants have a documented justification or
sensitivity pass. Inventory for a post-run one-at-a-time sweep:

| Constant | Value | Where |
|---|---|---|
| Ridge λ | 0.01 | `core/signalWeightTrainer.js` (`DEFAULT_RIDGE_LAMBDA`) |
| Rolling OOS window | 20 | `core/oosEvaluator.js` |
| CC promote/revert margins | ±0.10 | `core/championChallenger.js` |
| Exec-quality blend | 0.90 / 0.10 | `signal_engine.py` score blend |
| Exec-quality sub-weights | 0.35 / 0.20 / 0.20 / 0.25 | `execution_quality.py` `quality_score` |
| Thompson prior | Beta(2, 2) | `decision_engine.py` |
| Realized-alpha scale | 0.05 | `realized_alpha.py` |
| Intraday persistence weight | 0.05 | `signal_engine.py` |
| Pattern-bias nudge caps | 0.05 / 0.15 | `decision_engine.py` `_apply_pattern_bias` |

Decision rule: sweep on collected Phase-1 data at the post-run review before
any of these is re-tuned. No mid-run changes.

### `execution_quality.py` is decision-affecting, not just observability

Despite the observability-sounding name, the per-symbol
`quality_score` from `execution_quality.py` blends 10% into the live signal
score (`signal_engine.py`: `score = 0.90 * score + 0.10 * quality_score`).
Two consequences:

  1. Any execution-policy change motivated by fill-rate metrics (item 2.8) is
     decision-affecting and post-run only.
  2. The item-2.8 fill-rate *metric* must live in a separate observation
     module that never feeds scoring — do not extend `execution_quality.py`
     for it.

Decision rule: standing constraint, not a scheduled fix. Applies to all
execution-quality work.

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

### 2.3 Add `world_macro_score` as a continuous feature in the OLS regression

**Current state:** The signal weight trainer (`signalWeightTrainer.js`) regresses against three rank features only: `momentum_rank`, `vol_rank`, `drawdown_rank`. The `signalWeightTrainerByRegime` partitions records by the discrete `world_macro_label` (calm / watchful / stressed / crisis-prone) and trains separate weight triplets per regime.

**Issue:** The regime trainer treats `macro_score=0.55` and `macro_score=0.10` identically as long as they map to the same label bucket. That throws away the gradient — the signal that `macro_score` is *moving* up or down within a regime is lost. The continuous score is recorded on every scorecard row (`world_macro_score`) but no trainer consumes it.

**Pitch:** Extend `ridgeOls3` to `ridgeOls4` (or generalize to N features) and add `world_macro_score` as a 4th feature. The OLS would then learn interaction effects like "momentum weight should decrease as macro_score rises" without requiring discrete regime partitions.

**Why deferred:** Adds one feature without doubling overfitting risk (with `world_macro_score` highly correlated to label, it's largely redundant in regime-rich periods). But the matrix-inversion path and standard-error / t-stat computation all need to generalize from 3x3 to 4x4. ~2 days of work + test refresh.

**Cost:** 2 days. Generalize OLS, update tests, expose new env var (`VS_SIGNAL_WEIGHT_INCLUDE_MACRO_SCORE`).

**Decision rule:** Implement IF the post-run pattern shows that the **regime trainer** (`signalWeightTrainerByRegime`) is repeatedly hitting `insufficient_samples` per-regime even when total samples are healthy. That's evidence the discrete partitioning is wasting data; a continuous feature would aggregate it.

---

### 2.4 Per-gate "right call" post-mortem — ✅ SHIPPED (#56)

Shipped as `core/gateCalibration.js` + `scripts/gateCalibration.js`
(`npm run gate:calibration`), regenerated weekly into `data/gate-calibration.md`.
Observation-only. First live run (72 Run-2 blocks): `rel_strength_60d` — the
gate doing 47 of the blocks — showed mean 5-day excess ≈ 0.00% (t ≈ 0.00),
i.e. so far neither protecting nor costing at the 5-day horizon. Feeds the
post-run gate-pruning review (3.4).

**Current state (original pitch):** Every `BUY_BLOCKED` row records *which* gate fired (`entry_quality score=...`, `rel20=...`, `rel60=...`, `trend=...`, etc.) and also records the counterfactual 5-day forward return. We can grade each gate's calibration after the fact, but the system never does this.

**Issue:** If `rel60 < 0` blocks ran with a 5-day excess of `+0.20%` on average, the gate is *too tight*. If they ran with `-0.10%` average, the gate is correct. We don't know.

**Pitch:** Offline analysis script (`scripts/gateCalibration.js`) that reads the scorecard, groups blocked rows by gate type, and computes:
- count of blocks per gate
- mean and median forward excess of blocked candidates
- t-statistic against zero (was the gate actually justified?)

Output goes to a markdown table in `data/gate-calibration.md`, regenerated weekly. **Pure observation — no auto-tuning.** The operator decides whether to relax/tighten thresholds based on the report.

**Why deferred:** Most valuable after the full 60-day run — small windows give misleading gate-calibration numbers (1 lucky block can flip the verdict). Doable in any window though; the report itself is harmless to produce.

**Cost:** 4–6 hours. Script + cron entry + doc.

**Decision rule:** Build at end of run. Use the report to inform any threshold changes for Run 3 (if there is one) rather than adjusting mid-run.

---

### 2.5 Predictive sell-side trainer

**Current state:** The system only sells when *forced* — `VOL_STOP` (panic exit on >2σ drop), `CAP_BREACH_SELL` (cap enforcement), or rebalance (when `current_exposure > target + buffer`). There is no learned model of "when should this held position be exited?"

The signal scorecard records BUY outcomes, BUY_BLOCKED counterfactuals, and real SELL outcomes — but the trainers consume only the first two. SELL rows are explicitly excluded (`isBuyRelatedRecord` filter in `scoreGatePosteriors`, BUY/MULTI-only filter in `signalWeightTrainer`).

**Issue:** A symbol we bought 3 weeks ago and which has been drifting sideways is *exactly* the kind of position predictive selling would help with. The system has features that could predict reversal (declining `momentum_rank`, rising `drawdown_rank`) but those are only used for BUY selection at decision time.

**Pitch:** A separate `signalWeightSellTrainer` that:
- Reads scorecard rows where `action_type == BUY` and the position was subsequently held for ≥5 trading days
- For each held position, computes "did the BUY signal degrade?" — track day-over-day deltas in the symbol's features
- Train a separate weight set for predicting *exit timing*
- Feed back into a new `_should_sell_predictive()` check in `decision_engine`

**Why deferred:** Requires (a) the system to actually hold positions for multi-day windows (which `cap_breach_sell` now enables — Run 2 will produce this data), and (b) a meaningful sample of held-then-exited positions to train on (~30 SELL outcomes). Run 1 had 0. Run 2 might produce 5–10. We probably need **Run 3** before there's enough data.

**Cost:** 5 days. New trainer module + integration into `decision_engine` + tests.

**Decision rule:** Build if Run 2 produces ≥20 held positions with realized exit outcomes. Otherwise defer to Run 3.

---

### 2.6 Tag-level learning ("tag → forward return" correlation)

**Current state:** The world layer produces a rich vocabulary of tags (`MACRO_RISK`, `RECESSION_FEAR`, `GEO_HIGH`, `ENERGY_SHOCK`, `RATE_HAWKISHNESS`, etc.) each with a weighted score. These tags inform the macro_label/score fusion in the regime classifier but are otherwise opaque to the trainers.

**Issue:** The macro_label/score is a *single number* downstream of all this tag richness. If `RECESSION_FEAR` rises sharply but `MACRO_RISK` stays flat, the macro_score might not move — but the underlying market state has changed in a way that *could* predict differential symbol returns (e.g., bonds outperform stocks).

**Pitch:** Offline correlation report (`scripts/tagSignalReport.js`) that, for each tag in the world vocabulary:
- Aggregates the tag's score on each decision day
- Computes correlation with subsequent 5-day excess return at the universe level
- Surfaces tags with `|r| > 0.3` and `p < 0.05`

These become *candidates* for inclusion in a future continuous-feature trainer (item 2.3 extended). Like 2.4, **observation only — no automatic feature addition.**

**Why deferred:** Requires substantial historical data to compute meaningful tag-return correlations. Per-tag samples will be even sparser than per-regime samples in a 60-day window. Genuinely useful only with multi-month data.

**Cost:** 3 days. Script + correlation table + ranking output.

**Decision rule:** Build at end of Run 2 *only if* (a) we've decided to extend Phase 1 into Run 3, and (b) item 2.3 is also being implemented. Otherwise no point — the analysis would just sit unused.

---

### 2.7 Intent → fill linkage in the audit trail — ✅ SHIPPED (#54)

Shipped: `client_order_id` (`intent.id:symbol`) stamped at submission in
`execution_engine.py`, an EOD reconciliation pass (`core/intentReconciliation.js`)
that joins intents to broker outcomes into `logs/intent_outcomes.jsonl`, and a
"fills vs attempts" line in `runtime:status`. The `client_order_id` doubles as
a broker-side idempotency key. Observation-only.

**Current state (original pitch):** `logs/intent_log.jsonl` records every *decision* (what the engine wanted to do) but not the *outcome* (whether the order filled). Fill status lives separately in `data/portfolio-live.json`'s `recent_orders` (filled / canceled / expired). The two are not linked.

**Issue (surfaced 2026-06-15 review):** On 2026-06-08 the log shows "BUY KALV" four times — which reads like four purchases. In reality all four were mid-point limit orders that expired **unfilled**; KALV was never held. To know what actually happened you must cross-reference the broker artifact. The decision trail is legible at the *intent* level but silent on the *fill* level, which can mislead anyone reading the log alone (including a future trainer that treats a BUY intent as an executed position).

**Pitch:**
- Stamp each intent with an `order_id` (or correlation id) at submission time.
- A reconciliation pass (fits in `eodRun.js`) joins intents to their broker order outcome and writes `fill_status` (`filled` / `canceled` / `expired` / `none`) and `filled_notional` back onto the intent record (or a parallel `logs/intent_outcomes.jsonl`).
- Surface a one-line "today's fills vs attempts" in `runtime:status` (e.g., `KALV: 4 attempts, 0 filled`).

**Why deferred:** Pure observability; no effect on decisions or training. But it's the highest-value legibility fix on the list — it closes a real gap where the primary audit log can mislead.

**Cost:** 1 day. Order-id plumbing + eod reconciliation + a runtime:status line.

**Decision rule:** Worth doing relatively early (even mid-run is safe — it only adds data, changes no behavior) if reading the logs becomes a regular activity. Otherwise batch with the end-of-run execution review (2.8).

---

### 2.8 Execution fill-rate metric ("Fishing" strategy evaluation) — ✅ SHIPPED (#55, metric only)

Shipped: `core/executionQualityReport.js` (`npm run execution:quality`) appends
snapshots to `data/execution-quality.jsonl` — fill rate overall and by
conviction tercile, plus an adverse-selection Welch t-test (did unfilled names
outperform filled ones?). Separate from the decision-path `execution_quality.py`.
**The conviction-scaled execution *policy* change is NOT shipped** — it stays
gated on the decision rule below (only act if top-bucket fill rate is materially
below the rest), and is decision-affecting (post-run).

**Current state (original pitch):** Orders use a mid-point limit ((bid+ask)/2) "Fishing" strategy with cancel-and-catch across the pre-close execution slots. It saves the bid-ask spread but only fills when price comes to the midpoint.

**Issue (surfaced 2026-06-15 review):** KALV — the single highest-conviction name of the week (rel60 +40%, mom60 +55%) — never filled across four attempts because its limit was never hit, so the system walked away with nothing while lower-conviction names (PWV, AFBI) did fill. The spread savings may not be worth the missed alpha on exactly the names we most want.

**Pitch:** Track fill rate as an execution-quality metric:
- Per cycle and rolling: `fills / attempts`, segmented by signal-score bucket (are we missing the *strong* names more than the weak ones?).
- Mean adverse selection: did unfilled names subsequently outperform filled ones? (i.e., is the limit strategy systematically leaving alpha on the table?)
- Output to the scorecard / a `data/execution-quality.jsonl` summary and the weekly report.

If the data shows high-conviction names consistently slipping, consider a **conviction-scaled execution policy**: cross the spread (marketable limit or market order) on the final pre-close slot for the top-ranked candidate only, keeping mid-point Fishing for the rest.

**Why deferred:** Needs a meaningful sample of fills vs misses to be statistically honest. One week (KALV) is an anecdote, not a pattern.

**Cost:** 1–2 days for the metric; the conviction-scaled execution change (if warranted) is a separate ~1 day.

**Decision rule:** Build the metric at the 30-day mark. Act on execution policy only if fill rate on the top score-bucket is materially below the rest (e.g., <50% vs >70%) — concrete evidence the Fishing strategy is costing us our best ideas.

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

**Two honest caveats (must be stated in the harness output):**
1. **Macro blind spot.** The decision engine consumes `world_context` — macro
   labels an LLM generated live from *that day's* news, which cannot be
   reconstructed for arbitrary past dates. So the partial backtest stubs macro
   to "calm" and therefore tests only the price-signal core
   (momentum / vol / drawdown), blind to the entire world/regime layer. It
   validates roughly the price-driven part of the system, not the whole.
2. **Backtests overfit and mislead by default.** A great-looking backtest is
   usually one that has seen its own answer. The only thing that makes it
   trustworthy is validation against out-of-sample *live* results.

**Why now actionable (was: deferred).** We now hold real Run-2 live results in
`data/archive/run3/` (scorecard, intents, OOS). The validation step is
concrete: run the harness over Run-2's window and check whether its
hypothetical outcomes track what actually happened live. If they diverge, the
backtest is not trustworthy — which is itself a useful finding.

**Cost:** 3–5 days. Stub world-context generator + a replay harness that drives
the *real* `SignalEngine`/`DecisionEngine` with historical bars via dependency
injection (no reimplementation), + a validation report vs archived Run-2.

**Decision rule:** Build pre-public as a portfolio centerpiece, with both
caveats surfaced in its output. Trust its numbers only after the Run-2
validation pass shows correlation with live results.

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
| 1 | t-stat significance gating | ✅ Shipped (PR #9) |
| 1 | OOS evaluation pipeline | ✅ Shipped (PR #9) |
| 1 | Champion-challenger auto-rollback | ✅ Shipped (PR #9, behind `VS_CHAMPION_CHALLENGER_ENABLED`) |
| 3.1 | Defer Phase 2c — partial | ✅ Default minSamples already 8; consider raising |
| — | Runtime status report + log | ✅ Shipped (PRs #12, #13) — `npm run runtime:status`, watch mode |
| — | Two-way sandbox cap (cap_breach_sell) | ✅ Shipped (PR #16) — was structural; triggered Run 2 reset |
| — | Phase 1 Run 1 → Run 2 reset | ✅ Done 2026-05-29 (PR #17) — Day 1 = 2026-06-01 |
| — | Debug-scan fixes (SELL pollution in posteriors + cap_breach over-exit + exposure consistency) | ✅ Shipped (PR #18) |
| 2.7 | Intent → fill linkage | ✅ Shipped (PR #54) |
| 2.8 | Execution fill-rate + adverse-selection metric | ✅ Shipped (PR #55) — metric only; policy change deferred |
| 2.4 | Gate-calibration report | ✅ Shipped (PR #56) |
| KL | Strict-OOS / policy version-semantics fix | ✅ Shipped (PR #65) — restored strict OOS; triggered Run 3 |
| — | Repeatable phase-reset script (`npm run phase:reset`) | ✅ Shipped (PR #66) |
| — | Run 2 → Run 3 reset + caps raised to $2,000/$500/$100 | ✅ Done 2026-07-06 (Day 1) |

## Next up (buildable now, pre-public)

- **3.2 walk-forward backtest harness** — the one open item that does *not*
  need live Run-3 data. Partial (price-only, macro stubbed to "calm"),
  validated against the archived Run-2 results in `data/archive/run3/`. See
  the Tier-3 entry for scope + the honest macro-blind-spot caveat.

Everything else open is *evidence-gated* by design — waiting for Run-3 data,
not for developer time. That is deliberate (see the opening thesis), not a
backlog gap.

Last updated: 2026-07-05
