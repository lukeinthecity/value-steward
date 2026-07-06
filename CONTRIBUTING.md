# Contributing to Value Steward

Thanks for your interest. Value Steward is a **personal research and learning
project** — an experiment in how an automated, risk-governed trading agent can
be built, instrumented, and improved from evidence. It is not a product, and it
trades only on a simulated (paper) account.

Contributions are welcome in that spirit.

## Please keep in mind

- **This is not software to run with real money.** Please don't submit changes
  aimed at real-capital trading, and understand that any such use by anyone is
  entirely at their own risk (see the [Disclaimer](README.md#-disclaimer) and
  the Apache-2.0 no-warranty terms).
- **Evidence before features.** The project's core discipline is to *measure
  before it changes* — decision-affecting changes (weights, thresholds, gates)
  are deferred until the live run produces data to justify them. PRs that add
  speculative complexity ahead of evidence are unlikely to be merged; see
  [`docs/ML_BACKLOG.md`](docs/ML_BACKLOG.md) for what's deferred and why.
- **Surgical scope.** Touch only what a change requires; note unrelated
  improvements separately rather than bundling them.

## How to contribute

1. **Open an issue first** for anything non-trivial, so we can agree on the
   approach before you invest time.
2. **Fork and branch** from `main`.
3. **Keep the gate green.** Every change must pass:
   ```bash
   npm run check      # JS + Python tests, lint
   ```
   New behavior needs a test (`tests/` for Python, `tests-js/` for Node).
   Formatting is enforced by Prettier (JS/JSON); Python uses ruff / black / mypy.
4. **Open a PR** with a short description of what changed and why. CI runs the
   full gate on every PR.

## Good first contributions

- Documentation clarity and typo fixes.
- Test coverage for existing untested modules.
- Observation/reporting tooling that doesn't touch the decision path.

Thanks again — and remember, it's a study of the *process*, not a money machine.
