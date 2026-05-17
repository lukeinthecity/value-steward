# Session Brief

**Read this first at the start of every coding session.** Replaces 5–10 exploratory tool calls (git log, status checks, file-existence pokes). Updated by Claude at the end of each session, or by Luke as needed.

---

## Operational pointer

| Field | Value |
|---|---|
| Last updated | 2026-05-17 |
| Active branch | `main` |
| HEAD commit | `1e31439` — docs(readme): document the adaptive learning loop |
| Phase 1 start | 2026-05-18 (Monday) — Day 1 of 60 |
| Phase 1 end (target) | 2026-07-17 |
| Trading state | `execution_armed=true`, `shadow_mode=false` — paper orders WILL submit |
| Capital cap | `$20` deployed max, `$8` per-trade max, `$1` per-trade min |
| Equity (last seen) | ~$99,976 paper |

## Recent PRs (last 3)

1. [#10](https://github.com/lukeinthecity/value-steward/pull/10) — docs: document adaptive learning loop in README
2. [#9](https://github.com/lukeinthecity/value-steward/pull/9) — ml(tier1): t-stat gating + OOS eval + champion-challenger
3. [#8](https://github.com/lukeinthecity/value-steward/pull/8) — ml(audit): fix Thompson bypass + 4 other Phase 2 edge cases

## ML feature flags (current state)

| Flag | Default | Live setting | Activation criterion |
|---|---|---|---|
| `VS_SIGNAL_WEIGHT_LEARN` | on | on | always |
| `VS_SIGNAL_WEIGHT_MIN_T_STAT` | 2.0 | default | always |
| `VS_OOS_EVAL_ENABLED` | on | default | always (shadow logs to `data/oos-eval.jsonl`) |
| `VS_CHAMPION_CHALLENGER_ENABLED` | off | default | **enable** when `data/oos-eval.jsonl` has 20+ rows with non-null `rolling.sharpe` |
| `VS_SCORE_GATE_THOMPSON_ENABLED` | off | default | **enable** after Phase 1 ends (defer to Tier 2 review) |
| `VS_NEW_ENTRY_EXPLORATION_EPSILON` | 0.0 | default | **enable** at 0.05 after week 2 if 0 trades observed |

## Known open items

- **QQQM 0.017 share remnant** — sell order queued for Monday open. Verify zero positions after 9:45 AM EDT on 2026-05-18.
- **Pre-commit hook bug** — `package.json` `test:js` uses `**` glob that sh can't expand. Run tests directly via `node --test tests-js/` for now. Defer fix.

## Where to look for things

| What | Where |
|---|---|
| Backlog (Tier 2/3 items) | [`docs/ML_BACKLOG.md`](ML_BACKLOG.md) |
| Weekly review playbook | [`docs/PLAYBOOK_WEEKLY_REVIEW.md`](PLAYBOOK_WEEKLY_REVIEW.md) |
| Trainer audit trail | `data/training-log.jsonl` (`source` field tells you which trainer ran) |
| OOS metrics | `data/oos-eval.jsonl` |
| Decision audit trail | `logs/intent_log.jsonl` |
| Scorecard (counterfactual returns) | `data/signal-scorecard.jsonl` |
| Policy snapshot | `config/policy.json` |
| Live runtime state | `data/steward-state.json` |

## End-of-session update protocol

When wrapping a session, Claude should:
1. Bump `Last updated` to today's date
2. Update HEAD commit, active branch, recent PRs
3. Add/remove items from "Known open items"
4. Toggle ML feature flag "live setting" if any were enabled
5. Update Phase 1 day count if it crossed a meaningful threshold

Don't touch the structural sections (Where to look, Activation criterion) unless those change.
