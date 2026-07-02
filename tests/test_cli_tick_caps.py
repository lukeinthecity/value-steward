"""Integration coverage for capped execution through the CLI tick path."""

from __future__ import annotations

from datetime import datetime, timezone

from click.testing import CliRunner

from valuesteward.cli import main
from valuesteward.config import ValueStewardSettings
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode


class FakePortfolioRepository:
    def __init__(self, alpaca_client=None):
        self.alpaca_client = alpaca_client

    def get_current_snapshot(self) -> PortfolioSnapshot:
        return PortfolioSnapshot(
            timestamp=datetime.now(timezone.utc),
            cash=100_000.0,
            equity=100_000.0,
            positions=[],
            risk_exposure_pct=0.0,
        )


class FakeDecisionEngine:
    def __init__(self, **kwargs):
        pass

    def decide(self, snapshot, world_tags, world_context=None):
        return (
            IntentRecord(
                mode=RiskMode.LOW,
                action_type="BUY",
                symbol="SPY",
                size_pct=0.16,
                pre_risk_exposure_pct=0.0,
                post_risk_exposure_pct=0.0,
                target_risk_exposure_pct=0.24,
                rebalance_buffer_pct=0.02,
                explanation="test buy",
            ),
            None,
        )


class FakeIntentLogger:
    def __init__(self, memory=None):
        self.memory = memory

    def log_intent(self, intent):
        return None


class FakeMemoryEngine:
    def get_all_intents(self):
        return []


class FakeNotificationService:
    def notify_action(self, intent):
        return None

    def notify_info(self, message):
        return None


def test_cli_tick_clamps_large_buy_to_configured_cap(tmp_path, monkeypatch) -> None:
    submitted = []
    state_path = tmp_path / "state.json"
    state_lock_path = tmp_path / "state.json.lock"

    class FakeAlpacaClient:
        def __init__(self, settings=None):
            self.settings = settings

        def get_open_orders(self):
            return []

        def cancel_open_orders(self, symbol):
            return 0

        def submit_steward_order(self, symbol, side, notional, client_order_id=None):
            submitted.append((symbol, side, notional))
            return 100.0

    monkeypatch.setattr("valuesteward.steward_state.STATE_PATH", state_path)
    monkeypatch.setattr("valuesteward.steward_state.STATE_LOCK_PATH", state_lock_path)
    monkeypatch.setattr(
        "valuesteward.cli.verify_runtime_expectations",
        lambda: {"git_head": "test", "git_dirty": False, "files": {}},
    )
    monkeypatch.setattr("valuesteward.cli.AlpacaClient", FakeAlpacaClient)
    monkeypatch.setattr("valuesteward.cli.PortfolioRepository", FakePortfolioRepository)
    monkeypatch.setattr("valuesteward.cli.DecisionEngine", FakeDecisionEngine)
    monkeypatch.setattr("valuesteward.cli.IntentLogger", FakeIntentLogger)
    monkeypatch.setattr("valuesteward.cli.MemoryEngine", FakeMemoryEngine)
    monkeypatch.setattr("valuesteward.cli.NotificationService", FakeNotificationService)
    monkeypatch.setattr("valuesteward.cli.load_policy", lambda: ({}, []))
    monkeypatch.setattr("valuesteward.cli.load_latest_world_context", lambda: None)
    monkeypatch.setattr(
        "valuesteward.core.execution_engine.ExecutionEngine.is_in_execution_window",
        lambda self: True,
    )
    monkeypatch.setattr(
        "valuesteward.cli.get_settings",
        lambda: ValueStewardSettings(
            alpaca_api_key_id="test-key",
            alpaca_secret_key="test-secret",
            shadow_mode=False,
            execution_armed=True,
            max_effective_capital_dollars=20.0,
            max_trade_notional_dollars=5.0,
            min_trade_notional_dollars=1.0,
        ),
    )

    result = CliRunner().invoke(main, ["tick"])

    assert result.exit_code == 0
    assert submitted == [("SPY", "buy", 5.0)]
