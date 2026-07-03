"""Intent → order linkage: client_order_id stamping at submission time."""

from datetime import datetime, timezone

import pytest

from valuesteward.config import ValueStewardSettings
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import (
    IntentRecord,
    PortfolioSnapshot,
    RiskMode,
    TradeAction,
)


@pytest.fixture(autouse=True)
def mock_steward_state(tmp_path, monkeypatch):
    fake_state = tmp_path / "steward-state.json"
    monkeypatch.setattr("valuesteward.steward_state.STATE_PATH", fake_state)
    monkeypatch.setattr(
        "valuesteward.steward_state.STATE_LOCK_PATH",
        tmp_path / "steward-state.json.lock",
    )
    return fake_state


@pytest.fixture(autouse=True)
def bypass_execution_window(monkeypatch):
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )


class RecordingClient:
    def __init__(self) -> None:
        self.submissions: list[dict] = []

    def submit_steward_order(
        self,
        symbol: str,
        side: str,
        notional: float,
        client_order_id: str | None = None,
    ) -> float:
        self.submissions.append(
            {
                "symbol": symbol,
                "side": side,
                "notional": notional,
                "client_order_id": client_order_id,
            }
        )
        return 100.0

    def get_open_orders(self) -> list:
        return []

    def cancel_open_orders(self, symbol: str) -> int:
        return 0


def build_settings(**overrides) -> ValueStewardSettings:
    kwargs = {
        "alpaca_api_key_id": "test-key",
        "alpaca_secret_key": "test-secret",
        "shadow_mode": False,
        "execution_armed": True,
        "max_effective_capital_dollars": 20.0,
        "max_trade_notional_dollars": 10.0,
        "min_trade_notional_dollars": 1.0,
    }
    kwargs.update(overrides)
    return ValueStewardSettings(**kwargs)


def build_engine(client, **setting_overrides) -> ExecutionEngine:
    settings = build_settings(**setting_overrides)
    return ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )


def build_snapshot(equity: float = 100_000.0) -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=equity,
        equity=equity,
        positions=[],
        risk_exposure_pct=0.0,
    )


def test_single_path_stamps_client_order_id() -> None:
    client = RecordingClient()
    engine = build_engine(client)
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="SPY",
        size_pct=0.5,
        explanation="test",
    )

    engine.execute_intent(intent, build_snapshot())

    assert len(client.submissions) == 1
    expected = f"{intent.id}:SPY"
    assert client.submissions[0]["client_order_id"] == expected
    assert intent.order_client_ids == [expected]


def test_multi_path_stamps_each_action() -> None:
    client = RecordingClient()
    engine = build_engine(client)
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="MULTI",
        symbol="SPY",
        size_pct=0.0,
        explanation="multi test",
        actions=[
            TradeAction(symbol="SPY", side="buy", notional=5.0),
            TradeAction(symbol="QQQ", side="buy", notional=5.0),
        ],
    )

    engine.execute_intent(intent, build_snapshot())

    submitted_ids = [s["client_order_id"] for s in client.submissions]
    assert submitted_ids == [f"{intent.id}:SPY", f"{intent.id}:QQQ"]
    assert intent.order_client_ids == submitted_ids
    assert intent.actions[0].order_client_id == f"{intent.id}:SPY"
    assert intent.actions[1].order_client_id == f"{intent.id}:QQQ"


def test_shadow_mode_stamps_nothing() -> None:
    client = RecordingClient()
    engine = build_engine(client, shadow_mode=True, execution_armed=False)
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="SPY",
        size_pct=0.5,
        explanation="shadow test",
    )

    engine.execute_intent(intent, build_snapshot())

    assert client.submissions == []
    assert intent.order_client_ids == []


def test_intent_json_dict_includes_order_client_ids() -> None:
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="SPY",
        explanation="serialization test",
    )
    intent.order_client_ids.append(f"{intent.id}:SPY")

    payload = intent.to_json_dict()

    assert payload["order_client_ids"] == [f"{intent.id}:SPY"]
    assert payload["timestamp"].endswith("Z")
