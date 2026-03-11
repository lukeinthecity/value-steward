"""Smoke tests for Value Steward core wiring."""

from datetime import datetime, timezone

from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.risk_modes import get_risk_mode_config
from valuesteward.models import PortfolioSnapshot, RiskMode


def test_risk_governor_allows_small_trade() -> None:
    _ = get_risk_mode_config(RiskMode.LOW)

    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=10000.0,
        equity=12000.0,
        positions=[],
        risk_exposure_pct=0.1,
    )
    governor = RiskGovernor(mode=RiskMode.LOW)

    assert governor.check_trade_allowed(snapshot, intended_position_pct=0.05) is True
    assert governor.check_trade_allowed(snapshot, intended_position_pct=0.5) is False
