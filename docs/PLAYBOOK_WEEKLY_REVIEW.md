# Weekly Review Playbook

**Run this every Sunday after the 6 PM ET weekly report email lands.** Pre-defined checklist so Claude doesn't reinvent the workflow each week.

Discipline: **review and triage anomalies. Do NOT tune weights or hand-edit policy based on weekly data.** Only act on (a) something genuinely broken, or (b) a pre-defined activation criterion firing.

---

## Step 1 — Confirm the system actually ran this week

```bash
# eod cycles for the past 5 trading days
tail -50 data/training-log.jsonl | python3 -c "
import json, sys
days = set()
for line in sys.stdin:
    if not line.strip(): continue
    r = json.loads(line)
    days.add(r.get('ranAt', '')[:10])
for d in sorted(days)[-7:]: print(d)
"
```

**Expected**: 5 distinct weekday dates from the past week.
**If missing**: check `logs/eod.log` and `logs/cron.log` for errors.

## Step 2 — Check ML trainer activity

```bash
tail -30 data/training-log.jsonl | python3 -c "
import json, sys
for line in sys.stdin:
    if not line.strip(): continue
    r = json.loads(line)
    print(f\"{r.get('ranAt','?')[:10]} {r.get('source','?'):>22}  {r.get('decision','?'):>10}  {r.get('reason','?')}\")
"
```

Look for `signal_weights`, `signal_weights_by_regime`, `score_gate_posteriors`, `champion_challenger` source entries.

| Pattern | Verdict | Action |
|---|---|---|
| All `insufficient_samples` for 7+ days | Trainer can't fire — too few decisions | Check Step 4; consider relaxing gates after week 2 |
| `weights_updated` entries appearing | ✅ Healthy | None |
| `no_significant_t_stat` entries | ✅ Healthy — gating working correctly | None |
| `singular_matrix` or error entries | ❌ Bug | Investigate immediately |

## Step 3 — Check OOS metrics

```bash
tail -20 data/oos-eval.jsonl | python3 -c "
import json, sys
for line in sys.stdin:
    if not line.strip(): continue
    r = json.loads(line)
    s = r.get('strict', {})
    rl = r.get('rolling', {})
    print(f\"{r.get('evaluatedAt','?')[:10]} pv={r.get('policyVersion','?'):>4}  strict_n={s.get('sampleCount',0):>3} rolling_n={rl.get('sampleCount',0):>3} rolling_sharpe={rl.get('sharpe')}\")
"
```

| Pattern | Verdict | Action |
|---|---|---|
| `rolling_n` growing each week | ✅ Healthy | None |
| `rolling_sharpe` consistently `null` | OOS still insufficient — wait | None |
| `rolling_sharpe` ≥ 0 with `rolling_n` ≥ 20 | ✅ Ready to enable champion-challenger | Set `VS_CHAMPION_CHALLENGER_ENABLED=true` in `.env` |
| `rolling_sharpe` consistently negative for 3+ weeks | ⚠️ Policy underperforming | Document in SESSION_BRIEF; consider reverting gate relaxations |
| File doesn't exist | ❌ OOS pipeline never ran | Check `VS_OOS_EVAL_ENABLED` and trainer logs |

## Step 4 — Count actual trades

```bash
# BUY / SELL intents this week (Mon–Fri)
tail -200 logs/intent_log.jsonl | python3 -c "
import json, sys
from collections import Counter
c = Counter()
for line in sys.stdin:
    if not line.strip(): continue
    r = json.loads(line)
    if r.get('action_type') in ('BUY','SELL','MULTI'):
        c[r.get('reason_code') or 'NONE'] += 1
for k, v in c.most_common(): print(f'{v:>4}  {k}')
"
```

| Pattern | Verdict | Action |
|---|---|---|
| 1–10 BUY this week | ✅ Healthy | None |
| 0 BUYs for 2+ consecutive weeks | ⚠️ Gates too tight | Consider enabling exploration: `VS_NEW_ENTRY_EXPLORATION_EPSILON=0.05` in `.env` |
| 15+ BUYs in one week | ⚠️ Gates too loose | Investigate; consider raising score floor |
| `BUY_EXPLORATION` entries when exploration enabled | ✅ Exploration working | None |
| `BUY_THOMPSON` entries when Thompson enabled | ✅ Thompson working | None |

## Step 5 — Cross-check the weekly email

The Sunday 6 PM weekly report email summarizes:
- Hit rate (1d / 5d / 20d horizons)
- Excess vs SPY
- Execution quality (slippage)

Confirm the email metrics are roughly consistent with what `oos-eval.jsonl` shows. Material discrepancy → investigate.

## Step 6 — Decide on activation triggers

Run through this checklist:

- [ ] OOS rolling_n ≥ 20 AND rolling_sharpe stable → **enable champion-challenger** (set env var, restart not required, takes effect next eod)
- [ ] 0 BUYs for 2+ weeks → **enable exploration at ε=0.05** (env var)
- [ ] ≥30 days of clean data → consider whether any **Tier 2** items in `ML_BACKLOG.md` have earned implementation
- [ ] Phase 1 day count == 60 → **end-of-run review** triggers; revisit full `ML_BACKLOG.md`

## Step 7 — Update SESSION_BRIEF

End every weekly review by updating [`SESSION_BRIEF.md`](SESSION_BRIEF.md):
- Bump `Last updated`
- Bump Phase 1 day count (e.g., "Day 7 of 60")
- Record any anomalies under "Known open items"
- Update "live setting" column if any env vars were toggled

---

## Anti-checklist (things NOT to do during weekly review)

- ❌ Hand-edit `signal_weights` in `policy.json` based on weekly performance
- ❌ Tune `min_score` / `min_rel_20` thresholds based on weekly data
- ❌ Implement any Tier 2 or Tier 3 item from `ML_BACKLOG.md` before Phase 1 ends
- ❌ Disable a working ML feature flag because results look bad after 1 week
- ❌ Add new features, signals, or gates

The 60-day run is an experiment. Mid-experiment intervention based on small samples is the most common quant-shop failure mode. Resist.
