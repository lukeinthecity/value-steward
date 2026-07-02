# Value Steward

[![CI](https://github.com/lukeinthecity/value-steward/actions/workflows/ci.yml/badge.svg)](https://github.com/lukeinthecity/value-steward/actions/workflows/ci.yml)

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
*   **Institutional Safety:** Multi-layered circuit breakers, including a 3% daily equity kill-switch, a 2.0 SD per-position vol-stop (panic exit), and stale-data guards.
*   **Capital Discipline + Rotation:** A hard deployment cap bounds total at-risk capital. Appreciation *above* the cap is allowed — winners run. The system only sells to free room when a genuinely stronger new candidate is otherwise blocked, rotating out the weakest holding (buy-coupled rotation, not forced trimming).
*   **Strategic Hold Logic:** Lets winners run by refusing to sell strong assets for marginal opportunities.
*   **Auditability:** Comprehensive JSONL logs of every intent, decision, and execution for performance attribution and learning.

## 🧠 Adaptive Learning Loop

The signal scoring and decision gates are no longer static. Every end-of-day cycle, the system grades its own decisions against the next-day, 5-day, and 20-day forward returns of the symbols it bought *and the symbols it blocked* (counterfactuals), and updates its policy:

*   **Ridge-regularized OLS regression** over the three rank features (momentum / vol / drawdown) against forward alpha (`excess_vs_benchmark`). Per-feature **t-statistic gating** (`|t| ≥ 2.0`, ~p < 0.05) skips updates that aren't statistically distinguishable from noise.
*   **Thompson sampling** on the score gate (opt-in): per-symbol Beta posteriors built from the scorecard let high-conviction winners through easily and rarely admit known losers.
*   **Regime-conditional weights:** separate `[w_mom, w_vol, w_dd]` triplets per macro regime (calm / watchful / stressed / crisis-prone), trained independently from records taken in that regime.
*   **Out-of-sample evaluation** (`data/oos-eval.jsonl`) tracks rolling Sharpe of decisions made under the current policy.
*   **Champion-challenger auto-rollback** (opt-in): the trainer preserves a "champion" snapshot of the last weights that proved their OOS Sharpe; if the live policy underperforms the champion for 3 consecutive cycles it auto-reverts.

All learning is gated by significance / sample-size floors and behind env vars so the system fails closed — defaults preserve the original deterministic behavior until enough data accumulates. See [`docs/ML_BACKLOG.md`](docs/ML_BACKLOG.md) for the Tier 2 / Tier 3 roadmap to revisit after each Phase 1 run.

## 🛠 Quickstart

### Prerequisites
- Node.js (v18+)
- Python 3.10+
- Alpaca Paper Trading Account

### Setup
1. **Clone & Install:**
   ```bash
   git clone https://github.com/lukeinthecity/value-steward.git
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

## 📟 Operations & Observability

Day-to-day health is visible without depending on email (a silent SMTP failure can no longer go unnoticed):

```bash
npm run runtime:status     # one-shot snapshot: phase day count, cron pulse,
                           # positions, recent trades/blocks, ML training +
                           # OOS state, email health, feature flags
npm run runtime:watch      # same view, auto-refreshing in the terminal (10s)
npm run runtime:append     # append a compact JSON line to data/runtime.log
                           # (wire to cron for a historical record)
npm run email:test         # send a test email and verify SMTP + AI summary
```

The **desktop app** (`npm start` from `desktop/`) mirrors this in a live-updating **Runtime Status** panel.

Every email send outcome is recorded to `data/email-health.json` and surfaced in `runtime:status`, so credential or transport failures show up immediately.

Operating discipline and the per-run review checklist live in [`docs/SESSION_BRIEF.md`](docs/SESSION_BRIEF.md) and [`docs/PLAYBOOK_WEEKLY_REVIEW.md`](docs/PLAYBOOK_WEEKLY_REVIEW.md).

## 📊 Reporting

Value Steward automatically generates a **Weekly Performance Report** every Sunday at 6:00 PM ET, summarizing:
- Hit rates across 1, 5, and 20-day horizons.
- Excess returns versus the benchmark (SPY).
- Execution quality (Average Slippage).
- Strategic Hold counts (Decisions influenced by safety gates).

Daily **End-of-Day** and **Health** emails include an AI-synthesized "Steward's Insight" (Google Gemini via the `generateContent` API) over the cycle's technical data.

---

---

## 📜 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details. 

*Disclaimer: Value Steward is an automated software utility designed for educational and paper-testing purposes. Algorithmic trading carries substantial financial risk. Use of this software with live capital is entirely at your own risk under the terms of the Apache 2.0 liability shield.*
