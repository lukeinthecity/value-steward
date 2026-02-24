# Value Steward

Value Steward is currently a read-only, policy‑driven portfolio steward that observes an Alpaca paper account each day, logs rich end‑of‑day snapshots, and adaptively tunes a risk‑level policy based on historical trends, volatility, exposure, and cash utilization. The system is designed to run locally with scheduled ticks, keeps all actions in safe “no‑trade” mode, and writes a complete audit trail of both observations and training decisions. Each tick stores structured history for future learning, and when the policy meaningfully updates, it can notify you via SMTP email with a concise lesson summary.

Current scope:
- Paper trading only
- LOW risk mode only (v0)
- Shadow mode (simulated only) and execution mode (paper orders)

Core ideas:
- Risk caps per mode
- Intent logging with explanations
- Notifications (console/log now; email later)

**System Summary**
- World intelligence pipeline (Node) ingests RSS, hydrates content, scores tags, and writes daily world context with macro label/score.
- Signal engine (Python) ranks Alpaca symbols by multi‑horizon momentum, relative strength, volatility, and drawdown with multi‑day smoothing.
- Decision engine (Python) applies policy caps, world context gating, and signal adjustments to generate multi‑action plans.
- Execution engine (Python) enforces market hours, risk caps, and daily execution limits before submitting paper orders.
- Audit trail logs every intent and execution with reasoning and metadata.
- Desktop UI lives in `desktop/` and can display tick status and context feeds.

**Data Flow**
1. RSS ingestion → `data/world-inbox.jsonl` (raw headlines).
2. Hydration → `data/world-hydrated.jsonl` (extracted text/summary).
3. World context → `data/world-context.jsonl` (tags, macro score/label, summary).
4. Signal build → ranked symbols and smoothed scores.
5. Decision → intent record (buy/sell/rotate/hold).
6. Execution → paper orders when gates pass.

Quickstart:
1) Create a virtual environment
2) Install requirements: `pip install -r requirements.txt`
3) Install the package in editable mode: `pip install -e .`
4) Copy `.env.example` to `.env` and fill in your Alpaca paper keys
5) Run a basic smoke command:
   - `python -m valuesteward.cli status`
   - `python -m valuesteward.cli tick`

## Local scheduling (recommended)

Use your system scheduler (cron, Task Scheduler, etc.) to run:

- `npm run local:tick` every 15 minutes during market hours.
- `npm run world:run` 30 minutes before open and 30 minutes before close.
