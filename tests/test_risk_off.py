"""Tests for risk-off signaling."""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import PortfolioSnapshot, RiskMode


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def test_risk_off_flag_set_on_stressed_macro() -> None:
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
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    world_context = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "macro_view": {"macro_label": "stressed", "macro_score": 0.7},
    }

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"], world_context=world_context)
    assert intent.risk_off is True
    assert intent.risk_off_reason is not None
