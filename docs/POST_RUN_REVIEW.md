# Post-Run Review — Phase 1 Rubric

**Status:** Living reference document. Created 2026-07-22, before Run 3's
end date, specifically so the verdict criteria are locked in *before* the
data that will be judged against them exists. Update this document as the
project evolves, but treat changes made after Day 55 or so with suspicion —
moving the goalposts once the answer is nearly visible defeats the point.

**Purpose:** Two things did not exist before this document: (1) a stated,
falsifiable definition of what "the experiment worked" means, and (2) a
single place collecting the ~15 "decide this at the post-run review"
markers scattered across `ML_BACKLOG.md`. This is both.

**Companions:**
- [`MISSION.md`](MISSION.md) — the qualitative success definition this
  document makes concrete and measurable.
- [`COUNTERFACTUAL_LEARNING.md`](COUNTERFACTUAL_LEARNING.md) — the
  evaluation lens (Layer 1/2/3) every metric below must respect.
- [`ML_BACKLOG.md`](ML_BACKLOG.md) — the source of every conditional item
  in Part 2; this document doesn't replace it, it indexes it.
- [`PLAYBOOK_WEEKLY_REVIEW.md`](PLAYBOOK_WEEKLY_REVIEW.md) — the weekly
  cadence sibling of this document. That one says "don't touch anything
  mid-run." This one is what happens once mid-run is over.

---

## When this triggers

Phase 1 Run 3, Day 1 = 2026-07-06, target 60 *trading* days ≈ 2026-09-28
(outage days push this later — check `npm run phase1:status` for the
actual count, don't assume the calendar date). Triggers on whichever comes
first:

- Trading-day count reaches 60, **or**
- The champion-challenger auto-reverts and stays reverted for 2+ consecutive
  weeks with no recovery (that's an early, informal signal the current
  policy is actively harmful — don't wait out the clock in that case), **or**
- The user decides to end the run early for a non-ML reason (e.g., the
  Oracle Cloud migration, a hosting change, going live with real money).

If it triggers early, still run every step below — the rubric doesn't care
why Run 3 ended, only what the data says.

---

## Part 1 — The experiment verdict

### 1.1 Primary metric: risk-adjusted return vs. baseline

Source: `data/oos-eval.jsonl`, `rolling` block (the `strict` block only
became meaningful after the 2026-07-21 version-semantics fix — see
"Known confounds" below).

**The honest statistical bar.** The standard error of a Sharpe estimate is
approximately:

```
SE(Sharpe) ≈ sqrt((1 + 0.5 * Sharpe²) / n)
```

At `n=20` (the rolling window size) and `Sharpe≈0`, `SE ≈ 0.22`, worse with
the overlapping 5-day return horizons already in use. **A ±0.10
champion-challenger margin is inside this band** — see `ML_BACKLOG.md`'s
"Champion-challenger margins sit below the Sharpe noise floor." Do not
read a single 20-sample rolling window as a verdict.

**What to actually do:** at review time, recompute the SE using the full
*accumulated* sample across the run (every `oos-eval.jsonl` row's
underlying scorecard population), not just the last window — more data
narrows the band. Then classify:

| Verdict | Criterion |
|---|---|
| **Success signal** | Accumulated Sharpe is positive **and** its point estimate sits outside roughly 1.5× the recomputed SE from zero — i.e., the sign is not plausibly noise. |
| **Inconclusive** (the *expected*, not-a-failure outcome) | Sharpe sits inside the SE band around zero, or flips sign across sub-windows. Given the known noise floor at realistic Phase-1 sample sizes, this is the single most likely outcome of a 60-day run. Do not treat it as failure — treat it as "run longer" or "the effect, if real, is small." |
| **Failure signal** | Accumulated Sharpe is negative **and** outside the SE band, **or** the champion-challenger has auto-reverted multiple times with no sustained recovery. |

Cross-check against **hit rate** (1d/5d/20d, from the weekly report /
`data/scorecard-summary.json`) — a Sharpe near zero with a hit rate
meaningfully above 50% (or vice versa) is a flag to look closer, not a
tiebreaker to average away.

*Illustrative, not a verdict:* as of 2026-07-22 (Day ~13 of 60), rolling
Sharpe ≈ 0.031 at n=20 — comfortably inside the noise band. That's exactly
what "too early to tell" looks like in this system's own numbers.

### 1.2 Drawdown containment (MISSION.md: "remain controlled and recoverable")

- Pull the equity curve from `data/runtime.log` (if the append cron was
  wired) or reconstruct from `logs/intent_log.jsonl` + portfolio snapshots.
- Compute max drawdown and time-to-recovery.
- Check whether `VOL_STOP` / `cap_breach_sell` fired when they should have
  — cross-reference against the market's actual moves on those dates, not
  just "did the code run."

**Decision rule:** any drawdown that did not recover within the run window
needs a written explanation, not just a number. A controlled-but-painful
drawdown that recovered is a fine outcome for an experiment; an
unrecovered one needs root-causing before Run 4 parameters are set.

### 1.3 Regime consistency (MISSION.md: "consistent across market regimes")

This is where the world-context work ties back in. `data/world-context.jsonl`
`final_regime.final_label` history + `logs/intent_log.jsonl` `risk_off`
blocks let you answer a concrete, printed-fact question (Layer 1 per
`COUNTERFACTUAL_LEARNING.md`): **did blocking trades during `stressed` /
`crisis-prone` regimes actually protect capital, or just cost missed
upside with no offsetting protection?**

```bash
# distribution of regime labels across the run
node -e '
const fs = require("fs");
const lines = fs.readFileSync("data/world-context.jsonl","utf8").trim().split("\n");
const counts = {};
for (const l of lines) { try { const o = JSON.parse(l); const k = o.final_regime?.final_label ?? "missing"; counts[k]=(counts[k]??0)+1; } catch {} }
console.log(counts);
'

# risk_off block reasons
grep -o "risk_off_reason[^,}]*" logs/intent_log.jsonl | sort | uniq -c | sort -rn
```

Then extend the gate-calibration methodology (`ML_BACKLOG.md` 2.4) one
step: segment `BUY_BLOCKED` counterfactual forward-returns by the regime
label active at block time, not just by which gate fired. If candidates
blocked under `stressed`/`crisis-prone` show negative average forward
returns, the regime gate earned its keep. If they show flat or positive
forward returns, it's costing opportunity for no protection — a finding
for the pattern-library / regime-trainer decision rules in Part 2.

---

## Part 2 — Consolidated action checklist

Every "decide this at the post-run review" marker from `ML_BACKLOG.md`, in
one place. Check `policy.json` / the relevant data file before acting —
several of these are conditional and may not have fired.

| # | Item | Condition to act | Source |
|---|---|---|---|
| 1 | Strict-OOS / version-semantics cleanup | Always — general cleanup once 60 days of clean-semantics data exists (only Days 9+ run under the restored semantics; see confound below) | ML_BACKLOG "OOS strict metric" |
| 2 | Score-gate posteriors recency decay | Always — decide exponential decay vs. sliding window | ML_BACKLOG "no recency decay" |
| 3 | Thompson prior recalibration | Only if observed cross-symbol hit rate deviates materially from 50% | ML_BACKLOG "uninformed Beta(2,2)" |
| 4 | Champion-challenger margin/window retune | Always — run the sensitivity grid (margin × window) against accumulated `oos-eval.jsonl` | ML_BACKLOG "margins below noise floor" |
| 5 | Hyperparameter one-at-a-time sweep | Always — 9 constants listed in ML_BACKLOG, none tuned yet | ML_BACKLOG "hyperparameters without sensitivity analysis" |
| 6 | Risk-adjusted training label (2.1) | Only if trained weights show systematic overweighting of `vol_rank` while OOS Sharpe is flat/declining | ML_BACKLOG 2.1 |
| 7 | Pattern-library significance audit (2.2) | Always, if `data/patterns.jsonl` has populated — compute `n`/mean/std/t per pattern; strip any with `n<10` or `\|t\|<2`; if <30% clear the bar, consider removing `_apply_pattern_bias` entirely | ML_BACKLOG 2.2 |
| 8 | Continuous macro-score feature (2.3) | Only if `signalWeightTrainerByRegime` repeatedly hits `insufficient_samples` per-regime despite healthy total samples | ML_BACKLOG 2.3 |
| 9 | Predictive sell-side trainer (2.5) | Only if ≥20 held-then-exited positions with realized outcomes exist | ML_BACKLOG 2.5 |
| 10 | Tag-level correlation report (2.6) | Only if extending to Run 4 **and** item 3 (continuous macro feature) is also being built | ML_BACKLOG 2.6 |
| 11 | Execution fill-rate policy change (2.8) | Only if top-conviction-tercile fill rate is materially below the rest (e.g., <50% vs. >70%) — the metric already exists (`data/execution-quality.jsonl`), this is the policy-action half | ML_BACKLOG 2.8 |
| 12 | Regime-trainer sample floor (3.1) | If any regime triggered training with <~20 records in `policy.json` `signal_weights.by_regime` | ML_BACKLOG 3.1 |
| 13 | Gate redundancy pruning (3.4) | Always — compute the gate-correlation matrix (`rel60`/`rel20`, `trend_strength`/`momentum_rank`); drop any gate with <5% incremental rejection over its neighbor | ML_BACKLOG 3.4 |
| 14 | Guardian LLM-digest path (`WORLD_LLM_CMD`) | Only if a specific case surfaces where the rule-based keyword scorer *and* Scout both missed a real regime shift — see chat discussion 2026-07-22 | Not yet in ML_BACKLOG; add there if revisited |
| 15 | Platform feature parity (short selling, German equities, index options) | Always — pick at most one new asset class to prototype for Run 4, lowest-lift first (German equities < short selling < options); re-check Alpaca's blog for what's shipped since, this list goes stale fast | ML_BACKLOG 3.5 |

Not on this list: **3.3 transaction cost modeling** and **3.2 walk-forward
backtest** — both have their own decision rules independent of the Day-60
trigger (3.3 gates real-money cutover, not this review; 3.2 was explicitly
disconnected per the 2026-07-05 decision to go public without a partial
backtest).

---

## Part 3 — How to run the review

```bash
# 1. Confirm the actual trading-day count (don't assume the calendar date)
npm run phase1:status

# 2. Pull the full OOS history, not just the tail
python3 -c "
import json
rows = [json.loads(l) for l in open('data/oos-eval.jsonl') if l.strip()]
print('total rows:', len(rows))
print('first:', rows[0].get('evaluatedAt'), '  last:', rows[-1].get('evaluatedAt'))
"

# 3. Regenerate the gate-calibration and execution-quality reports fresh
npm run gate:calibration
npm run execution:quality

# 4. Weekly-email cross-check — confirm the last email's headline numbers
#    are consistent with the final oos-eval.jsonl row (material discrepancy
#    = investigate before trusting either)

# 5. Regime-consistency query (Part 1.3 above)

# 6. Check policy.json for per-regime sample counts (item 12) and
#    populated patterns.jsonl (item 7)
python3 -c "
import json
p = json.load(open('config/policy.json'))
print('by_regime counts:', {k: v.get('n') for k, v in (p.get('signal_weights', {}).get('by_regime') or {}).items()})
"
```

Walk Part 2's table top to bottom. For each row that applies, open a normal
PR — this is the one time in the project's cycle where decision-affecting
changes are *expected*, not a violation of run discipline.

---

## Part 4 — Documenting the outcome

- Write the verdict (success signal / inconclusive / failure signal, per
  Part 1.1) into `docs/SESSION_BRIEF.md`, same as any other review.
- If a Run 4 is warranted, follow the same `npm run phase:reset` procedure
  used for the Run 2 → Run 3 transition (see `SESSION_BRIEF.md` history),
  with whatever cap/threshold changes this review justified — and archive
  Run 3's artifacts the same way Run 2's were archived under
  `data/archive/run3/`.
- If the verdict is inconclusive, that is a legitimate basis for **running
  longer with the same policy**, not for reflexively changing something —
  changing multiple things at once after an inconclusive read makes the
  next review just as hard to interpret.

---

## Changelog

- **2026-07-22** — Created. Verdict criteria locked in before Run 3's end
  date; consolidates 13 scattered `ML_BACKLOG.md` decision rules plus the
  Guardian LLM-digest question from that day's chat.
- **2026-07-23** — Added item 15 (`ML_BACKLOG.md` 3.5, platform feature
  parity) after reviewing Alpaca's blog/changelog for what's shipped since
  Phase 1 began: hard-to-borrow short selling, German equities (Xetra),
  and index options paper trading.
