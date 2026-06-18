# Value Steward — Claude Code project guide

Value Steward is an institutional-grade automated trading agent on a Python +
Node.js hybrid architecture. It runs a live Alpaca **paper-trading** loop on a
schedule. The goal is code that is **presentable, auditable, and marketable** —
not merely functional.

Start with `docs/MISSION.md` (philosophy), `SYSTEM_MECHANICS.md` (how the parts
fit), and `skills/steward-engineering-standards/SKILL.md` (architectural
patterns). Operating discipline lives in `docs/SESSION_BRIEF.md` and
`docs/PLAYBOOK_WEEKLY_REVIEW.md`; the learning roadmap in `docs/ML_BACKLOG.md`.

---

## Environment & workflow (read before running anything)

- **The repo lives in WSL** at `/home/lukes/value-steward` (Windows sees it as
  `\\wsl.localhost\ubuntu\home\lukes\value-steward`). It is migrating to an
  Oracle Cloud Linux instance "soon" — at which point the Windows/WSL split goes
  away.
- **Run all git and test commands from WSL**, not Windows Git Bash. The Linux
  `.venv` holds `pytest`, `pre-commit`, `mypy`, and `bandit`; the Windows side
  can't launch them, and mixing Windows-git with WSL-git on the same `.git`
  causes object-ownership/permission errors.
- **Tests:** `npm run test:js` (node test runner) and `npm run test:py`
  (`.venv/bin/python -m pytest`, ~3.5 min). Full gate: `npm run check`.
- **Pre-commit gate** runs the full `check` + mypy + bandit on every commit
  (`pass_filenames: false`). Keep it green — never `--no-verify`. `bandit`
  exits non-zero on any finding; annotate genuine false positives with
  `# nosec <ID>` (the repo already does this for B106/B311/B324/B404/B603).
- **`gh` is authed in WSL only.** Push and open PRs from WSL. PRs are merged by
  the user on GitHub (merge-commit strategy).
- **The live cron/systemd system constantly mutates tracked runtime files**
  (`config/policy.json`, `data/*.jsonl`, `data/steward-state.json`,
  `world/feeds.json`), so the working tree is never clean. **Stage code files
  explicitly; never `git add -A`.**
- **Runnable scripts must guard `main()`** behind an `import.meta`/`argv[1]`
  entrypoint check (see `scripts/worldRunScheduled.js`) so importing them for
  tests never executes real work against the live data tree.

---

## Agent discipline (non-negotiable)

1. **Surgical scope.** Only touch what the task requires. Note unrelated
   improvements separately; don't act on them.
2. **No speculative refactors/renames/reformatting** outside scope.
3. **No regressions.** Existing tests must pass. If you change a shared
   interface (signature, return type, field name), update every call site in
   the same change.
4. **No undeclared dependencies.** Don't add imports/packages unless required;
   name and justify any new one.
5. **Match existing conventions** — naming, spacing, logging, comments,
   docstrings. Mirror the surrounding code.
6. **Declare your footprint** — end with a short list of files/functions changed
   and why.

## Code quality standards

- **Python:** `logging` not `print` for operational messages. Atomic writes
  (`tmp -> os.replace`). Type hints on new functions. Loaders must degrade
  gracefully on missing *and* corrupt input (guard `json.load`).
- **Node.js:** ES modules. `startSpinner` for long CLI scripts. **Reuse the
  shared I/O helpers in `core/runtimeArtifacts.js`** — `readJson` / `readJsonl`
  (guarded reads), `writeJsonAtomic` / `writeJsonlAtomic` /
  `appendJsonlLineSync` (atomic writes). Don't hand-roll `JSON.parse(line)` or
  `fs.writeFileSync` for state files. Every runnable entrypoint that reads
  `process.env` loads `import "dotenv/config"` as its first import.
- **Tests:** every new function with observable behavior gets a test in
  `tests/` (Python) or `tests-js/` (Node). Use dependency injection / `tmp_path`
  — no real Alpaca calls, no real filesystem outside a temp dir.
- **Auditability:** every decision path emits a `reason_code` and a UTC
  `timestamp` with an explicit `Z` suffix.

## Definition of done

Requirement satisfied · all tests pass · nothing outside scope changed ·
footprint declared · landed through the green pre-commit gate.
