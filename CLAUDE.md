# Value Steward — Claude Code project guide

Value Steward is an automated trading agent on a Python +
Node.js hybrid architecture. It ran a live Alpaca **paper-trading** loop on a
schedule from May to August 2026. The goal is code that is **presentable,
auditable, and maintainable** — not merely functional.

> 🏁 **Retired from trading 2026-08-07.** `trading_enabled=false`,
> `force_no_trade=true`, and the trading cron jobs are removed. Only the
> world-context pipeline still runs. The successor is **Value Steward 2** at
> `/home/lukes/value-steward-2` (`github.com/lukeinthecity/value-steward-mk-ii`).
> Read `docs/SESSION_BRIEF.md` for the handover,
> and `docs/VS1_MECHANISM_NOTES.md` **in the VS2 repo** for what this system
> taught about structuring mechanisms.
>
> **Do not re-arm trading here.** VS2 now trades this Alpaca paper account, and
> both systems read positions from the broker rather than their own ledger — so
> re-arming VS1 would have its vol-stop selling VS2's holdings. If VS1 is ever
> restarted, give it a separate Alpaca paper account.

**Prose must be factual and objective.** No self-praise, superlatives, or
performance claims anywhere in docs, comments, or commit messages —
"institutional-grade", "high-precision", "professional", "sophisticated",
"turn one dollar into two" and the like are banned vocabulary. Describe what
the code does; let the reader judge quality.

Start with `docs/MISSION.md` (philosophy), `SYSTEM_MECHANICS.md` (how the parts
fit), and `skills/steward-engineering-standards/SKILL.md` (architectural
patterns). Operating discipline lives in `docs/SESSION_BRIEF.md` and
`docs/PLAYBOOK_WEEKLY_REVIEW.md`; the learning roadmap in `docs/ML_BACKLOG.md`;
the end-of-run verdict criteria in `docs/POST_RUN_REVIEW.md`.

Also read [`agent-playbooks`](https://github.com/lukeinthecity/agent-playbooks)'s
`INCIDENT-LOG.md` at the start of a session — a cross-session, cross-repo log of novel
or alarming situations from real work across this account's projects (this repo's own
untracked-`.prettierrc.json` and branch-protection-bypass incidents are both in there,
generalized for other repos). Attach the repo (`add_repo` / `register_repo_root`) if
it isn't already in session scope.

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
- **Never commit while a cron cycle is running.** The pre-commit gate stashes
  unstaged files, which briefly reverts live runtime files to their *committed*
  state — and the committed `config/policy.json` is a stale snapshot (version 1,
  no `signal_weights.champion` block). A trainer that reads policy during that
  window sees a blank policy and acts on it. This happened on 2026-08-06: an EOD
  run at 20:15:11Z landed inside a commit window and re-initialized the
  champion-challenger against a phantom empty champion, writing junk rows to
  `data/training-log.jsonl` and `data/oos-eval.jsonl` (the real champion block
  survived, because the stash restore won the race).
  **Since the 2026-08-07 retirement the trading cron jobs are gone**, so that
  specific hazard retired with them. What remains is `world:run` on the hour and
  half-hour (13:00–18:00 UTC, weekdays) plus `world:health` at 06:05/18:05 UTC,
  which write the tracked `world/feeds.json` and `data/world-context.jsonl` —
  still worth a `date -u` check before committing, at lower stakes.
- **The installed crontab pins `PATH` to Node 24.** `/usr/bin/node` is v20.20.0
  and `jsdom@30` depends on `undici@8`, which requires `node >=22.19.0`. Without
  the pin `world:hydrate` throws `webidl.util.markAsUncloneable is not a
  function`, and because `world:run` chains with `&&`, `world:build` and
  `world:rotate` never execute — the context history silently stops growing
  while `world:fetch` keeps appending to the inbox. This ran undetected for a
  day before being found on 2026-08-07. The tracked `crontab` template in this
  repo does **not** carry the `PATH` line; preserve it if regenerating.
- **Runnable scripts must guard `main()`** behind an `import.meta`/`argv[1]`
  entrypoint check (see `scripts/worldRunScheduled.js`) so importing them for
  tests never executes real work against the live data tree.

## Code style

- JavaScript and JSON formatting is enforced automatically via Prettier
  (`.prettierrc.json`); Python enforcement pending.
- Indentation: strict 2 spaces.
- Strings: double quotes (`"`), not single quotes.
- Semicolons: always include trailing semicolons (`;`).

## Automation guardrails

- A `PostToolUse` lifecycle hook runs Prettier on disk immediately after any
  file edit.
- Do not attempt to revert or override spacing or quote adjustments made by
  the environment.

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
