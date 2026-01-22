# Value Steward

Value Steward is a risk-aware, memory-informed portfolio steward that works with an Alpaca paper trading account. It is designed to make conservative, explainable decisions and log intent for auditability.

Current scope:
- Paper trading only
- LOW risk mode only (v0)
- Shadow mode (simulated only) and execution mode (paper orders)

Core ideas:
- Risk caps per mode
- Intent logging with explanations
- Notifications (console/log now; email later)

Quickstart:
1) Create a virtual environment
2) Install requirements: `pip install -r requirements.txt`
3) Install the package in editable mode: `pip install -e .`
4) Copy `.env.example` to `.env` and fill in your Alpaca paper keys
5) Run a basic smoke command:
   - `python -m valuesteward.cli status`
   - `python -m valuesteward.cli tick`

## GitHub Actions deployment (optional)

This repo ships with a basic GitHub Actions workflow that can run a single
Value Steward `tick` on a schedule (every 30 minutes by default).

To enable it:

1. Add the following secrets in your GitHub repository settings:

   - `ALPACA_API_KEY_ID` (paper key)
   - `ALPACA_SECRET_KEY` (paper secret)
   - `ALPACA_PAPER_BASE_URL` = `https://paper-api.alpaca.markets`

   - `VS_MODE` = `LOW`
   - `VS_SHADOW_MODE` = `true` (start in shadow mode)
   - `VS_EXECUTION_ARMED` = `false`

   - `MAX_EFFECTIVE_CAPITAL_DOLLARS` = `20`
   - `MAX_TRADE_NOTIONAL_DOLLARS` = `10`
   - `MIN_TRADE_NOTIONAL_DOLLARS` = `1`

2. Go to the GitHub Actions tab, select \"Value Steward Tick\", and run the
   workflow manually to verify it works in shadow mode before enabling the
   schedule for real.
