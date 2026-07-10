# Value Steward System Mechanics (Pre-LLM Integration)

Value Steward is an automated trading agent that ranks assets by momentum, volatility, and drawdown and trades within hard risk limits on a paper account. This document explains the core deterministic mechanics of the system as of Phase 1.5.

## 1. Architectural Foundation
The system uses a **Hybrid-Language, Unified-State Architecture**:
- **Node.js Infrastructure:** Manages data collection (RSS feeds), hardware interfaces (GPIO), systemd automation, and high-level health monitoring.
- **Python Decision Brain:** Handles complex signal generation, portfolio math, risk-mode switching, and Alpaca API execution.
- **Unified State (`data/steward-state.json`):** A shared source of truth that ensures both languages operate on the same daily equity baseline, operational mode, and safety toggles.

## 2. The Decision Loop (The "Tick")
Every 15 minutes during market hours, the system performs a "Tick":
1.  **Ingest World Context:** Fetches global financial news and identifies risk levels using weighted keyword analysis.
2.  **Generate Signals:** Ranks tradable symbols by a blend of Momentum (Trend), Volatility (Risk), and Max Drawdown (Pain).
3.  **Portfolio Snapshot:** Captures current account equity and positions from Alpaca.
4.  **Rebalance Engine:** Compares actual risk exposure to the Target Exposure (defined by the current Mode: LOW or MEDIUM).
5.  **Risk Governor:** Validates that any proposed trade fits within position caps and weekly loss limits.
6.  **Execution:** If a trade is approved, the "Arm" reaches out to Alpaca.

## 3. The "Fishing" Strategy (Execution Optimization)
To maximize returns, the system avoids "Market Orders" (which pay the spread tax).
- **Mid-Point Logic:** The bot calculates the exact middle price between what buyers want (Bid) and sellers want (Ask).
- **Passive Limits:** It submits a Limit Order at this Mid-Point.
- **Cancel & Catch:** If the order isn't filled within one Tick cycle, the bot cancels it and "re-casts" based on the new Mid-Point price.
- **Partial Fill Awareness:** If an order only partially fills, the system calculates the remaining amount and only fishes for the rest, preventing over-exposure.

## 4. Safety Circuit Breakers
The "Steward" aspect is enforced by three primary shields:
- **Daily Equity Kill-Switch:** If the total account value drops more than 3% from the daily start, all trading is halted automatically.
- **Stale Data Guard:** If a stock's price data hasn't updated in 24 hours, the system ignores it to prevent trading on "ghost" data.
- **Hardware Override:** Physical switches (via GPIO) can disable trading or halt the system instantly, bypassing all software logic.

## 5. Performance Attribution
Every decision is logged in `logs/intent_log.jsonl` and tracked via a **Scorecard System**:
- **Slippage Analysis:** Measures the difference between the "Fished" price and the "Actual" fill price to audit execution quality.
- **Horizon Tracking:** Evaluates the success of every trade (or hold) over 1, 5, and 20-day windows.
- **Weekly Rollup:** A summary email is sent every Sunday auditing hit-rates and excess returns versus the benchmark (SPY).

---
*This system is currently 100% deterministic and rule-based, providing a safe and transparent baseline before the introduction of probabilistic LLM sentiment analysis.*
