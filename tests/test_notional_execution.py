"""Tests for notional-based execution sizing."""

from datetime import datetime, timezone

import pytest

from valuesteward.config import ValueStewardSettings
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import (
    IntentRecord,
    PortfolioSnapshot,
    Position,
    RiskMode,
    TradeAction,
)


@pytest.fixture(autouse=True)
def mock_steward_state(tmp_path, monkeypatch):
    """Ensure sizing tests do not read live operator state."""
    fake_state = tmp_path / "steward-state.json"
    monkeypatch.setattr("valuesteward.steward_state.STATE_PATH", fake_state)
    monkeypatch.setattr(
        "valuesteward.steward_state.STATE_LOCK_PATH",
        tmp_path / "steward-state.json.lock",
    )
    return fake_state


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

    def cancel_open_orders(self, symbol: str) -> int:
        return 0

    def get_snapshots(self, *args, **kwargs):
        class Snap:
            def __init__(self):
                self.latest_quote = type('Quote', (), {'bid_price': 100, 'ask_price': 101})()
        return {"SPY": Snap()}


def build_snapshot(equity: float) -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=equity,
        equity=equity,
        positions=[],
        risk_exposure_pct=0.0,
    )


def build_snapshot_with_positions(
    equity: float, positions: list[Position]
) -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=max(equity - sum(p.market_value for p in positions), 0.0),
        equity=equity,
        positions=positions,
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


def test_effective_capital_clamps_notional(monkeypatch) -> None:
    # Bypass window guard for sizing tests
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window", 
        lambda self: True
    )
    
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


def test_max_trade_notional_clamps(monkeypatch) -> None:
    # Bypass window guard for sizing tests
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window", 
        lambda self: True
    )
    
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


def test_skip_when_below_min_notional(monkeypatch) -> None:
    # Bypass window guard for sizing tests
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window", 
        lambda self: True
    )
    
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


def test_sandbox_cap_clamps_to_remaining_headroom(monkeypatch) -> None:
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )

    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_sandbox_deployed_dollars=20.0,
        max_trade_notional_dollars=10.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    intent = build_intent(size_pct=1.0)
    snapshot = build_snapshot_with_positions(
        equity=100_000.0,
        positions=[
            Position(
                symbol="TLT",
                quantity=0.15,
                market_value=17.0,
                asset_class="us_equity",
            )
        ],
    )
    engine.execute_intent(intent, snapshot)
    assert engine.alpaca_client.submitted is True
    assert engine.alpaca_client.last_notional == 3.0


def test_sandbox_cap_blocks_buy_when_headroom_is_exhausted(monkeypatch) -> None:
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )

    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_sandbox_deployed_dollars=20.0,
        max_trade_notional_dollars=10.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    intent = build_intent(size_pct=1.0)
    snapshot = build_snapshot_with_positions(
        equity=100_000.0,
        positions=[
            Position(
                symbol="TLT",
                quantity=0.2,
                market_value=20.0,
                asset_class="us_equity",
            )
        ],
    )
    engine.execute_intent(intent, snapshot)
    assert engine.alpaca_client.submitted is False


def test_multi_action_sell_frees_sandbox_headroom_for_following_buy(monkeypatch) -> None:
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )

    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_sandbox_deployed_dollars=20.0,
        max_trade_notional_dollars=5.0,
        min_trade_notional_dollars=1.0,
    )
    fake_client = FakeAlpacaClient()
    engine = ExecutionEngine(
        alpaca_client=fake_client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="MULTI",
        explanation="rebalance",
        actions=[
            TradeAction(symbol="TLT", side="sell", notional=5.0, reason="reduce"),
            TradeAction(symbol="SPY", side="buy", notional=5.0, reason="add"),
        ],
    )
    snapshot = build_snapshot_with_positions(
        equity=100_000.0,
        positions=[
            Position(
                symbol="TLT",
                quantity=0.2,
                market_value=20.0,
                asset_class="us_equity",
            )
        ],
    )

    submissions = []

    def capture_submit(symbol: str, side: str, notional: float) -> float:
        submissions.append((symbol, side, notional))
        fake_client.submitted = True
        fake_client.last_notional = notional
        return 100.0

    fake_client.submit_steward_order = capture_submit

    engine.execute_intent(intent, snapshot)

    assert submissions == [
        ("TLT", "sell", 5.0),
        ("SPY", "buy", 5.0),
    ]
