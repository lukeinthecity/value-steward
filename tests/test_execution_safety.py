"""Tests for execution safety switches."""

from datetime import datetime

from valuesteward.config import ValueStewardSettings
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted = False

    def submit_order(self, *args, **kwargs) -> None:
        self.submitted = True


def build_snapshot() -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.utcnow(),
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


def test_execution_blocked_when_not_armed() -> None:
    settings = build_settings(shadow_mode=False, execution_armed=False)
    client = FakeAlpacaClient()
    engine = ExecutionEngine(
        alpaca_client=client,
        risk_governor=RiskGovernor(mode=RiskMode.LOW, settings=settings),
        settings=settings,
    )

    engine.execute_intent(build_intent(), build_snapshot())
    assert client.submitted is False
