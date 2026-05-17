"""Tests for the Thompson-sampling score gate in DecisionEngine._allow_buy."""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine, THOMPSON_TAG
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.signal_engine import SymbolSignal
from valuesteward.models import PortfolioSnapshot


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def _build_engine(policy=None) -> DecisionEngine:
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
        policy=policy,
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


def test_thompson_disabled_uses_score_gate(monkeypatch) -> None:
    """When VS_SCORE_GATE_THOMPSON_ENABLED is unset/false, score gate runs as before."""
    monkeypatch.delenv("VS_SCORE_GATE_THOMPSON_ENABLED", raising=False)
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    engine = _build_engine()
    signal = _build_signal(score=1.40)
    allowed, reason, _ = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    assert allowed is False
    assert "entry_quality" in reason
    assert THOMPSON_TAG not in (reason or "")


def test_thompson_enabled_blocks_known_loser(monkeypatch) -> None:
    """A symbol with mostly losses (large beta) should rarely pass Thompson."""
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.55")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    # Even with a HIGH signal score, the bad posterior should dominate.
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    policy = {
        "score_gate_posteriors": {
            "XYZ": {"alpha": 1, "beta": 30, "sample_count": 31}
        }
    }
    engine = _build_engine(policy=policy)
    signal = _build_signal(score=1.80)

    blocked_count = 0
    for _ in range(20):
        # Reset rng each iteration to keep test deterministic per call
        engine._thompson_rng = None
        allowed, _, _ = engine._allow_buy(
            world_context={"macro_view": {"macro_label": "calm"}},
            signal=signal,
            snapshot=_empty_snapshot(),
        )
        if not allowed:
            blocked_count += 1
    # With alpha=1, beta=30, Beta sample is centered around 0.03 — virtually always blocked.
    assert blocked_count >= 18


def test_thompson_enabled_allows_known_winner(monkeypatch) -> None:
    """A symbol with mostly wins (large alpha) should almost always pass Thompson."""
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.55")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    # LOW signal score — would normally fail the score gate. Thompson lets it through.
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.80")
    policy = {
        "score_gate_posteriors": {
            "XYZ": {"alpha": 30, "beta": 1, "sample_count": 31}
        }
    }
    engine = _build_engine(policy=policy)
    signal = _build_signal(score=1.20)

    allowed_count = 0
    for _ in range(20):
        engine._thompson_rng = None
        allowed, reason, _ = engine._allow_buy(
            world_context={"macro_view": {"macro_label": "calm"}},
            signal=signal,
            snapshot=_empty_snapshot(),
        )
        if allowed:
            allowed_count += 1
            assert reason.startswith(THOMPSON_TAG)
    # Beta(32, 3) centered around 0.91 — virtually always passes 0.55.
    assert allowed_count >= 18


def test_thompson_uses_prior_for_unknown_symbol(monkeypatch) -> None:
    """A symbol with no posterior gets the default Beta(2, 2) prior → near-uniform."""
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.55")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    engine = _build_engine(policy={})  # no posteriors
    signal = _build_signal(score=1.20)

    decisions = []
    for _ in range(50):
        engine._thompson_rng = None
        allowed, _, _ = engine._allow_buy(
            world_context={"macro_view": {"macro_label": "calm"}},
            signal=signal,
            snapshot=_empty_snapshot(),
        )
        decisions.append(allowed)

    # With seeded RNG, all iterations should produce the same decision since
    # we reset the RNG to the same seed each loop.
    assert all(d == decisions[0] for d in decisions)


def test_thompson_seed_makes_results_reproducible(monkeypatch) -> None:
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.55")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "123")

    engine1 = _build_engine()
    engine2 = _build_engine()
    signal = _build_signal(score=1.0)

    a1, _, _ = engine1._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    a2, _, _ = engine2._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    assert a1 == a2


def test_thompson_reason_tag_marks_buy_thompson(monkeypatch) -> None:
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.01")  # very low → always pass
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    engine = _build_engine()
    signal = _build_signal(score=1.20)
    allowed, reason, _ = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    assert allowed is True
    assert reason.startswith(THOMPSON_TAG)
