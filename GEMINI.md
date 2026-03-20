# Value Steward — Gemini Code Assist Instructions

This file is loaded automatically by Gemini Code Assist as project-level context.
It governs how all coding assistance must be delivered for this project.

---

## Project Identity

Value Steward is an institutional-grade automated trading agent built on a Python/Node.js
hybrid architecture. The goal is to produce code that is **presentable, auditable, and
marketable** — not just functional. Every change must meet that standard.

Refer to `docs/MISSION.md` for the project's core philosophy before proposing any change.
Refer to `skills/steward-engineering-standards/SKILL.md` for architectural patterns.
Refer to `skills/steward-institutional-finance/SKILL.md` for financial logic standards.
Refer to `SYSTEM_MECHANICS.md` for a full description of the system's moving parts.

---

## Agent Discipline — Non-Negotiable Rules

These rules apply to **every task** without exception.

### 1. Surgical Scope
Only modify files, functions, or lines that are directly required to complete the
stated task. Do not touch anything else — not even files that are "nearby" or
"related." If a file is not named in the task, it does not get touched.

### 2. No Speculative Improvements
Do not refactor, rename, reformat, reorganize, or "clean up" code outside the task
scope — even if you think it would be better. If you notice something worth improving,
note it in your response as a separate suggestion but do not act on it.

### 3. No Regressions
Before producing output, verify that all existing tests still pass and that no
existing behavior has changed. If completing the task requires changing a shared
interface (a function signature, a return type, a field name), you must identify
**every call site** and update all of them in the same change.

### 4. No Undeclared Dependencies
Do not add imports, packages, or modules that are not needed to satisfy the stated
requirement. If a new dependency is genuinely required, name it explicitly and
explain why.

### 5. Match Existing Conventions
Match the existing code's style exactly — naming, spacing, logging patterns, comment
style, docstring format. Do not impose a new style. When in doubt, look at the
surrounding code and mirror it.

### 6. Declare Your Footprint
At the end of every response, provide a **Change Manifest** listing:
- Every file modified
- Every function or method changed within each file
- A one-line description of what changed and why

If nothing was modified outside the task scope, say so explicitly:
`No files modified outside task scope.`

---

## Code Quality Standards

- **Python:** Follow the patterns in `src/valuesteward/`. Use `logging` not `print`
  for operational messages. All data writes must use the atomic write pattern
  (`tmp -> os.replace`). Type hints required on all new functions.

- **JavaScript/Node.js:** Follow the patterns in `core/` and `scripts/`. Use ES
  modules (`import/export`). Use `startSpinner` for long-running CLI scripts.
  All file writes must use the atomic write pattern (`tmp -> fs.rename`).

- **Tests:** Every new function with observable behavior should have a corresponding
  test in `tests/`. Tests must use dependency injection (no real Alpaca calls, no
  real filesystem unless using `tmp_path`).

- **Logging & Auditability:** Every decision path must produce a `reason_code` and
  a UTC-stamped `timestamp`. This is what makes the system auditable.

---

## What "Done" Looks Like

A task is complete when:
1. The stated requirement is satisfied.
2. All existing tests pass.
3. No behavior outside the task scope has changed.
4. A Change Manifest has been provided.
