"""Tests for the epsilon-greedy exploration on the score gate."""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine, EXPLORATION_TAG
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.signal_engine import SymbolSignal
from valuesteward.models import PortfolioSnapshot


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def _build_engine() -> DecisionEngine:
    settings = ValueStewardSettings(
        alpaca_api_key_id="test-key",  # nosec B106
        alpaca_secret_key="test-secret",  # nosec B106
        core_symbol="SPY",
        target_risk_exposure_pct_low=0.20,
        rebalance_buffer_pct=0.02,
    )
    governor = RiskGovernor(settings=settings)
    return DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
    )


def _build_signal(score: float, symbol: str = "XYZ") -> SymbolSignal:
    return SymbolSignal(
        symbol=symbol,
        score=score,
        momentum_rank=0.9,
        vol_rank=0.9,
        drawdown_rank=1.0,
        volatility=0.02,
        last_close=50.0,
        day_return=0.005,
        trend_strength=0.04,
        mom_5d=0.005,
        mom_20d=0.01,
        mom_60d=0.05,
        rel_strength_20d=0.02,
        rel_strength_60d=0.05,
        momentum_raw=0.03,
        drawdown=0.01,
        bars=100,
    )


def _empty_snapshot() -> PortfolioSnapshot:
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100.0,
        equity=100.0,
        positions=[],
        risk_exposure_pct=0.0,
    )


def test_exploration_disabled_by_default_blocks_low_score(monkeypatch) -> None:
    """With epsilon=0 (default), a sub-threshold score is always blocked."""
    monkeypatch.delenv("VS_NEW_ENTRY_EXPLORATION_EPSILON", raising=False)
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    engine = _build_engine()
    signal = _build_signal(score=1.48)  # within 1.5% of 1.50

    allowed, reason, size_mult = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )

    assert allowed is False
    assert "entry_quality score" in reason
    assert size_mult == 1.0


def test_exploration_with_epsilon_1_always_allows_in_zone(monkeypatch) -> None:
    """epsilon=1.0 means every in-zone candidate is taken as exploration."""
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_EPSILON", "1.0")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_ZONE_PCT", "0.05")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_SIZE_MULT", "0.5")
    engine = _build_engine()
    # 1.48 is within 5% of 1.50 (zone is [1.425, 1.50))
    signal = _build_signal(score=1.48)

    allowed, reason, size_mult = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )

    assert allowed is True
    assert reason is not None and reason.startswith(EXPLORATION_TAG)
    assert size_mult == 0.5


def test_exploration_does_not_apply_outside_zone(monkeypatch) -> None:
    """Scores far below threshold should never be explored, regardless of epsilon."""
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_EPSILON", "1.0")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_ZONE_PCT", "0.05")
    engine = _build_engine()
    # 1.30 is below the zone floor (1.425)
    signal = _build_signal(score=1.30)

    allowed, reason, size_mult = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )

    assert allowed is False
    assert "entry_quality score" in reason


def test_exploration_seed_is_deterministic(monkeypatch) -> None:
    """The same seed should produce the same exploration decisions."""
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_EPSILON", "0.5")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_ZONE_PCT", "0.05")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_SEED", "42")

    decisions: list[tuple[int, bool]] = []
    for trial in range(20):
        engine = _build_engine()
        signal = _build_signal(score=1.48)
        allowed, _, _ = engine._allow_buy(
            world_context={"macro_view": {"macro_label": "calm"}},
            signal=signal,
            snapshot=_empty_snapshot(),
        )
        decisions.append((trial, allowed))

    # With seed=42 and a fresh engine each time, all trials should produce
    # the same first-draw decision.
    first_decision = decisions[0][1]
    assert all(d == first_decision for _, d in decisions)


def test_exploration_above_threshold_uses_normal_path(monkeypatch) -> None:
    """Scores at or above threshold should always be allowed without exploration tag."""
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    monkeypatch.setenv("VS_NEW_ENTRY_EXPLORATION_EPSILON", "1.0")
    engine = _build_engine()
    signal = _build_signal(score=1.60)  # Above threshold

    allowed, reason, size_mult = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )

    assert allowed is True
    # Not flagged as exploration since it's a normal pass.
    assert reason is None or not reason.startswith(EXPLORATION_TAG)
    assert size_mult == 1.0
