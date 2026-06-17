"""Tests for buy-coupled rotation SELL in DecisionEngine.

Appreciation over the cap must NOT trigger a sell (winners run). The only
sell-to-make-room path is rotation: when a NEW candidate clears every entry
gate but is blocked solely by cap headroom AND is clearly stronger than the
weakest holding, exit that weakest holding.
"""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.signal_engine import SignalResult, SymbolSignal
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


def _sig(symbol: str, score: float) -> SymbolSignal:
    return SymbolSignal(
        symbol=symbol,
        last_close=10.0,
        day_return=0.0,
        trend_strength=0.0,
        mom_5d=0.0,
        mom_20d=0.0,
        mom_60d=0.0,
        rel_strength_20d=0.0,
        rel_strength_60d=0.0,
        momentum_raw=0.0,
        momentum_rank=0.5,
        vol_rank=0.5,
        drawdown_rank=0.5,
        volatility=0.02,
        drawdown=0.0,
        score=score,
        bars=100,
    )


def _result(*sigs: SymbolSignal) -> SignalResult:
    by = {s.symbol: s for s in sigs}
    return SignalResult(
        universe_size=len(sigs),
        evaluated=len(sigs),
        skipped=0,
        signals=list(sigs),
        by_symbol=by,
        correlations={},
    )


def _pos(symbol: str, mv: float) -> Position:
    return Position(
        symbol=symbol, quantity=1.0, market_value=mv, asset_class="us_equity"
    )


def _snapshot(positions, equity=100_000.0) -> PortfolioSnapshot:
    deployed = sum(float(p.market_value) for p in positions)
    return PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=equity - deployed,
        equity=equity,
        positions=positions,
        risk_exposure_pct=deployed / equity if equity else 0.0,
    )


def test_rotation_none_when_no_positions() -> None:
    engine = _engine()
    candidate = _sig("XYZ", 1.80)
    out = engine._build_rotation_sell(
        _snapshot([]), _result(candidate), candidate, RiskMode.LOW
    )
    assert out is None


def test_rotation_disabled_by_env(monkeypatch) -> None:
    monkeypatch.setenv("VS_ROTATION_SELL_ENABLED", "false")
    engine = _engine()
    candidate = _sig("XYZ", 1.80)
    snap = _snapshot([_pos("AFBI", 12.0), _pos("PWV", 8.0)])
    result = _result(candidate, _sig("AFBI", 1.40), _sig("PWV", 1.30))
    assert engine._build_rotation_sell(snap, result, candidate, RiskMode.LOW) is None


def test_rotation_skips_when_candidate_not_better(monkeypatch) -> None:
    """Winner runs: a candidate no stronger than the weakest holding (within
    margin) must NOT cause a sell."""
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_ROTATION_MIN_SCORE_MARGIN", "0.05")
    engine = _engine()
    candidate = _sig("XYZ", 1.52)  # only +0.02 over weakest PWV (1.50)
    snap = _snapshot([_pos("AFBI", 12.0), _pos("PWV", 8.0)])
    result = _result(candidate, _sig("AFBI", 1.70), _sig("PWV", 1.50))
    assert engine._build_rotation_sell(snap, result, candidate, RiskMode.LOW) is None


def test_rotation_fires_for_clearly_stronger_candidate(monkeypatch) -> None:
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_ROTATION_MIN_SCORE_MARGIN", "0.05")
    engine = _engine()
    candidate = _sig("XYZ", 1.80)
    snap = _snapshot([_pos("AFBI", 12.0), _pos("PWV", 8.0)])
    # PWV is the weaker holding (1.30 < 1.70).
    result = _result(candidate, _sig("AFBI", 1.70), _sig("PWV", 1.30))
    out = engine._build_rotation_sell(
        snap, result, candidate, RiskMode.LOW, target=0.20, buffer=0.02
    )
    assert out is not None
    assert out.action_type == "SELL"
    assert out.symbol == "PWV"
    assert out.reason_code == "ROTATION_SELL"
    # Full exit of the weakest position.
    sell_dollars = out.size_pct * 100_000.0
    assert abs(sell_dollars - 8.0) < 1e-6
    # REGRESSION (2026-06-16 crash): every intent must carry the
    # target/buffer enrichment fields or the cli.py tick guard raises and
    # the whole tick crashes. Sell-side intents omitted them.
    assert out.target_risk_exposure_pct is not None
    assert out.rebalance_buffer_pct is not None


def test_rotation_picks_weakest_by_score_not_market_value(monkeypatch) -> None:
    """The weakest holding is chosen by SIGNAL SCORE, not market value — a
    large but low-conviction position should be the one rotated out."""
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_ROTATION_MIN_SCORE_MARGIN", "0.05")
    engine = _engine()
    candidate = _sig("XYZ", 1.90)
    # BIG is large ($15) but low score; SMALL is small ($4) but high score.
    snap = _snapshot([_pos("BIG", 15.0), _pos("SMALL", 4.0)])
    result = _result(candidate, _sig("BIG", 1.20), _sig("SMALL", 1.75))
    out = engine._build_rotation_sell(snap, result, candidate, RiskMode.LOW)
    assert out is not None
    assert out.symbol == "BIG"  # weakest by score, despite largest MV


def test_rotation_treats_unscored_holding_as_weakest(monkeypatch) -> None:
    """A holding with no live signal has no conviction => rotated out first."""
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_ROTATION_MIN_SCORE_MARGIN", "0.05")
    engine = _engine()
    candidate = _sig("XYZ", 1.60)
    snap = _snapshot([_pos("SCORED", 8.0), _pos("STALE", 9.0)])
    # STALE has no entry in by_symbol -> treated as -inf score.
    result = _result(candidate, _sig("SCORED", 1.55))
    out = engine._build_rotation_sell(snap, result, candidate, RiskMode.LOW)
    assert out is not None
    assert out.symbol == "STALE"


def test_rotation_skips_when_weakest_below_min_trade(monkeypatch) -> None:
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    engine = _engine()
    candidate = _sig("XYZ", 1.90)
    # Weakest by score is DUST at $0.50, below the $1 min trade.
    snap = _snapshot([_pos("AFBI", 12.0), _pos("DUST", 0.50)])
    result = _result(candidate, _sig("AFBI", 1.70), _sig("DUST", 1.10))
    assert engine._build_rotation_sell(snap, result, candidate, RiskMode.LOW) is None


def _rich_sig(symbol: str, score: float) -> SymbolSignal:
    """A signal that clears the entry gates (positive rel/trend)."""
    s = _sig(symbol, score)
    s.rel_strength_20d = 0.05
    s.rel_strength_60d = 0.10
    s.trend_strength = 0.05
    s.mom_5d = 0.01
    s.mom_20d = 0.02
    s.mom_60d = 0.10
    return s


class _StubSignalEngine:
    def __init__(self, result):
        self._result = result

    def build_signals(self):
        return self._result


def test_decide_at_cap_emits_enriched_rotation_sell(monkeypatch) -> None:
    """REGRESSION (2026-06-16 tick crash): a full decide() that rotates at the
    cap must return a SELL carrying target/buffer enrichment, or the cli.py
    tick guard raises 'Intent missing target/buffer enrichment fields'."""
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", "1.50")
    monkeypatch.setenv("VS_ROTATION_MIN_SCORE_MARGIN", "0.05")

    candidate = _rich_sig("XYZ", 1.80)
    held_a = _sig("AFBI", 1.30)
    held_b = _sig("PWV", 1.20)
    result = _result(candidate, held_a, held_b)

    settings = ValueStewardSettings(
        alpaca_api_key_id="x",  # nosec B106
        alpaca_secret_key="y",  # nosec B106
        core_symbol="SPY",
        target_risk_exposure_pct_low=0.20,
        rebalance_buffer_pct=0.02,
        max_effective_capital_dollars=20.0,
        min_trade_notional_dollars=1.0,
    )
    engine = DecisionEngine(
        risk_governor=RiskGovernor(settings=settings),
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=_StubSignalEngine(result),
    )
    # At cap: AFBI $12 + PWV $8 = $20 deployed, no headroom.
    snap = _snapshot([_pos("AFBI", 12.0), _pos("PWV", 8.0)])

    intent, _ = engine.decide(
        snap, world_tags=["DEFAULT"], world_context={"macro_view": {"macro_label": "calm"}}
    )

    assert intent.action_type == "SELL"
    assert intent.reason_code == "ROTATION_SELL"
    assert intent.symbol == "PWV"  # weakest held by score
    # The fields whose absence crashed the tick:
    assert intent.target_risk_exposure_pct is not None
    assert intent.rebalance_buffer_pct is not None


def test_rotation_margin_zero_allows_any_improvement(monkeypatch) -> None:
    monkeypatch.delenv("VS_ROTATION_SELL_ENABLED", raising=False)
    monkeypatch.setenv("VS_ROTATION_MIN_SCORE_MARGIN", "0.0")
    engine = _engine()
    candidate = _sig("XYZ", 1.51)  # barely over weakest 1.50
    snap = _snapshot([_pos("AFBI", 12.0), _pos("PWV", 8.0)])
    result = _result(candidate, _sig("AFBI", 1.70), _sig("PWV", 1.50))
    out = engine._build_rotation_sell(snap, result, candidate, RiskMode.LOW)
    assert out is not None
    assert out.symbol == "PWV"
