# Session Brief

**Read this first at the start of every coding session.** Replaces 5–10 exploratory tool calls (git log, status checks, file-existence pokes). Updated by Claude at the end of each session, or by Luke as needed.

---

## Operational pointer

| Field | Value |
|---|---|
| Last updated | 2026-08-07 |
| Active branch | `main` |
| HEAD commit | (see latest merge) |
| Repo visibility | **Public** since 2026-07 (see README status banner + Disclaimer) |
| Phase 1 RUN | 🏁 **RETIRED FROM TRADING 2026-08-07**, after runs 1–3. Run 3 was halted at Day ~21; **Run 4 was cancelled, not started.** |
| Trading state | ⛔ **Permanently halted.** `trading_enabled=false` **and** `force_no_trade=true`, and the trading cron jobs are removed. Positions liquidated 2026-08-07 — account is flat. |
| Successor | **Value Steward mk II** — `/home/lukes/value-steward-2` locally, `github.com/lukeinthecity/value-steward-mk-ii`. A 50-day moving-average crossover and nothing else. It **inherits this Alpaca paper account** (0 positions, $100,023.49 at handover). |
| Why Run 3 stopped | The rolling OOS metric scored most of its population backwards (fixed in #115), and champion-challenger had been promoting/reverting weights on that number — so the live policy was mutating on a broken reading. Raw scorecard rows stay valid and re-read correctly under the fix. |
| Why Run 4 was cancelled | It would have spent 60 trading days generating data from an instrument already judged untrustworthy. The frozen-baseline config was sound, but a clean read from code you have stopped trusting is still a read you will not act on. |
| Equity, final | **$100,023.49** paper, all cash. Net **+$23.49** on $100,000 across three runs spanning 2026-05-18 to 2026-08-07 (82 calendar days). |

⚠️ **Exactly one system may trade this account.** Both VS1 and VS2 read
positions from the broker rather than from their own ledger
(`src/valuesteward/data/alpaca_client.py:128`, `get_all_positions()`), so
re-arming VS1 while VS2 is live would have VS1's vol-stop selling VS2's holdings
and VS1's `risk_exposure_pct` reading the account as fully deployed. If VS1 is
ever restarted, give it a **separate Alpaca paper account** — Alpaca supports
several per login, each with its own keys.

## What still runs

The world-context pipeline only — `world:run` and `world:health:scheduled`. It
contacts no broker, and its context and hydrated-item history is the dataset VS2
needs for the world-state gating it has deferred. The crontab went from 18 jobs
to 4; the previous one is saved at
`/home/lukes/crontab-vs1-backup-20260807.txt`.

**The crontab now pins `PATH` to Node 24.** `/usr/bin/node` is v20.20.0, and
`jsdom@30` depends on `undici@8`, which requires `node >=22.19.0`. Without the
pin, `world:hydrate` throws `webidl.util.markAsUncloneable is not a function`,
and because `world:run` chains with `&&`, `world:build` and `world:rotate` never
execute — so the context history silently stops growing while `world:fetch`
keeps appending to the inbox. This ran undetected from 2026-08-06 15:26 until it
was found on 2026-08-07; the visible symptom was only a stale
`data/world-context.jsonl`.

## Phase 1 Run 1 archive

| Period | Notes |
|---|---|
| 2026-05-18 to 2026-05-29 | 10 calendar days, 2 outage days (5/21, 5/28), 1 holiday (5/25). Yielded 3 BUYs (MET ×2, OEF), 30+ counterfactual scorecard rows, first non-null OOS Sharpe (−1.217 on N=8). Archived in `data/archive/*-phase1-run1-2026-05-29.*` and `logs/archive/intent_log-phase1-run1-2026-05-29.jsonl`. Reset because the cap_breach_sell feature (PR #16) was a structural fix that fundamentally changed system behavior — old data and new data not comparable. |

## Weekly review log (Phase 1 Run 3)

| Week ending | BUYs | Blocks | Notes |
|---|---|---|---|
| 2026-07-18 | (see Monday review) | — | Days 1–7 ran (7/6–7/14). **⚠️ OUTAGE: 7/15–7/17 (3 trading days) — Windows Update (Patch Tuesday) rebooted the PC at 22:44 ET on 7/14; WSL does not auto-start on boot, so cron (which lives inside WSL) never ran until WSL was next touched on Sat 7/18 at 11:33.** Two open positions (KCCA ~$498, SRHQ ~$1,483) were unmonitored during the gap — vol-stop and kill-switch offline. No retroactive action per the outage-recovery design: missed days = absent decisions, run continues. Mitigation: a Windows Scheduled Task now boots WSL at startup. Root-cause class: hobbyist-PC hosting; the planned Oracle Cloud migration eliminates it. |
| 2026-07-21 | — | — | **⚠️ 4th outage day: Mon 7/20 missed** — storm over the 7/18–19 weekend; PC left unplugged through Monday, powered back on Mon 21:29 ET. **The startup scheduled task passed its first real-world test:** WSL + cron came up at boot with no human touch — overnight health checks ran (6:06 world:health) and Tue's 8:30 world:run fired on schedule. Positions reconciled Tue 08:51: KCCA $484.61 (−2.7% over the gap), SRHQ $1,501.35 (+1.2%), equity $99,963 (+$4.93) — no vol-stop-worthy moves occurred while unmonitored. Run continues; Tue 7/21 = Day 8. |

## Weekly review log (Phase 1 Run 2 — archived 2026-07-04)

| Week ending | BUYs | Blocks | Notes |
|---|---|---|---|
| 2026-06-07 | 1 (AFBI $7.99) | 19 (15 rel60, 3 rel20, 1 macro_stressed) | Day 5 of 60. **All 5 weekdays ran — no outages.** First trade of Run 2: AFBI Fri 6/5. Macro went `stressed` on 6/3 → ASRT correctly blocked (UNKNOWN sector). rel60 again the dominant gate (15/19), same as Run 1. OOS rolling_n=0 (earliest 5d windows don't close until ~6/8). No activation triggers fired (champion-challenger needs 20+ OOS samples; 1 trade ≠ "0 trades for 2wk" so exploration stays off). No action taken — clean week. |
| 2026-06-22 | 0 | 13 (all BUY_BLOCKED) | Day 15 of 60. Mon–Thu ran; **Fri 6/19 = Juneteenth, correctly skipped.** ⚠️ **OOS rolling Sharpe deteriorating: +0.54 (6/16) → +0.13 → −0.37 → −1.09 (6/22)**, policy v20→26; equity ~flat ($99,976), n=20 (tiny). Champion-challenger ENABLED, champion pinned 6/17 @ +0.131, 2 consecutive cycles below it → ~1 cycle from auto-revert. Per playbook: **documented + watching, no hand-tuning** (negative for *days*, not the 3-week bar). 0 BUYs ~2wk → exploration held OFF on 6/22, then **reversed 6/25: enabled ε=0.05** (it's experiment-safe/separable, so it gathers data without contaminating the OOS measurement — see ML flags + Known items). **Retired 3 dead Nasdaq RSS feeds** (nasdaq.com hangs/times out since 6/16); added CNBC Markets + Yahoo Finance + re-enabled investing-stocks (all fetch-verified, +105 items). Also this session: full silent-crash audit (PRs #31/#32/#33), ntfy push notifications shipped (#34/#35). |

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

**Gemini "Steward's Insight" — Interactions-API root cause resolved in code.** The 2026-06-15 root cause was the deprecated legacy Interactions API (`400 ... legacy Interactions API schema is no longer supported`). Commit `7ab820c` migrated both call sites (`core/emailNotifications.js`, `world/shadowObserver.js`) to the stable `client.models.generateContent` path; no Interactions-API or `steps`-schema call remains in `main`. The `@google/genai` SDK is bumped 1.44 → 2.13 via #92 (Dependabot; CI green — the `generateContent` / `{ googleSearch: {} }` / `response.text` surface was verified unchanged against 2.13). Remaining verification: confirm the email insight populates instead of falling back on the next successful send.

## Recent PRs (last 3)

1. [#71](https://github.com/lukeinthecity/value-steward/pull/71) — docs: objectivity pass (factual prose, paper-only deployment guide)
2. [#70](https://github.com/lukeinthecity/value-steward/pull/70) — docs: pre-public polish (disclaimer banner, roadmap, CONTRIBUTING)
3. [#69](https://github.com/lukeinthecity/value-steward/pull/69) — docs(ml): backlog refresh (shipped items marked, Run-3 context)

(Full July arc: #52–#68 — ML audit, day-30 observation tooling, CI, code health, strict-OOS fix, Run-3 reset tooling. See `docs/ML_BACKLOG.md` shipped table.)

## ML feature flags (current state)

| Flag | Default | Live setting | Activation criterion |
|---|---|---|---|
| `VS_SIGNAL_WEIGHT_LEARN` | on | on | always |
| `VS_SIGNAL_WEIGHT_MIN_T_STAT` | 2.0 | default | always |
| `VS_OOS_EVAL_ENABLED` | on | default | always (shadow logs to `data/oos-eval.jsonl`) |
| `VS_CHAMPION_CHALLENGER_ENABLED` | off | **true (enabled 2026-06-17)** | enabled — 20+ OOS rows reached; champion pinned 6/17, now guarding against the OOS slide |
| `VS_SCORE_GATE_THOMPSON_ENABLED` | off | default | **STAYS OFF for Run 4.** The old note read "enable after Phase 1 ends," which Run 3 ending satisfies literally — that would have switched Thompson on for the clean baseline by accident. Revisit only at the Run-4 post-run review, and only after the posteriors it reads are shown to be sound (they were inflated ~4× by the scorecard replication fixed in #115). |
| `VS_NEW_ENTRY_EXPLORATION_EPSILON` | 0.0 | **0.05 (enabled 2026-06-25)** | enabled — 0-trades-2wk criterion met (Day 15); probes score-gate near-misses (~1.425–1.50), half-size, tagged `BUY_EXPLORATION` (separable from policy OOS) |
| `VS_ROTATION_SELL_ENABLED` | on | on | Buy-coupled rotation. Appreciation over the cap NEVER forces a sell (winners run). Only sells when a NEW candidate clears all gates but is blocked by cap headroom AND is stronger than the weakest holding — then exits that holding. Set `false` to disable (new buys just block at cap). |
| `VS_ROTATION_MIN_SCORE_MARGIN` | 0.05 | default | Candidate must beat the weakest holding's signal score by this margin to trigger rotation (anti-churn / let-winners-run). Set 0 to rotate on any improvement. |

## Known open items

- **⚠️ 2026-07-15 → 07-17 outage (3 trading days)** — Patch-Tuesday reboot killed WSL on 7/14 22:44 ET; nothing restarts WSL on Windows boot, so the whole loop (cron, ticks, health emails) was dark until 7/18. Health alerts could not fire — they run inside the same WSL that was down (monitoring shared the failure domain). **Mitigation installed 7/18 and VALIDATED 7/20–21:** Windows Scheduled Task "Start WSL (Value Steward)" at system startup — after the 7/20 storm-outage boot (21:29 ET), WSL + cron came up unattended and next-morning crons ran on schedule. A 4th outage day (Mon 7/20, PC unplugged) preceded the validation. Durable fix remains the Oracle Cloud migration — now four lost trading days argue for scheduling it.
- **Exploration enabled ε=0.05 (2026-06-25, Day 15)** — 0-trades-2wk activation criterion met. Experiment-safe (`BUY_EXPLORATION`-tagged → separable from policy OOS, unlike a cap/mode change). Caveat: the *dominant* block is **rel60** (positive-60d-momentum requirement), and exploration only probes *score* near-misses — so expect modest volume, not a flood (also a low-momentum tape). **Day-30 check:** did `BUY_EXPLORATION` picks beat the gate's blocks? → evidence to relax rel60 in Run 3. Bigger funnel levers (rel60 / cap / MEDIUM mode) stay frozen until then.
- **⚠️ OOS Sharpe deteriorating (2026-06-22)** — rolling Sharpe +0.54 → −1.09 over 6/16–6/22 (n=20, equity flat). Champion-challenger enabled and ~1 cycle from auto-revert. **Watch; do not hand-tune** until the 3-week intervention bar or champion-challenger acts.
- **Dead Nasdaq feeds retired (2026-06-22)** — nasdaq.com RSS (earnings/markets/stocks) times out since 6/16; disabled in `world/feeds.json`, replaced with CNBC Markets + Yahoo Finance + re-enabled investing-stocks (fetch-verified).
- **`investing-sec-filings` dead, replaced (2026-07-22)** — the borderline call from 6/22 turned out to be a genuinely dead feed: the URL still returns 200 but every item is frozen at 2026-06-24 (publisher stopped adding new ones). It was the only enabled source carrying the `filings` tag. Replaced with GlobeNewswire's "Earnings Releases And Operating Results" RSS feed (same content genre, fetch-verified: `world:health` shows 0 stale sources repo-wide).
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
