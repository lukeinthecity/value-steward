# Session Brief

**Read this first at the start of every coding session.** Replaces 5–10 exploratory tool calls (git log, status checks, file-existence pokes). Updated by Claude at the end of each session, or by Luke as needed.

---

## Operational pointer

| Field | Value |
|---|---|
| Last updated | 2026-06-22 |
| Active branch | `main` |
| HEAD commit | (see latest merge) |
| Phase 1 RUN | **Run 2** (Run 1 archived 2026-05-29 after cap-breach-sell logic added mid-experiment) |
| Phase 1 start | **2026-06-01 (Monday)** — Day 15 of 60 as of 2026-06-22 |
| Phase 1 end (target) | 2026-07-31 |
| Trading state | `execution_armed=true`, `shadow_mode=false` — paper orders WILL submit |
| Capital cap | `$20` deployed max, `$8` per-trade max, `$1` per-trade min, **two-way (cap_breach_sell active)** |
| Equity (last seen) | $99,976 paper (~flat since start) |
| Live positions | AFBI + PWV (2 positions, ~$20 deployed) — last fill 2026-06-11 |

## Phase 1 Run 1 archive

| Period | Notes |
|---|---|
| 2026-05-18 to 2026-05-29 | 10 calendar days, 2 outage days (5/21, 5/28), 1 holiday (5/25). Yielded 3 BUYs (MET ×2, OEF), 30+ counterfactual scorecard rows, first non-null OOS Sharpe (−1.217 on N=8). Archived in `data/archive/*-phase1-run1-2026-05-29.*` and `logs/archive/intent_log-phase1-run1-2026-05-29.jsonl`. Reset because the cap_breach_sell feature (PR #16) was a structural fix that fundamentally changed system behavior — old data and new data not comparable. |

## Weekly review log (Phase 1 Run 2)

| Week ending | BUYs | Blocks | Notes |
|---|---|---|---|
| 2026-06-07 | 1 (AFBI $7.99) | 19 (15 rel60, 3 rel20, 1 macro_stressed) | Day 5 of 60. **All 5 weekdays ran — no outages.** First trade of Run 2: AFBI Fri 6/5. Macro went `stressed` on 6/3 → ASRT correctly blocked (UNKNOWN sector). rel60 again the dominant gate (15/19), same as Run 1. OOS rolling_n=0 (earliest 5d windows don't close until ~6/8). No activation triggers fired (champion-challenger needs 20+ OOS samples; 1 trade ≠ "0 trades for 2wk" so exploration stays off). No action taken — clean week. |
| 2026-06-22 | 0 | 13 (all BUY_BLOCKED) | Day 15 of 60. Mon–Thu ran; **Fri 6/19 = Juneteenth, correctly skipped.** ⚠️ **OOS rolling Sharpe deteriorating: +0.54 (6/16) → +0.13 → −0.37 → −1.09 (6/22)**, policy v20→26; equity ~flat ($99,976), n=20 (tiny). Champion-challenger ENABLED, champion pinned 6/17 @ +0.131, 2 consecutive cycles below it → ~1 cycle from auto-revert. Per playbook: **documented + watching, no hand-tuning** (negative for *days*, not the 3-week bar). 0 BUYs ~2wk but exploration held OFF (don't add buys while OOS is negative). **Retired 3 dead Nasdaq RSS feeds** (nasdaq.com hangs/times out since 6/16); added CNBC Markets + Yahoo Finance + re-enabled investing-stocks (all fetch-verified, +105 items). Also this session: full silent-crash audit (PRs #31/#32/#33), ntfy push notifications shipped (#34/#35). |

## Weekly review log (Phase 1 Run 1 — archived)

| Week ending | BUYs | Blocks | Notes |
|---|---|---|---|
| 2026-05-24 | 3 | 13 (11 rel60, 1 rel20, 1 sandbox_headroom) | Day 5 of 60. Thu 5/21 lost to power outage. +0.13% weekly alpha at 1d horizon. Promotion blockers tripped on weekend edge cases (`cap_breach` from market drift, `world_context_exchange_date_mismatch` since world:run is Mon–Fri). Mon 5/25 = Memorial Day (markets closed; system skipped via `isTradingDay()`). |

## Quick status check

```bash
npm run runtime:status     # one-shot human-readable summary
npm run runtime:watch      # live-refreshing terminal view (every 10s, ctrl+c exits)
tail -20 data/runtime.log  # historical compact JSON snapshots
```

Run `runtime:status` first in any session — it replaces ~10 exploratory tool calls. It now includes an **Email Health** section (sourced from `data/email-health.json`) — a silent SMTP failure shows up here instead of going unnoticed (the only prior email alarm was email itself).

**Known separate issue (not yet fixed):** the Gemini-powered "Steward's Insight" in emails has been falling back to the canned message for weeks. Root cause surfaced 2026-06-15: the `@google/genai` SDK uses the legacy Interactions API that Google deprecated May 2026 (`400 ... legacy Interactions API schema is no longer supported`). Needs an SDK upgrade to the `steps` schema — tracked as a standalone follow-up.

The **desktop app** (`npm start` from `desktop/`) also surfaces a **Runtime Status** panel that auto-refreshes every 30 seconds (Phase 1 day count, missed days, mode, training/OOS recency, cron pulse pills).

## Recent PRs (last 3)

1. [#35](https://github.com/lukeinthecity/value-steward/pull/35) — feat(push): the 3 ntfy triggers (market-open / session-off / health alert)
2. [#34](https://github.com/lukeinthecity/value-steward/pull/34) — feat(push): ntfy push-notification foundation (notifier + push:test + health)
3. [#32](https://github.com/lukeinthecity/value-steward/pull/32) — fix(audit): corrupt-file guards + atomic writes + entrypoint guards (world + tick)

## ML feature flags (current state)

| Flag | Default | Live setting | Activation criterion |
|---|---|---|---|
| `VS_SIGNAL_WEIGHT_LEARN` | on | on | always |
| `VS_SIGNAL_WEIGHT_MIN_T_STAT` | 2.0 | default | always |
| `VS_OOS_EVAL_ENABLED` | on | default | always (shadow logs to `data/oos-eval.jsonl`) |
| `VS_CHAMPION_CHALLENGER_ENABLED` | off | **true (enabled 2026-06-17)** | enabled — 20+ OOS rows reached; champion pinned 6/17, now guarding against the OOS slide |
| `VS_SCORE_GATE_THOMPSON_ENABLED` | off | default | **enable** after Phase 1 ends (defer to Tier 2 review) |
| `VS_NEW_ENTRY_EXPLORATION_EPSILON` | 0.0 | default | **enable** at 0.05 after week 2 if 0 trades observed |
| `VS_ROTATION_SELL_ENABLED` | on | on | Buy-coupled rotation. Appreciation over the cap NEVER forces a sell (winners run). Only sells when a NEW candidate clears all gates but is blocked by cap headroom AND is stronger than the weakest holding — then exits that holding. Set `false` to disable (new buys just block at cap). |
| `VS_ROTATION_MIN_SCORE_MARGIN` | 0.05 | default | Candidate must beat the weakest holding's signal score by this margin to trigger rotation (anti-churn / let-winners-run). Set 0 to rotate on any improvement. |

## Known open items

- **⚠️ OOS Sharpe deteriorating (2026-06-22)** — rolling Sharpe +0.54 → −1.09 over 6/16–6/22 (n=20, equity flat). Champion-challenger enabled and ~1 cycle from auto-revert. **Watch; do not hand-tune** until the 3-week intervention bar or champion-challenger acts.
- **Dead Nasdaq feeds retired (2026-06-22)** — nasdaq.com RSS (earnings/markets/stocks) times out since 6/16; disabled in `world/feeds.json`, replaced with CNBC Markets + Yahoo Finance + re-enabled investing-stocks (fetch-verified). `investing-sec-filings` borderline (Juneteenth/weekend lull) — recheck mid-week.
- **2026-05-21 (Thu) missed** — machine power loss. No retroactive trades; one day of data lost.
- ~~Pre-commit hook bug (`test:js` glob)~~ — **fixed** in PR #31 (flat `tests-js/*.test.js`); the gate is green again. Bandit B311 + eslint watch-loop also fixed in the same pass.

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
| Counterfactual learning principle | [`docs/COUNTERFACTUAL_LEARNING.md`](COUNTERFACTUAL_LEARNING.md) — learn only from market-printed outcomes; never fabricate |
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
