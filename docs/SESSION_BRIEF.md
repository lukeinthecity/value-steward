# Session Brief

**Read this first at the start of every coding session.** Replaces 5–10 exploratory tool calls (git log, status checks, file-existence pokes). Updated by Claude at the end of each session, or by Luke as needed.

---

## Operational pointer

| Field | Value |
|---|---|
| Last updated | 2026-05-24 |
| Active branch | `main` |
| HEAD commit | (see latest merge) |
| Phase 1 start | 2026-05-18 (Monday) — currently Day 5 of 60 |
| Phase 1 end (target) | 2026-07-17 |
| Trading state | `execution_armed=true`, `shadow_mode=false` — paper orders WILL submit |
| Capital cap | `$20` deployed max, `$8` per-trade max, `$1` per-trade min |
| Equity (last seen) | $99,976 paper |
| Live positions | MET (0.1453 / $12.21) + OEF (0.0216 / $8.02) = $20.23 (1¢ over cap due to market drift) |

## Weekly review log

| Week ending | BUYs | Blocks | Notes |
|---|---|---|---|
| 2026-05-24 | 3 | 13 (11 rel60, 1 rel20, 1 sandbox_headroom) | Day 5 of 60. Thu 5/21 lost to power outage. +0.13% weekly alpha at 1d horizon. Promotion blockers tripped on weekend edge cases (`cap_breach` from market drift, `world_context_exchange_date_mismatch` since world:run is Mon–Fri). Mon 5/25 = Memorial Day (markets closed; system will skip via `isTradingDay()`). **Tuesday 5/26 is the real Day 6** — check blockers cleared then. |

## Quick status check

```bash
npm run runtime:status     # one-shot human-readable summary
npm run runtime:watch      # live-refreshing terminal view (every 10s, ctrl+c exits)
tail -20 data/runtime.log  # historical compact JSON snapshots
```

Run `runtime:status` first in any session — it replaces ~10 exploratory tool calls.

The **desktop app** (`npm start` from `desktop/`) also surfaces a **Runtime Status** panel that auto-refreshes every 30 seconds (Phase 1 day count, missed days, mode, training/OOS recency, cron pulse pills).

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

- **2026-05-21 (Thu) missed** — machine power loss. Verified via runtime status. No retroactive trades; one day of data lost.
- **Pre-commit hook bug** — `package.json` `test:js` uses `**` glob that sh can't expand. Run tests directly via `node --test tests-js/` for now. Defer fix.

## Outage recovery — what actually happens

When the machine goes down for a day, the system's design is **conservative idempotency**:

1. **Mode flag**: on the next tick, `current_mode = "CATCHUP"` (informational only — no different behavior)
2. **Morning refresh** auto-runs: `world:run`, `portfolio:refresh`, `intraday:observe`, `world:health` all sync fresh state
3. **No retroactive trades**: the missed day yields no decisions, no scorecard refresh, no training cycle
4. **Phase 1 clock**: continues calendar-wise; missed days reduce effective sample size

Run `npm run runtime:status` to see if any days are missing from the training-log between phase1 start and today.

## Where to look for things

| What | Where |
|---|---|
| Quick status snapshot | `npm run runtime:status` |
| Daily/historical snapshots | `data/runtime.log` (append-only JSONL via `npm run runtime:append`) |
| Backlog (Tier 2/3 items) | [`docs/ML_BACKLOG.md`](ML_BACKLOG.md) |
| Weekly review playbook | [`docs/PLAYBOOK_WEEKLY_REVIEW.md`](PLAYBOOK_WEEKLY_REVIEW.md) |
| Trainer audit trail | `data/training-log.jsonl` (`source` field tells you which trainer ran) |
| OOS metrics | `data/oos-eval.jsonl` |
| Decision audit trail | `logs/intent_log.jsonl` |
| Scorecard (counterfactual returns) | `data/signal-scorecard.jsonl` |
| Policy snapshot | `config/policy.json` |
| Live runtime state | `data/steward-state.json` |

## Optional: auto-append snapshots to runtime.log

To accumulate a historical record, add one line to crontab (hourly is plenty):

```
0 * * * * cd /home/lukes/value-steward && /home/lukes/.nvm/versions/node/v24.13.0/bin/npm run runtime:append >> /dev/null 2>&1
```

Then `tail -10 data/runtime.log` shows the last 10 hours of compact JSON state snapshots. Not required — `npm run runtime:status` always works without it.

## End-of-session update protocol

When wrapping a session, Claude should:
1. Bump `Last updated` to today's date
2. Update HEAD commit, active branch, recent PRs
3. Add/remove items from "Known open items"
4. Toggle ML feature flag "live setting" if any were enabled
5. Update Phase 1 day count if it crossed a meaningful threshold

Don't touch the structural sections (Where to look, Activation criterion) unless those change.
