# Audit Backlog — May 2026 bug sweep (`b32a76f`)

A May-2026 audit (commit `b32a76f`, "Fix 20 bugs across Python and Node.js
layers") landed on a worktree branch (`claude/confident-clarke-a3cd99`) and was
**never merged**. A separate June audit independently redid only a *subset*.
This file is the reconciled inventory so nothing is lost when that stale branch
is retired. **Verified live: none of `b32a76f` is running** — the working tree
matched `main` exactly; these were orphaned, not active.

Status key: ✅ already in `main` · 🔧 applied (salvage PR) · ⏳ deferred (verified
present, needs review) · ⏸ low-value / not currently exercised.

| Bug | File | Status | Notes |
|---|---|---|---|
| Skip malformed JSONL lines instead of crashing | `fetchRss.js`, `hydrateLinks.js` | ✅ | Redone in **PR #32** (guarded `readJsonl`) |
| Log warnings on row-sync failure vs bare `except` swallow | `db_manager.py` | ✅ | Redone in **PR #30** |
| Retry decorator re-raises auth/logic errors | `alpaca_client.py` | ✅ | `main`'s bare `raise` is equivalent/correct — no change needed |
| `model_construct` fallback missing fields (AttributeError, esp. HIGH mode) | `config.py` | 🔧 | Added `target_risk_exposure_pct_high`, `w_rank_*`, `max_daily_loss_pct`, etc. |
| Git subprocess calls can hang the tick | `runtime_integrity.py` | 🔧 | Added `timeout=10` to both calls |
| Node/script path fragile under cron | `notifications.py` | 🔧 | `shutil.which("node")` + absolute script path + `cwd` |
| Duplicate `load_steward_state` import; missing `\n` in `patterns` output | `cli.py` | 🔧 | Trivial cleanups |
| `cancel_open_orders()` called inside the fill loop (per-iteration) | `execution_engine.py` | ⏳ | **Trading hot path** — real correctness fix, deserves its own reviewed+tested PR |
| `_parse_hhmm()` for early-close time | `execution_engine.py` | ⏳ | Bundle with the above |
| Dead `_apply_smoothing` stub; Sunday stale-branch | `signal_engine.py` | ⏳ | Signal path — review (low risk, low value) |
| TOCTOU lock race — write owner PID, verify before evicting | `steward_state.py`, `stewardState.js` | ⏳ | Concurrency robustness — verify the current lock mechanism first |
| `exec()` shell → `execFile()` (cmd-injection hardening) | `makeMacroDigest.js` | ⏸ | `WORLD_LLM_CMD` is operator-set **and currently unset** — not a live vector; do as hygiene |
| Remove dead `internetOk`/`brokerOk` params (kept `canTrade` null) | `tradeGate.js`, `tick.js` | ⏳ | Still present in `main`; verify gate behavior before removing |
| `await` promisified `db.close()`; guard NaN cache-age | `shadowObserver.js` | ⏳ | Verify against current code |
| Surface positions-fetch error as `positionsError` | `runValueSteward.js` | ⏳ | Verify |
| Validate fallback context before writing; null-guard hydrated entries | `buildWorldContext.js` | ⏳ | `main` already has layered validation fallbacks — verify if still needed |
| Skip partial first line when tail-reading large JSONL | `world_context.py` | ⏳ | Verify |
| Run all EOD steps regardless of intermediate failure | `eodRun.js` | ⏳ | Resilience — verify current step structure |

## Next batches
The ⏳ items are real but split into two risk tiers:
- **Low-risk / infra** (notifications-style): `world_context`, `eodRun`, `shadowObserver`, `runValueSteward`, `makeMacroDigest`, `steward_state` lock — can be a second salvage batch.
- **Trading hot path**: `execution_engine`, `signal_engine`, `tradeGate` — each warrants its own reviewed, test-backed PR (changes execution/scoring/gating behavior).

Once an item lands in `main`, mark it ✅. When all are resolved, retire
`claude/confident-clarke-a3cd99`.
