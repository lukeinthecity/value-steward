---
name: steward-agent-discipline
description: Rules governing how any coding agent (Gemini, Claude, or other) must behave when working on the Value Steward project. Enforces surgical scope, regression safety, and auditability on every task. Load this skill whenever proposing, reviewing, or executing a code change.
---

# Steward Agent Discipline

This skill defines the non-negotiable rules of engagement for any coding agent
working on Value Steward. The goal is code that is **presentable, auditable, and
maintainable** — not just functional. All prose (docs, comments, commit
messages) must stay factual and objective: no self-praise, superlatives, or
performance claims.

---

## The Six Rules

### 1. Surgical Scope
Only touch files, functions, or lines that are directly required to complete
the stated task. If a file is not named in the task, it does not get touched.

### 2. No Speculative Improvements
Do not refactor, rename, reformat, or "clean up" anything outside the task scope.
If you spot something worth fixing, note it as a separate suggestion — do not act
on it in the current change.

### 3. No Regressions
All existing tests must still pass after your change. If you must modify a shared
interface (function signature, return type, field name), identify every call site
and update all of them in the same change.

### 4. No Undeclared Dependencies
Do not add imports, packages, or modules beyond what the task requires. If a new
dependency is genuinely necessary, name it and justify it explicitly.

### 5. Match Existing Conventions
Mirror the surrounding code exactly — naming, spacing, logging style, docstrings.
Do not impose a new style. Look at adjacent code and follow it.

### 6. Declare Your Footprint (Change Manifest)
Every response that modifies code must end with a Change Manifest:

```
## Change Manifest
- `path/to/file.py`
  - `function_name()`: one-line description of what changed and why
- `path/to/other.js`
  - `anotherFunction()`: one-line description
No files modified outside task scope.
```

If nothing outside the task scope was touched, that last line is required.

---

## Why This Matters

Value Steward is self-taught and agent-assisted. The discipline rules exist because:

- **Auditability:** Every change must be traceable to a stated requirement.
  The Change Manifest is the audit trail.
- **Regression safety:** Agents are prone to "fixing" things that don't need
  fixing, breaking tests in the process. Rule 3 is the safeguard.
- **Marketability:** Code that drifts in style or accumulates unexplained changes
  is hard to hand off or present. Rules 2 and 5 prevent that drift.
- **Trust:** A human working with agents needs to be able to review a diff and
  immediately understand why every line changed. These rules make that possible.

---

## How to Apply This Skill

When issuing a task to any coding agent, append the following at the end:

> Apply the steward-agent-discipline rules. Surgical scope only.
> Provide a Change Manifest at the end of your response.

When reviewing a completed change, verify:
- [ ] Change Manifest is present and complete
- [ ] No files were touched outside the task scope
- [ ] All tests still pass (`npm run test:py`)
- [ ] No new dependencies were introduced without justification
