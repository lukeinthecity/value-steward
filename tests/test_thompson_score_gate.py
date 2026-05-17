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


# ----- Regression tests for the audit-driven fixes -----


def test_thompson_does_not_bypass_rel20_safety_gate(monkeypatch) -> None:
    """REGRESSION: Thompson approval must not bypass rel20/rel60/trend.

    Earlier implementation returned True immediately on a Thompson pass,
    skipping the relative-strength safety gates. The fix re-routes Thompson
    through the same downstream checks so a Beta-favored symbol with
    negative relative strength is still blocked.
    """
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.01")  # always pass
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_REL_STRENGTH_20D", "0.0")
    # Strong posterior, will always pass Thompson:
    policy = {"score_gate_posteriors": {"XYZ": {"alpha": 30, "beta": 1}}}
    engine = _build_engine(policy=policy)

    # Signal with NEGATIVE rel_strength_20d — rel20 gate should still block.
    signal = SymbolSignal(
        symbol="XYZ",
        score=1.80,
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
        rel_strength_20d=-0.05,  # FAILS rel20 gate
        rel_strength_60d=0.05,
        momentum_raw=0.03,
        drawdown=0.01,
        bars=100,
    )

    allowed, reason, _ = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    assert allowed is False
    assert "rel20" in (reason or "")


def test_thompson_passes_with_thompson_tag_after_all_safety_gates(monkeypatch) -> None:
    """When Thompson approves AND all rel/trend gates also pass, the BUY note
    starts with the THOMPSON_TAG prefix so downstream tags reason_code=BUY_THOMPSON."""
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_THRESHOLD", "0.01")  # always pass
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_REL_STRENGTH_20D", "0.0")
    policy = {"score_gate_posteriors": {"XYZ": {"alpha": 30, "beta": 1}}}
    engine = _build_engine(policy=policy)
    signal = _build_signal(score=1.20)  # all defaults pass rel20/rel60/trend
    allowed, reason, _ = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    assert allowed is True
    assert reason.startswith(THOMPSON_TAG)


def test_lookup_posterior_is_case_insensitive(monkeypatch) -> None:
    """REGRESSION: posteriors stored uppercased; lookup must normalize."""
    policy = {
        "score_gate_posteriors": {"AAPL": {"alpha": 10, "beta": 2, "sample_count": 12}}
    }
    engine = _build_engine(policy=policy)
    # Lower-case lookup must still hit the AAPL posterior.
    alpha, beta, n = engine._lookup_posterior("aapl")
    assert alpha == 10.0
    assert beta == 2.0
    assert n == 12

    # Whitespace tolerated.
    alpha2, beta2, _ = engine._lookup_posterior("  AAPL  ")
    assert alpha2 == 10.0
    assert beta2 == 2.0


def test_lookup_posterior_handles_none_and_empty_symbol() -> None:
    """Defensive: None or empty symbol returns (0, 0, 0) without crashing."""
    engine = _build_engine(policy={"score_gate_posteriors": {"AAPL": {"alpha": 5}}})
    assert engine._lookup_posterior(None) == (0.0, 0.0, 0)
    assert engine._lookup_posterior("") == (0.0, 0.0, 0)
    assert engine._lookup_posterior("   ") == (0.0, 0.0, 0)


def test_lookup_posterior_rejects_nonfinite_and_caps_runaway_counts() -> None:
    """REGRESSION: a corrupted policy.json with Infinity / huge counts must
    not blow up betavariate. _lookup_posterior caps values defensively."""
    engine = _build_engine(
        policy={
            "score_gate_posteriors": {
                "INF": {"alpha": float("inf"), "beta": 5},
                "HUGE": {"alpha": 5_000_000, "beta": 5},
            }
        }
    )
    # Non-finite → reset to zeros.
    assert engine._lookup_posterior("INF") == (0.0, 0.0, 0)
    # Huge value → capped.
    alpha, _, _ = engine._lookup_posterior("HUGE")
    assert alpha == DecisionEngine._POSTERIOR_COUNT_CAP


def test_thompson_with_zero_prior_does_not_crash(monkeypatch) -> None:
    """REGRESSION: prior_alpha=0 used to make betavariate raise ValueError.
    The fix floors effective alpha/beta at 0.5."""
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_ENABLED", "1")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_PRIOR_ALPHA", "0.0")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_PRIOR_BETA", "0.0")
    monkeypatch.setenv("VS_SCORE_GATE_THOMPSON_SEED", "42")
    engine = _build_engine()
    signal = _build_signal(score=1.20)
    # Should NOT raise.
    allowed, reason, _ = engine._allow_buy(
        world_context={"macro_view": {"macro_label": "calm"}},
        signal=signal,
        snapshot=_empty_snapshot(),
    )
    # Either decision is acceptable here; the assertion is "no crash".
    assert isinstance(allowed, bool)
    assert reason is None or isinstance(reason, str)
