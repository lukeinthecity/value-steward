"""Execution engine for Value Steward intents."""

from valuesteward.config import ValueStewardSettings, get_settings
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.models import IntentRecord, PortfolioSnapshot


class ExecutionEngine:
    """Execute approved intents, respecting shadow mode."""

    def __init__(
        self,
        alpaca_client: AlpacaClient,
        risk_governor: RiskGovernor,
        settings: ValueStewardSettings | None = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.risk_governor = risk_governor
        self.settings = settings or get_settings()

    def execute_intent(self, intent: IntentRecord, snapshot: PortfolioSnapshot) -> None:
        """Execute the supplied intent if allowed and not in shadow mode."""

        if intent.action_type in {"BUY", "SELL"}:
            size_pct = intent.size_pct or 0.0
            print(
                f"[EXEC] Intent: {intent.action_type} {intent.symbol} "
                f"size_pct={size_pct:.2%} (pre_risk={intent.pre_risk_exposure_pct:.2%} "
                f"-> post_risk={intent.post_risk_exposure_pct:.2%})"
            )

            effective_equity = min(
                snapshot.equity, self.settings.max_effective_capital_dollars
            )
            raw_notional = effective_equity * size_pct
            notional = min(raw_notional, self.settings.max_trade_notional_dollars)
            print(
                "[EXEC] Notional sizing: "
                f"effective_capital=${effective_equity:.2f} "
                f"raw_notional=${raw_notional:.2f} "
                f"final_notional=${notional:.2f}"
            )

            if self.settings.shadow_mode:
                print("[EXEC] Shadow mode active; not submitting order.")
                return

            if not self.settings.execution_armed:
                print(
                    "[EXEC] Execution not armed (VS_EXECUTION_ARMED=false); "
                    "not submitting order."
                )
                return

            if intent.symbol is None or intent.size_pct is None:
                raise ValueError("BUY/SELL intents require symbol and size_pct.")

            side = "buy" if intent.action_type == "BUY" else "sell"
            if notional < self.settings.min_trade_notional_dollars:
                print(
                    "[EXEC] Notional ${:.2f} below minimum trade size; "
                    "skipping execution.".format(notional)
                )
                return

            self.alpaca_client.submit_market_order(
                symbol=intent.symbol,
                side=side,
                notional=notional,
            )
            print(
                f"[EXEC] Notional order: ${notional:.2f} {intent.symbol} "
                f"(effective_capital=${effective_equity:.2f}, size_pct={size_pct:.2%})"
            )
            return

        if self.settings.shadow_mode:
            print("[SHADOW] Would execute intent:", intent.action_type)
        else:
            print("[EXECUTION] No actionable order for intent:", intent.action_type)
