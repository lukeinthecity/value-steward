# Agent Loop Mechanics

The Value Steward operates on a periodic "Tick" cycle (defaulting to every 15 minutes during market hours). Each tick follows a specific sequence to ensure safety, data integrity, and deterministic execution.

## The Tick Sequence

1.  **State Loading:** The agent loads the unified `data/steward-state.json`, which contains the mode, trading toggles, and daily equity baseline.
2.  **Infrastructure Check:** The agent verifies internet connectivity and broker (Alpaca) API status.
3.  **GPIO Sync:** If a GPIO bridge is active, hardware-level toggles (e.g., physical switches) are synced into the unified state.
4.  **World Context Refresh:** The agent reads the latest `data/world-context.jsonl` to ingest macro sentiment scores.
5.  **Decision Engine (The Brain):**
    *   **Signal Generation:** Ranks symbols based on Momentum, Volatility, and Drawdown.
    *   **Stale Data Check:** Discards any symbols with price data older than 1 trading day.
    *   **Rebalance Logic:** Compares current portfolio exposure to the target (adjusted by macro risk).
    *   **Strategic Hold:** May decide to "NO_ACTION" even if overweight if signals remain strong and risk is low.
6.  **Execution Engine (The Arm):**
    *   **Circuit Breaker:** Halts if daily loss exceeds 3%.
    *   **Fishing Strategy:** Cancels old orders and places new Mid-point Limit Orders.
    *   **Partial Fill Awareness:** Only "fishes" for the remaining amount if an order was partially filled.
7.  **State Persistence:** Updates the unified state with the latest run time, positions, and execution counts.

## Unified System State (`data/steward-state.json`)

This file is the single source of truth shared by both the Node.js infrastructure and the Python decision engine.

*   **`current_mode`**: `INACTIVE`, `CATCHUP`, `LIVE`, `RECOVERY`.
*   **`trading_enabled`**: Master toggle for automated trading.
*   **`force_no_trade`**: Safety kill-switch (Circuit Breaker).
*   **`daily_starting_equity`**: The account value at the start of the trading day.
*   **`executions_today`**: Counter to enforce daily trade limits.

## Decision Gates

Trading only occurs if all gates are passed:
*   `trading_enabled == true`
*   `force_no_trade == false`
*   `market_open == true`
*   `internet_ok && broker_ok`
*   `macro_risk` allows the specific action (BUY/SELL).
*   `risk_governor` confirms the trade won't exceed portfolio caps.
