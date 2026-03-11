# Risk Management Models

## Inverse Volatility Scaling (IVS)

The goal of IVS is to ensure that every position in the portfolio contributes an equal amount of risk, rather than an equal amount of dollars.

**The Formula:**
`Symbol Notional = Target Notional * (Universe Average Volatility / Symbol Volatility)`

**Constraints:**
- Minimum Multiplier: 0.5x (Don't over-size stable assets too much).
- Maximum Multiplier: 2.0x (Don't under-size volatile assets too much).

## Strategic Hold (The Hysteresis Buffer)

To avoid "churning" (high transaction costs), the Steward uses a 2% buffer zone.

- **Rebalance Trigger:** Only BUY or SELL if the current exposure is > 2% away from the target.
- **Winner Override:** If an asset is overweight but has a `signal.score > 0.80` and `macro_risk < 0.30`, the Steward will **HOLD** to avoid cutting a profitable trend early.
