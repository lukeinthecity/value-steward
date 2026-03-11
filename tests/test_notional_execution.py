"""Tests for notional-based execution sizing."""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted = False
        self.last_notional = None

    def submit_steward_order(self, symbol: str, side: str, notional: float) -> float:
        self.submitted = True
        self.last_notional = notional
        return 100.0 # Return a dummy price

    def get_open_orders(self) -> list:
        return []

    def cancel_open_orders(self, symbol: str) -> None:
        pass


def build_snapshot(equity: float) -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=equity,
        equity=equity,
        positions=[],
        risk_exposure_pct=0.0,
    )


def build_intent(size_pct: float) -> IntentRecord:
    return IntentRecord(
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="SPY",
        size_pct=size_pct,
        explanation="test",
    )


def build_settings(**overrides) -> ValueStewardSettings:
    return ValueStewardSettings(
        alpaca_api_key_id="test-key",
        alpaca_secret_key="test-secret",
        shadow_mode=False,
        execution_armed=True,
        **overrides,
    )


def test_effective_capital_clamps_notional() -> None:
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=100.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    intent = build_intent(size_pct=0.5)
    snapshot = build_snapshot(equity=100_000.0)
    engine.execute_intent(intent, snapshot)
    assert engine.alpaca_client.submitted is True
    assert engine.alpaca_client.last_notional == 20.0


def test_max_trade_notional_clamps() -> None:
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=10.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    intent = build_intent(size_pct=1.0)
    snapshot = build_snapshot(equity=100_000.0)
    engine.execute_intent(intent, snapshot)
    assert engine.alpaca_client.submitted is True
    assert engine.alpaca_client.last_notional == 10.0


def test_skip_when_below_min_notional() -> None:
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=10.0,
        min_trade_notional_dollars=5.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    intent = build_intent(size_pct=0.00001)
    snapshot = build_snapshot(equity=100_000.0)
    engine.execute_intent(intent, snapshot)
    assert engine.alpaca_client.submitted is False
