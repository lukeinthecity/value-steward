# Value Steward

Value Steward is currently a read-only, policy‑driven portfolio steward that observes an Alpaca paper account each day, logs rich end‑of‑day snapshots, and adaptively tunes a risk‑level policy based on historical trends, volatility, exposure, and cash utilization. The system is designed to be portable across environments (local, Pipedream, or future servers), keeps all actions in safe “no‑trade” mode, and writes a complete audit trail of both observations and training decisions. Each tick stores structured history for future learning, and when the policy meaningfully updates, it can notify you via SMTP email with a concise lesson summary.

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
