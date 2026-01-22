"""Tests for intent enrichment fields."""

from datetime import datetime

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import PortfolioSnapshot, RiskMode


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def test_decision_engine_enriches_intent_fields() -> None:
    settings = ValueStewardSettings(
        alpaca_api_key_id="test-key",
        alpaca_secret_key="test-secret",
        core_symbol="SPY",
        target_risk_exposure_pct_low=0.20,
        rebalance_buffer_pct=0.02,
    )
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
    )
    snapshot = PortfolioSnapshot(
        timestamp=datetime.utcnow(),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )

    intent = engine.decide(snapshot, world_tags=["DEFAULT"])
    assert intent.core_symbol == "SPY"
    assert intent.target_exposure_pct == settings.target_risk_exposure_pct_low
    assert intent.buffer_pct == settings.rebalance_buffer_pct
    assert intent.reason_code == "UNDER_TARGET_BUY"
