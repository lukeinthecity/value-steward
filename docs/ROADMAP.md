# Value Steward Roadmap

**Timeline (estimated)**
- Phase 1: Signal Quality — 4 to 6 weeks
- Phase 2: Execution Discipline — 3 to 4 weeks
- Phase 3: Performance Validation — 8 to 12 weeks
- Phase 4: Scale and Refinement — optional, after Phase 3

**Phase 1 Checklist: Signal Quality**
- [x] Produce a daily signal scorecard with forward returns at 1/5/20 trading days.
- [x] Record “no trade” decisions as first-class outcomes.
- [x] Enforce a minimal signal stack: trend, momentum, volatility regime, macro risk guard.
- [x] Validate signals vs a baseline benchmark (SPY or cash).
- [x] Summarize hit-rate and average excess returns weekly.

**Phase 1 Stages (Implementation Checklist)**
- [x] Signal eligibility gates are explicit and logged in intents.
- [x] Data freshness + time-of-day rules added (world + signal staleness).
- [x] Scorecard pipeline consolidated with summary snapshots.
- [x] Scorecard cooldown to prevent oscillation.
- [x] “No trade” quality metrics in scorecard summary.
- [x] Risk-off behavior validated in tests.
- [x] Phase 1 runbook command (world → tick → scorecard → train → report).

**Definition of Done (Phase 1)**
- [ ] At least 60 trading days of scorecard data.
- [ ] Signal performance beats baseline on a risk-adjusted basis.
- [ ] Clear evidence of correct abstention during weak signals or high macro risk.

**Phase 2 Checklist: Execution Discipline**
- [ ] One execution per day maximum, with strict notional caps.
- [ ] Hard gate on market hours, stale context, and missing data.
- [ ] Daily post‑mortem: intent, reason, outcome.

**Definition of Done (Phase 2)**
- [ ] 30 consecutive days with zero rule violations.
- [ ] No trades outside market hours or without required data.
- [ ] Complete audit log for every intent.

**Phase 3 Checklist: Performance Validation**
- [ ] Track equity curve, drawdown, exposure, and turnover.
- [ ] Benchmark vs SPY and cash.
- [ ] Risk‑off logic improves drawdown without sacrificing return.

**Definition of Done (Phase 3)**
- [ ] 3 months of paper performance > baseline.
- [ ] Drawdowns within acceptable band.
- [ ] Consistent behavior across market regimes.

**Phase 4 Checklist: Scale and Refinement**
- [ ] Increase signal resolution only after Phase 3 success.
- [ ] Expand universe or sector rotation with validation gates.
