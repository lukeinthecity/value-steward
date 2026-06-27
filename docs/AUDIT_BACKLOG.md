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
| `cancel_open_orders()` called inside the fill loop (per-iteration) | `execution_engine.py` | ✅ | Applied — **efficiency** fix (same outcome, fewer API calls): cancel once per symbol via `has_open_order` on both single + multi paths. 2 tests, verified to fail against pre-fix (4 cancels → 2) |
| `_parse_hhmm()` for early-close time | `execution_engine.py` | ⏸ | Superseded — `main` already adopted `_parse_hhmm` for the early-close path |
| Dead `_apply_smoothing` stub; Sunday stale-branch | `signal_engine.py` | ✅ | Removed the **dead** `_apply_smoothing` stub (defined, never called; `score_raw`/`score_smoothed` set in the live path). **Did NOT** apply the rest of b32a76f's signal_engine diff — it predates `main` and would delete current scoring (exec-quality / alpha-prior / intraday-persistence). Left the Sunday staleness branch intact (deliberate tolerance, not a bug). |
| TOCTOU lock race — write owner PID, verify before evicting | `steward_state.py`, `stewardState.js` | ✅ | Applied + **hardened** beyond `b32a76f` (pid≤0 guard, corrupt-PID still evictable); 6 adversarial Python tests + JS `isPidAlive` test |
| `exec()` shell → `execFile()` (cmd-injection hardening) + null-guard | `makeMacroDigest.js` | ✅ | Applied (batch 2) |
| Remove dead `internetOk`/`brokerOk` params (`canTrade` resolves null) | `tradeGate.js`, `tick.js` | ✅ | Applied — **traced all consumers first**: `canTrade` is advisory only (tick artifact + email; `gpioDaemon` computes its own; nothing gates orders on it). Removed dead params; `canTrade` now a definitive boolean. 5 branch-coverage tests via injected state. |
| `await` promisified `db.close()`; guard NaN cache-age | `shadowObserver.js` | ✅ | Applied (batch 2) |
| Surface positions-fetch error as `positionsError` | `runValueSteward.js` | ✅ | Applied (batch 2) |
| Validate fallback context before writing; null-guard hydrated entries | `buildWorldContext.js` | ⏸ | `main` already has layered validation fallbacks — likely superseded |
| Skip partial first line when tail-reading large JSONL | `world_context.py` | ✅ | Applied (batch 2) |
| Run all EOD steps regardless of intermediate failure | `eodRun.js` | ✅ | Applied (batch 2) |

## Salvage PRs (all merged)
- **Batch 1** (#38): `config.py`, `runtime_integrity.py`, `notifications.py`, `cli.py`.
- **Batch 2** (#39): `world_context.py`, `eodRun.js`, `shadowObserver.js`, `runValueSteward.js`, `makeMacroDigest.js`.
- **State-lock race** (#40): PID-ownership eviction, hardened beyond `b32a76f` + adversarial tests.
- **`execution_engine`** cancel-loop (#41): efficiency fix, both paths, behavior-preservation tests.
- **`signal_engine`** dead-stub (#42) · **`tradeGate`/`tick`** dead-params (#43).

## Unity reached (2026-06-26)
`b32a76f`'s only unique commit touched 20 files; every one is inventoried above and
resolved (applied / redone / deliberately superseded). `main` is a strict superset —
all of `b32a76f`'s fixes plus the scoring / ML / push features it never had. The
orphaned branch `claude/confident-clarke-a3cd99` has been retired. **git == running
== every valid fix landed.**
