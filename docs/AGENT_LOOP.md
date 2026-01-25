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
- The trainer now evaluates trend, volatility, cash utilization, exposure, and concentration metrics.
- Each training run logs a decision record to `data/training-log.jsonl` with metrics and rationale.
- It still only updates `risk_level` within hard bounds, in small steps capped by `maxStep`.
- No orders are ever placed as part of training.

## Notifications
- When the trainer updates `policy.risk_level`, the agent attempts to send a summary email via SMTP.
- The email includes policy changes, training reason, key metrics, and snapshot context.
- When available, the email also includes key macro tags and the world context summary.
- Required env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`.
- If any are missing, the agent logs a warning and skips email without affecting the EOD loop.

## Per-tick perception
- Each history entry captures an EOD snapshot (run near market close) via read-only Alpaca endpoints.
- Even when the market is closed, the agent still fetches account and positions data and logs a full snapshot.
- In those cases, `marketOpen` is false and `accountStatus` is `MARKET_CLOSED`, but all other fields are populated.
- Account fields: `equity`, `buyingPower`, `cash`, `portfolioValue`, `patternDayTrader`, `marginMultiplier`, `cashUtilization`, `equityToBuyingPower`.
- Positions summary: `numPositions`, `longMarketValue`, `shortMarketValue`, `grossExposure`, `netExposure`, `maxPositionWeight`, and `positions[]` summaries.
- Market timing: `isMarketOpen`, `nextOpen`, `nextClose`.
- Placeholder context: `worldContext` (empty for now; reserved for future signals).
- All of this data is collected read-only; no orders are placed during ticks or training.
- Each tick result includes a `worldContext` field when a macro digest is available.
- When present, `worldContext.macro_view` summarizes the smoothed macro score and label.

## Operational modes and trade gate
- Modes: `INACTIVE`, `RECOVERY`, `LIVE`, `ERROR`.
- Trade gate invariant: `can_trade = trading_enabled && internet_ok && broker_ok && mode == LIVE`.
- `trading_enabled` is currently sourced from `process.env.TRADING_ENABLED` and defaults to false.

## Agent state file
- `data/agent-state.json` stores the latest operational snapshot:
  - `last_run_wall_clock`, `last_market_timestamp`
  - `last_known_positions`, `open_orders_snapshot`
  - `current_mode`, `last_mode_transition_reason`, `status_indicator`
