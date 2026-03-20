"""Tests for execution safety switches."""

import pytest
from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode

@pytest.fixture(autouse=True)
def mock_steward_state(tmp_path, monkeypatch):
    """Ensure tests use a temporary state file."""
    fake_state = tmp_path / "steward-state.json"
    monkeypatch.setattr("valuesteward.steward_state.STATE_PATH", fake_state)
    return fake_state

class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted = False

    def submit_steward_order(self, *args, **kwargs) -> float:
        self.submitted = True
        return 100.0

    def get_open_orders(self) -> list:
        return []

    def cancel_open_orders(self, symbol: str) -> int:
        return 0

    def get_snapshots(self, *args, **kwargs):
        class Snap:
            def __init__(self):
                self.latest_quote = type('Quote', (), {'bid_price': 100, 'ask_price': 101})()
        return {"SPY": Snap()}

def test_execution_allowed_inside_window(monkeypatch) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    
    # 3:45 PM ET (15:45) - Should be ALLOWED
    tz = ZoneInfo("America/New_York")
    fake_now = datetime(2026, 3, 11, 15, 45, 0, tzinfo=tz)
    
    class MockDatetime:
        @classmethod
        def now(cls, tz=None):
            return fake_now.astimezone(tz) if tz else fake_now

    monkeypatch.setattr("valuesteward.core.execution_engine.datetime", MockDatetime)
    
    settings = build_settings(shadow_mode=False, execution_armed=True)
    # Ensure min notional doesn't block us
    settings.min_trade_notional_dollars = 1.0
    
    client = FakeAlpacaClient()
    engine = ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    # Intent with size to ensure notional > min
    intent = build_intent()
    intent.size_pct = 0.1
    
    # Snapshot with equity to ensure notional > min
    snapshot = build_snapshot()
    snapshot.equity = 1000.0

    engine.execute_intent(intent, snapshot)
    assert client.submitted is True


def build_snapshot() -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )


def build_intent() -> IntentRecord:
    return IntentRecord(
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="SPY",
        size_pct=0.05,
        explanation="test",
    )


def build_settings(shadow_mode: bool, execution_armed: bool) -> ValueStewardSettings:
    return ValueStewardSettings(
        alpaca_api_key_id="test-key",
        alpaca_secret_key="test-secret",
        shadow_mode=shadow_mode,
        execution_armed=execution_armed,
    )


def test_execution_blocked_in_shadow_mode() -> None:
    settings = build_settings(shadow_mode=True, execution_armed=False)
    client = FakeAlpacaClient()
    engine = ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    engine.execute_intent(build_intent(), build_snapshot())
    assert client.submitted is False


def test_execution_blocked_outside_window(monkeypatch) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    
    # 4:30 PM ET (16:30) - Should be BLOCKED
    tz = ZoneInfo("America/New_York")
    fake_now = datetime(2026, 3, 11, 16, 30, 0, tzinfo=tz)
    
    class MockDatetime:
        @classmethod
        def now(cls, tz=None):
            return fake_now.astimezone(tz) if tz else fake_now

    monkeypatch.setattr("valuesteward.core.execution_engine.datetime", MockDatetime)
    
    settings = build_settings(shadow_mode=False, execution_armed=True)
    client = FakeAlpacaClient()
    engine = ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    engine.execute_intent(build_intent(), build_snapshot())
    assert client.submitted is False


def test_execution_window_tracks_early_close(monkeypatch) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("America/New_York")
    fake_now = datetime(2026, 11, 27, 12, 45, 0, tzinfo=tz)

    class MockDatetime:
        @classmethod
        def now(cls, tz=None):
            return fake_now.astimezone(tz) if tz else fake_now

    monkeypatch.setattr("valuesteward.core.execution_engine.datetime", MockDatetime)
    monkeypatch.setattr(
        "valuesteward.market_holidays.ensure_holiday_file",
        lambda *args, **kwargs: {
            "holidays": [],
            "early_closes": [
                {
                    "date": "2026-11-27",
                    "close_time": "13:00",
                    "label": "Day after Thanksgiving",
                }
            ],
        },
    )

    settings = build_settings(shadow_mode=False, execution_armed=True)
    client = FakeAlpacaClient()
    engine = ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    engine.execute_intent(build_intent(), build_snapshot())
    assert client.submitted is True
