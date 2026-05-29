"""Tests for cap-aware SELL gate in DecisionEngine."""

from datetime import datetime, timezone

import pytest

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import PortfolioSnapshot, Position, RiskMode


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def _engine() -> DecisionEngine:
    settings = ValueStewardSettings(
        alpaca_api_key_id="x",  # nosec B106
        alpaca_secret_key="y",  # nosec B106
        core_symbol="SPY",
        target_risk_exposure_pct_low=0.20,
        rebalance_buffer_pct=0.02,
        max_effective_capital_dollars=20.0,
        min_trade_notional_dollars=1.0,
    )
    governor = RiskGovernor(settings=settings)
    return DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
    )


def _snapshot(positions, equity=100_000.0) -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=equity - sum(float(p.market_value) for p in positions),
        equity=equity,
        positions=positions,
        risk_exposure_pct=(
            sum(float(p.market_value) for p in positions) / equity
        ),
    )


def _pos(symbol: str, mv: float) -> Position:
    return Position(
        symbol=symbol, quantity=1.0, market_value=mv, asset_class="us_equity"
    )


def test_cap_breach_sell_inactive_when_within_cap(monkeypatch) -> None:
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    engine = _engine()
    # Deployed $19.50 — well within $20 cap.
    snapshot = _snapshot([_pos("MET", 12.0), _pos("OEF", 7.5)])
    assert engine._check_cap_breach_sell(snapshot, RiskMode.LOW) is None


def test_cap_breach_sell_inactive_within_trigger_tolerance(monkeypatch) -> None:
    """Tiny overshoot below the trigger tolerance should NOT fire."""
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TRIGGER", "0.05")
    engine = _engine()
    # Deployed $20.04 — within the 5¢ trigger tolerance.
    snapshot = _snapshot([_pos("MET", 12.04), _pos("OEF", 8.00)])
    assert engine._check_cap_breach_sell(snapshot, RiskMode.LOW) is None


def test_cap_breach_sell_fires_above_trigger(monkeypatch) -> None:
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TRIGGER", "0.05")
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TARGET_BUFFER", "1.00")
    engine = _engine()
    # Deployed $20.20 — over the 5¢ trigger.
    snapshot = _snapshot(
        [_pos("MET", 12.00), _pos("OEF", 8.20)], equity=100_000.0
    )
    intent = engine._check_cap_breach_sell(snapshot, RiskMode.LOW)
    assert intent is not None
    assert intent.action_type == "SELL"
    # Smallest position is OEF (no wait — OEF is 8.20, MET is 12.00 — OEF smaller)
    # Wait, actually the snapshot has MET=12.00 and OEF=8.20, smallest is OEF.
    assert intent.symbol == "OEF"
    assert intent.reason_code == "CAP_BREACH_SELL"
    # We should sell enough to land at cap - target_buffer = $19.00, so sell
    # at least $1.20 (deployed $20.20 - target $19.00 = $1.20).
    sell_dollars = intent.size_pct * 100_000.0
    assert sell_dollars >= 1.20 - 1e-6
    # But not more than the position's market value.
    assert sell_dollars <= 8.20 + 1e-6


def test_cap_breach_sell_partial_sell_caps_at_position_size(monkeypatch) -> None:
    """If the required sell exceeds the smallest position's MV, we cap at
    fully exiting it (and stop — partial cap breach is acceptable)."""
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TRIGGER", "0.05")
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TARGET_BUFFER", "5.00")
    engine = _engine()
    # Deployed $20.50 — over trigger. Target deployed = $15. Need to shed
    # $5.50. Smallest position (OEF) is only $4.50 — we exit it entirely.
    snapshot = _snapshot([_pos("MET", 16.00), _pos("OEF", 4.50)])
    intent = engine._check_cap_breach_sell(snapshot, RiskMode.LOW)
    assert intent is not None
    assert intent.symbol == "OEF"
    sell_dollars = intent.size_pct * 100_000.0
    assert sell_dollars == pytest.approx(4.50, rel=1e-3)


def test_cap_breach_sell_skips_when_position_below_min_trade(monkeypatch) -> None:
    """Don't fire if the smallest position is below the min trade notional."""
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TRIGGER", "0.05")
    engine = _engine()
    # Smallest position is $0.50 — below the $1 min trade.
    snapshot = _snapshot([_pos("MET", 19.80), _pos("DUST", 0.50)])
    intent = engine._check_cap_breach_sell(snapshot, RiskMode.LOW)
    assert intent is None


def test_cap_breach_sell_floors_at_min_trade_not_full_exit(monkeypatch) -> None:
    """REGRESSION (debug scan): when amount_to_sell < min_trade, sell
    min_trade — not the entire position. The old behavior over-exited."""
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TRIGGER", "0.05")
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TARGET_BUFFER", "0.00")
    engine = _engine()
    # 50¢ over cap, target buffer 0 → amount_to_sell = $0.50, below $1 min.
    # OEF is $5, MET is $15.50. Smallest is OEF. Should sell $1 (not exit
    # all of OEF for $5).
    snapshot = _snapshot([_pos("MET", 15.50), _pos("OEF", 5.00)])
    intent = engine._check_cap_breach_sell(snapshot, RiskMode.LOW)
    assert intent is not None
    sell_dollars = intent.size_pct * 100_000.0
    # Should be exactly min_trade = $1, not $5 (the position size).
    assert sell_dollars == pytest.approx(1.00, abs=1e-6)
    assert intent.symbol == "OEF"


def test_cap_breach_sell_disabled_by_env(monkeypatch) -> None:
    monkeypatch.setenv("VS_CAP_BREACH_SELL_ENABLED", "false")
    engine = _engine()
    # Even with deployed >> cap, returns None when disabled.
    snapshot = _snapshot([_pos("MET", 25.00), _pos("OEF", 5.00)])
    assert engine._check_cap_breach_sell(snapshot, RiskMode.LOW) is None


def test_cap_breach_sell_empty_portfolio_returns_none() -> None:
    engine = _engine()
    snapshot = _snapshot([], equity=100_000.0)
    assert engine._check_cap_breach_sell(snapshot, RiskMode.LOW) is None


def test_cap_breach_sell_chooses_smallest_position_among_three(monkeypatch) -> None:
    monkeypatch.delenv("VS_CAP_BREACH_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_CAP_BREACH_SELL_TRIGGER", "0.05")
    engine = _engine()
    snapshot = _snapshot([
        _pos("A", 10.00),
        _pos("B", 7.00),
        _pos("C", 4.00),  # smallest
    ])
    intent = engine._check_cap_breach_sell(snapshot, RiskMode.LOW)
    assert intent is not None
    assert intent.symbol == "C"
