---
name: steward-institutional-finance
description: Institutional trading and risk management standards for the Value Steward project. Provides procedural knowledge for portfolio construction, position sizing, and capital preservation.
---

# Steward Institutional Finance

This skill provides the financial logic and risk management standards for the Value Steward project.

## Core Mandates

1.  **Capital Preservation First:** Compounding only works if capital survives. Avoid "unforced errors" like trading on stale data or ignoring daily drawdown limits.
2.  **Momentum with Discipline:** Capture upside trends but only when accompanied by low volatility.
3.  **The Steward's Shield:** Always honor the 3% daily kill-switch. Never override a circuit breaker without a manual audit.

## Risk Standards

### 1. Position Sizing
- Use **Inverse Volatility Scaling**.
- Never exceed 8% of total equity in a single symbol (LOW mode).
- Target 20% total risk exposure (LOW mode).

### 2. Execution Hygiene
- Always use **Mid-point Limit Orders** ("Fishing").
- Perform a **Partial Fill Audit** before re-casting orders.
- Rounded all notional amounts to 2 decimal places.

### 3. Data Integrity
- Discard any signal where the price data is > 24h old (accounting for weekends).
- Audit the **Intelligence Divergence** (Guardian vs Scout) weekly.

## Workflow

When proposing trades or rebalances, always cross-reference against the **Risk Governor** configurations in `src/valuesteward/core/risk_modes.py`.
