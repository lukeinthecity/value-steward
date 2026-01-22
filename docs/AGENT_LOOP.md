- Added policy-driven tick runner with history logging and GitHub file helpers.
- Added local trainer script for policy updates from history.
- Added Pipedream workflow template for scheduled execution.

# Value Steward Agent Loop

## Core flow
- `core/runValueSteward.js` is the main agent logic for each tick.
- `config/policy.json` is the policy the agent reads every tick.
- `data/history.jsonl` stores one JSON record per tick.
- `core/tick.js` loads policy, runs the steward, and appends history.

## Training
- `scripts/trainPolicy.js` reads `data/history.jsonl` and updates `config/policy.json`.
- Run locally with `npm run train:policy`.

## Pipedream scheduling
- `pipedream/valueStewardWorkflow.js` is a template to copy into a Pipedream Node.js step.
- Required env vars: `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `ALPACA_BASE_URL`, `GITHUB_TOKEN`.

## Automatic trainer
- The Pipedream workflow now runs two phases every tick: a read-only tick and an auto-train pass.
- The trainer only runs when `mode` is `"read-only"` and never changes `mode`.
- It adjusts `risk_level` within bounds, updates `version`, and sets `lastTrainedAt`/`lastEquityDelta`.
- You can still run the local trainer via `npm run train:policy` and revert policy.json via Git history.
- Training hyperparameters (minHistory, maxStep, bounds) live in the Pipedream script for easy tuning.
