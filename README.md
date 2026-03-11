# Value Steward

**Systematic, Risk-Aware Portfolio Management Agent**

Value Steward is an institutional-grade automated trading agent designed to "turn one dollar into two" through systematic momentum capture and rigorous risk management. It bridges global macro intelligence with local mathematical precision to operate as a disciplined portfolio manager.

---

## 🏛 Architecture

The system uses a **Hybrid-Language, Unified-State Architecture**:

*   **World Layer (Node.js):** Continuous global financial news ingestion, sentiment scoring, and macro risk classification.
*   **Brain Layer (Python):** Deterministic signal ranking (Momentum, Volatility, Drawdown), portfolio rebalancing, and risk governance.
*   **Execution Layer (Python):** High-precision order submission using "Fishing" (Mid-point Limit) strategies to minimize slippage.
*   **Unified State:** A shared JSON source of truth that ensures all system components operate on identical daily equity baselines and safety toggles.

## 🚀 Key Features

*   **Dynamic Risk Modes:** Support for `LOW`, `MEDIUM`, and `HIGH` target risk exposures.
*   **Professional Execution:** Mid-point Limit Orders with "Cancel & Catch" logic to save the bid-ask spread.
*   **Institutional Safety:** Multi-layered circuit breakers, including a 3% daily equity kill-switch and stale data guards.
*   **Strategic Hold Logic:** Intelligent enough to let winners run by refusing to sell strong assets even when overweight.
*   **Auditability:** Comprehensive JSONL logs of every intent, decision, and execution for performance attribution and learning.

## 🛠 Quickstart

### Prerequisites
- Node.js (v18+)
- Python 3.10+
- Alpaca Paper Trading Account

### Setup
1. **Clone & Install:**
   ```bash
   git clone https://github.com/your-repo/value-steward.git
   cd value-steward
   npm install
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   pip install -e .
   ```

2. **Configure:**
   Copy `.env.example` to `.env` and provide your Alpaca API keys.

3. **Initialize Automation:**
   ```bash
   sudo cp docs/systemd/*.timer /etc/systemd/system/
   sudo cp docs/systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now value-steward-world.timer
   sudo systemctl enable --now value-steward-tick.timer
   ```

## 📊 Reporting

Value Steward automatically generates a **Weekly Performance Report** every Sunday at 6:00 PM ET, summarizing:
- Hit rates across 1, 5, and 20-day horizons.
- Excess returns versus the benchmark (SPY).
- Execution quality (Average Slippage).
- Strategic Hold counts (Decisions influenced by safety gates).

---

## 📜 License
Internal Development - All Rights Reserved.
