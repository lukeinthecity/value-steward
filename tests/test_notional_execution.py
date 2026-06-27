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


def build_snapshot(
    equity: float,
    *,
    cash: float | None = None,
    positions: list[Position] | None = None,
) -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=equity if cash is None else cash,
        equity=equity,
        positions=positions or [],
        risk_exposure_pct=0.0
        if not positions
        else sum(position.market_value for position in positions) / equity,
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


def test_portfolio_sandbox_cap_blocks_buy_when_headroom_exhausted(monkeypatch) -> None:
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )

    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=5.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    snapshot = build_snapshot(
        equity=100_000.0,
        cash=99_980.0,
        positions=[
            Position(symbol="A", quantity=1.0, market_value=10.0, asset_class="us_equity"),
            Position(symbol="B", quantity=1.0, market_value=10.0, asset_class="us_equity"),
        ],
    )
    engine.execute_intent(build_intent(size_pct=0.5), snapshot)
    assert engine.alpaca_client.submitted is False


def test_portfolio_sandbox_cap_clamps_buy_to_remaining_headroom(monkeypatch) -> None:
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )

    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=5.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    snapshot = build_snapshot(
        equity=100_000.0,
        cash=99_983.0,
        positions=[
            Position(symbol="A", quantity=1.0, market_value=17.0, asset_class="us_equity"),
        ],
    )
    engine.execute_intent(build_intent(size_pct=0.5), snapshot)
    assert engine.alpaca_client.submitted is True
    assert engine.alpaca_client.last_notional == 3.0


def _sell_intent(symbol: str, size_pct: float) -> IntentRecord:
    return IntentRecord(
        mode=RiskMode.LOW,
        action_type="SELL",
        symbol=symbol,
        size_pct=size_pct,
        explanation="sell test",
    )


def test_sell_not_throttled_by_max_trade_notional(monkeypatch) -> None:
    """REGRESSION: SELLs are risk-reducing and must NOT be capped by the
    per-trade BUY notional cap. A position worth 7 with max_trade= must
    be sellable in full (bounded by position MV, not the BUY cap)."""
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=8.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )
    snapshot = build_snapshot(
        equity=100_000.0,
        cash=99_983.0,
        positions=[
            Position(symbol="MET", quantity=1.0, market_value=17.0, asset_class="us_equity"),
        ],
    )
    # size_pct=1.0 -> raw_notional huge; should clamp to position MV (7),
    # NOT to max_trade_notional ().
    engine.execute_intent(_sell_intent("MET", size_pct=1.0), snapshot)
    assert engine.alpaca_client.submitted is True
    assert engine.alpaca_client.last_notional == 17.0


def test_sell_clamped_to_position_market_value(monkeypatch) -> None:
    """A SELL larger than the held position is clamped to the position MV."""
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=8.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )
    snapshot = build_snapshot(
        equity=100_000.0,
        cash=99_988.0,
        positions=[
            Position(symbol="OEF", quantity=1.0, market_value=12.0, asset_class="us_equity"),
        ],
    )
    engine.execute_intent(_sell_intent("OEF", size_pct=1.0), snapshot)
    assert engine.alpaca_client.last_notional == 12.0


def test_sell_skips_when_no_position(monkeypatch) -> None:
    """A SELL for a symbol we do not hold submits nothing."""
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=8.0,
        min_trade_notional_dollars=1.0,
    )
    engine = ExecutionEngine(
        alpaca_client=FakeAlpacaClient(),
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )
    snapshot = build_snapshot(equity=100_000.0, positions=[])
    engine.execute_intent(_sell_intent("GHOST", size_pct=1.0), snapshot)
    assert engine.alpaca_client.submitted is False


class FakeOrder:
    """Minimal stand-in for an Alpaca open order."""

    def __init__(
        self,
        symbol: str,
        *,
        side: str = "buy",
        filled_qty: float = 0.0,
        filled_avg_price: float = 0.0,
    ) -> None:
        self.symbol = symbol
        self.side = side
        self.filled_qty = filled_qty
        self.filled_avg_price = filled_avg_price


class CancelCountingClient(FakeAlpacaClient):
    """Records every cancel_open_orders(symbol) call so we can count them."""

    def __init__(self, open_orders: list) -> None:
        super().__init__()
        self._open_orders = open_orders
        self.cancel_calls: list[str] = []

    def get_open_orders(self) -> list:
        return self._open_orders

    def cancel_open_orders(self, symbol: str) -> int:
        self.cancel_calls.append(symbol)
        return 0


def _armed_engine(client) -> ExecutionEngine:
    settings = build_settings(
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=10.0,
        min_trade_notional_dollars=1.0,
    )
    return ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )


def test_single_path_cancels_open_orders_once(monkeypatch) -> None:
    """Two still-open orders for the same symbol must yield exactly ONE
    cancel_open_orders call (pre-fix it fired once per matching order), and
    the trade outcome is unchanged — the order still submits."""
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )
    client = CancelCountingClient([FakeOrder("SPY"), FakeOrder("SPY")])
    engine = _armed_engine(client)

    engine.execute_intent(build_intent(size_pct=1.0), build_snapshot(equity=100_000.0))

    assert client.cancel_calls == ["SPY"]  # was 2 before the fix
    assert client.submitted is True  # outcome preserved


def test_multi_path_cancels_each_symbol_once(monkeypatch) -> None:
    """In the multi-action path, each leg cancels its symbol once — not once
    per matching open order (pre-fix this leg would emit 4 cancels)."""
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )
    client = CancelCountingClient(
        [
            FakeOrder("SPY"),
            FakeOrder("SPY"),
            FakeOrder("QQQ"),
            FakeOrder("QQQ"),
        ]
    )
    engine = _armed_engine(client)
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="SPY",
        size_pct=0.0,
        explanation="multi-leg test",
        actions=[
            TradeAction(symbol="SPY", side="buy", notional=5.0),
            TradeAction(symbol="QQQ", side="buy", notional=5.0),
        ],
    )

    engine.execute_intent(intent, build_snapshot(equity=100_000.0))

    assert sorted(client.cancel_calls) == ["QQQ", "SPY"]  # was 4 before the fix
