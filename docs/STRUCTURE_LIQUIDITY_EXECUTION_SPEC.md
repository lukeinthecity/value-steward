# Value Steward Resolution Upgrade Spec

## Purpose

This document defines a concrete, additive upgrade to Value Steward's input structure.
The goal is to improve decision quality by adding a new resolution layer between broad signal ranking and final execution.

This is not a strategy replacement.
It is a data-quality and trade-quality upgrade.

Current engine layers:
1. World regime layer
2. Cross-sectional signal layer
3. Risk and execution gate layer

New layer to add:
4. Structure / liquidity / execution-quality layer

This layer should answer:
- Is this candidate move high quality?
- Is this symbol liquid enough for reliable sandbox execution?
- Is this symbol behaving in a way that the system can repeatedly trade and learn from?

The result should be a better-informed decision engine, not a larger, noisier one.

---

## Scope

This spec defines three new derived scores:

1. `liquidity_quality_score`
2. `structure_quality_score`
3. `execution_quality_score`

These scores are additive.
They do not replace the existing momentum / volatility / drawdown framework.
They become new features that refine candidate selection and regime-aware gating.

---

## Design Principles

1. Additive, not disruptive
- Existing macro, signal, and risk logic stays intact.
- New features should modify confidence and sizing, not rewrite the whole engine.

2. Observable and testable
- Every derived score must be reproducible from persisted inputs.
- Every decision that uses these scores must be explainable in logs and EOD.

3. Low-noise defaults
- Missing data should degrade gracefully.
- The engine must not become brittle because one feature is unavailable.

4. Execution realism matters
- A mathematically attractive symbol is not automatically a good sandbox trade.
- Tradeability and learning value are part of the signal.

5. No mythology
- Borrow useful structure concepts.
- Avoid discretionary narrative frameworks that cannot be tested.

---

## New Score 1: Liquidity Quality

### Goal

Measure whether a candidate symbol is liquid and stable enough for reliable execution.

### Why it matters

The engine should down-rank candidates that:
- have weak volume
- are likely to have unstable spreads
- are prone to failed fills or poor execution behavior

This is especially important in stressed regimes.

### Inputs

Preferred inputs:
- average daily dollar volume over 20 sessions
- average daily share volume over 20 sessions
- latest close price
- recent fill success / expire / cancel behavior from local broker history
- optional future enhancement: quote spread / NBBO stability

### Minimum viable implementation

Use data already available or cheaply derivable:
- `last_close`
- OHLCV bars from market data client
- local order history from `portfolio-live.json`
- local execution history from `steward.db` or intent/order artifacts

### Derived features

1. `adv20_dollars`
- 20-day average of `close * volume`

2. `adv20_shares`
- 20-day average volume

3. `price_stability_proxy`
- inverse penalty from recent day-to-day return volatility
- this is not spread, but is a useful fallback until quote data exists

4. `recent_fill_success_rate`
- symbol-specific fills / submitted orders over rolling window

5. `recent_expire_rate`
- symbol-specific expired orders / submitted orders over rolling window

### Scoring

Normalize each feature to `[0, 1]`.

Suggested composition:
- 40% `adv20_dollars_rank`
- 20% `adv20_shares_rank`
- 15% `price_stability_score`
- 15% `fill_success_score`
- 10% inverse `expire_penalty`

If no local execution memory exists yet:
- omit fill/expire terms
- renormalize the remaining weights

### Interpretation

- `0.80 - 1.00`: highly tradable
- `0.60 - 0.79`: acceptable
- `0.40 - 0.59`: marginal
- `< 0.40`: low-quality liquidity candidate

### Decision impact

- Penalize ranking when liquidity score is weak
- In stressed/crisis regimes, require higher liquidity score
- Optionally reduce size for marginal liquidity names

---

## New Score 2: Structure Quality

### Goal

Measure whether the current move has good market structure.

This is the rigorous version of what many discretionary traders try to capture with:
- breakout quality
- failed move detection
- impulse vs drift
- closing strength
- range positioning

### Why it matters

The current signal stack knows whether a symbol has momentum.
It does not yet know whether that momentum is:
- clean
- extended
- fragile
- likely to revert

### Inputs

Daily bars are sufficient for MVP:
- open
- high
- low
- close
- volume
- rolling range
- rolling highs/lows

No intraday order-flow feed is required for phase 1.

### Minimum viable structure features

1. `range_position_20d`
- where current close sits inside the 20-day high/low range
- useful for breakout vs mid-range behavior

2. `breakout_quality`
- current close above recent range high with confirmation
- confirmation can include:
  - positive relative strength
  - above-average volume
  - no immediate reversal bar

3. `failed_breakout_penalty`
- recent breakout attempt that quickly closed back into range

4. `closing_strength`
- for latest bar: `(close - low) / (high - low)` when range > 0
- stronger close near high implies better directional conviction

5. `gap_followthrough`
- if there was a recent gap, did price continue or immediately mean-revert?

6. `trend_persistence`
- number of positive closes / directional consistency over recent window
- or smoothed trend stability from existing bars

### Optional phase 2 features

- volatility contraction before expansion
- inside-day breakout quality
- failed breakdown reversal quality
- distance from anchored VWAP if intraday data is later added

### Scoring

Normalize each feature to `[0, 1]`.

Suggested MVP composition:
- 25% breakout quality
- 20% closing strength
- 20% trend persistence
- 15% range-position alignment
- 20% inverse failed-breakout penalty

### Interpretation

- `0.80 - 1.00`: high-quality structure
- `0.60 - 0.79`: constructive
- `0.40 - 0.59`: mixed
- `< 0.40`: fragile / low-quality move

### Decision impact

- reward candidates with strong structure in calm/watchful regimes
- in stressed regimes, require stronger structure before allowing new positions
- penalize symbols with repeated failed-breakout signatures

---

## New Score 3: Execution Quality

### Goal

Measure how well Value Steward can actually trade and learn from a symbol.

### Why it matters

This engine is not just trying to identify attractive names.
It is trying to:
- place trades
- get fills
- generate clean observations
- learn from outcomes

A symbol that repeatedly generates great math but poor execution is low-value training data.

### Inputs

Use local persisted evidence only:
- recent orders from `portfolio-live.json`
- intent log
- executions table in `steward.db`
- optional history of repeated same-symbol attempts

### Derived features

1. `submission_rate`
- how often buy intents become submitted orders

2. `fill_rate`
- submitted orders that fill

3. `expire_cancel_rate`
- submitted orders that expire or are canceled

4. `repeat_attempt_penalty`
- repeated selection without execution or position change

5. `holding_followthrough`
- if bought previously, did the symbol produce usable outcome data or only noise?

6. `realized_learning_value`
- does this symbol lead to scorecard maturation and usable episodes?
- phase 1 implementation can start as a simple proxy:
  - filled at least once
  - scorecard row matured

### Scoring

Suggested composition:
- 35% fill rate
- 20% inverse expire/cancel rate
- 20% submission rate
- 15% inverse repeat-attempt penalty
- 10% learning-value proxy

### Interpretation

- `0.80 - 1.00`: reliable symbol for sandbox learning
- `0.60 - 0.79`: acceptable
- `0.40 - 0.59`: mixed execution quality
- `< 0.40`: poor training candidate

### Decision impact

- down-rank names with repeated failed execution
- reduce repeated same-symbol reattempt loops when execution quality is poor
- prefer symbols that both score well and generate learnable broker outcomes

---

## Composite Resolution Score

### Goal

Create a single additive overlay score that can refine the current `SymbolSignal.score`.

### Formula

Suggested phase 1 composite:

`resolution_quality_score =`
- `0.40 * liquidity_quality_score`
- `0.35 * structure_quality_score`
- `0.25 * execution_quality_score`

Then derive:

`blended_candidate_score =`
- `0.75 * existing_signal_score_ranked`
- `0.25 * resolution_quality_score`

This should be configurable.

### Important constraint

Do not let this new composite fully override the current signal engine initially.
The first deployment should treat it as a ranking refinement and gating aid.

---

## Regime-Aware Usage

### Calm
- use the composite score as a mild ranking improvement
- normal sandbox sizing rules apply

### Watchful
- require modest minimum structure quality
- slightly penalize weak liquidity
- keep the system active

### Stressed
- require:
  - acceptable liquidity
  - strong structure
  - acceptable execution quality
  - regime-consistent sector OR existing-position add-on
- reduce size multiplier

### Crisis-Prone
- require the strongest thresholds
- allow only:
  - crisis-consistent sectors
  - existing-position add-ons
  - very high structure / liquidity quality
- smallest size multiplier

---

## Data Model Changes

### IntentRecord additions

Add optional fields:
- `liquidity_quality_score`
- `structure_quality_score`
- `execution_quality_score`
- `resolution_quality_score`
- `signal_adv20_dollars`
- `signal_fill_rate`
- `signal_expire_rate`
- `signal_breakout_quality`
- `signal_failed_breakout_penalty`
- `signal_closing_strength`

Only add fields that are actually used or persisted.
Do not flood the model with unused metadata.

### Scorecard additions

Store for each intent:
- the three component scores
- the composite resolution score
- whether the order was submitted
- whether it filled
- order outcome status group

This lets later training ask:
- are low-quality structure names underperforming?
- are weak-liquidity names wasting learning cycles?

### Database additions

Prefer a small new table or extend existing signal storage:
- `symbol_metadata`
  - `symbol`
  - `sector`
  - `sector_source`
  - `updated_at`

Optional later table:
- `execution_symbol_stats`
  - rolling fill / expire / cancel metrics by symbol

---

## Persistence Strategy

### Sector metadata
- lazy lookup
- cache locally
- refresh on miss or stale age

### Execution quality memory
- update after each EOD from local broker/order artifacts
- persist only rolling aggregates, not excessive raw duplication

### Structure / liquidity features
- compute per tick from bars
- persist only summarized values attached to intent/signal records

---

## MVP Implementation Order

### Phase A: Sector and execution realism
1. finish sector cache fallback
2. add symbol execution stats
3. use execution stats in candidate ranking and repeated-attempt suppression

### Phase B: Liquidity quality
1. derive `adv20_dollars`
2. derive `adv20_shares`
3. add liquidity score to signal build output
4. log it into intents and scorecard

### Phase C: Structure quality
1. add range position
2. add closing strength
3. add breakout / failed-breakout detection
4. create structure quality score

### Phase D: Composite overlay
1. combine three scores into `resolution_quality_score`
2. use it in candidate ranking
3. use it in stressed/crisis eligibility checks
4. keep all effects explicit in logs and EOD

---

## Logging and Explainability Requirements

Every BUY / BUY_BLOCKED / NO_ACTION should be able to explain:
- candidate symbol
- sector
- liquidity quality score
- structure quality score
- execution quality score
- composite resolution score
- whether regime gating allowed or blocked the action

Examples:
- `Buy allowed: stressed regime, ENERGY sector, liquidity=0.81 structure=0.76 execution=0.69`
- `Buy blocked: stressed regime, sector=UNKNOWN, liquidity=0.41 structure=0.52 execution=0.28`

This is necessary for trust and later policy learning.

---

## Risks to Avoid

1. Overfitting to small samples
- execution-quality memory should use minimum sample thresholds

2. Too many features too early
- phase the rollout
- ensure each new score materially changes decisions before adding more

3. Opaque composite logic
- every component must remain inspectable
- no black-box “quality” number without component visibility

4. Full-universe metadata preload
- unnecessary and brittle
- use lazy cache instead

5. Conflating liquidity with performance
- a tradable name is not automatically a good signal
- these scores refine, not replace, directional edge

---

## Success Criteria

This resolution upgrade is successful if it produces:
- fewer weak/quirky candidates in stressed regimes
- fewer repeated failed attempts on poor execution symbols
- better explanation quality in EOD and UI
- cleaner learning data because fills and non-fills become part of the feature set
- no major increase in operational fragility

---

## Recommendation

Implement this spec incrementally.

Priority order:
1. sector metadata reliability
2. execution-quality memory
3. liquidity-quality score
4. structure-quality score
5. composite overlay and reporting

That sequence gives the best improvement-to-complexity ratio.
