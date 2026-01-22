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
