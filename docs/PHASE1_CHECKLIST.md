# Phase 1 Checklist

Mission: Improve signal quality and document why we trade or abstain.
Timeline: 4 to 6 weeks.

**Stages (7)**
1. Explicit eligibility gates recorded in every intent (world, signal, risk).
2. Freshness and time-of-day rules for world context and signals.
3. Scorecard pipeline with summary snapshots and forward returns.
4. Scorecard cooldown to prevent oscillation.
5. "No trade" quality metrics in scorecard summary.
6. Risk-off behavior validated in tests.
7. Phase 1 runbook command (world -> tick -> scorecard -> train -> report).

**How to run**
`npm run phase1:run`

**How to check progress**
`npm run phase1:status`

**Definition of Done (Phase 1)**
- At least 60 trading days of scorecard data.
- Signal performance beats baseline on a risk-adjusted basis.
- Clear evidence of correct abstention during weak signals or high macro risk.
