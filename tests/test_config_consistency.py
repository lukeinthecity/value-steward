"""Tests for config-driven intent enrichment consistency."""

from datetime import datetime

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.reporting import build_report
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import PortfolioSnapshot, RiskMode


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def test_config_values_propagate_to_intent_and_report() -> None:
    settings = ValueStewardSettings(
        alpaca_api_key_id="test-key",
        alpaca_secret_key="test-secret",
        target_risk_exposure_pct_low=0.15,
        rebalance_buffer_pct=0.01,
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
    assert intent.target_exposure_pct == 0.15
    assert intent.buffer_pct == 0.01

    report = build_report([intent])
    assert report["target_exposure_pct"] == 0.15
    assert report["buffer_pct"] == 0.01
