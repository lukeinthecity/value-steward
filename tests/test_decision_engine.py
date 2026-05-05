"""Tests for LOW-mode decision engine behavior."""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import PortfolioSnapshot, Position, RiskMode


class DummyPortfolioRepository:
    """Minimal repository stub for decision engine tests."""

    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


def build_settings() -> ValueStewardSettings:
    return ValueStewardSettings(
        alpaca_api_key_id="test-key",
        alpaca_secret_key="test-secret",
        core_symbol="SPY",
        target_risk_exposure_pct_low=0.20,
        rebalance_buffer_pct=0.02,
    )


class DummySignalEngine:
    def build_signals(self):
        from valuesteward.core.signal_engine import SignalResult, SymbolSignal
        sig = SymbolSignal(
            symbol="SPY", 
            score=1.6, 
            momentum_rank=1, 
            vol_rank=1, 
            drawdown_rank=1, 
            volatility=0.0, 
            last_close=100.0, 
            day_return=0.01,
            trend_strength=1.0,
            mom_5d=0.01,
            mom_20d=0.02,
            mom_60d=0.05,
            rel_strength_20d=0.01,
            rel_strength_60d=0.02,
            momentum_raw=0.05,
            drawdown=0.0,
            bars=100
        )
        return SignalResult(
            universe_size=1, evaluated=1, skipped=0,
            signals=[sig], by_symbol={"SPY": sig}, correlations={}
        )

def test_low_mode_buy_intent_when_under_target() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySignalEngine(),
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])
    assert intent.action_type == "BUY"
    assert intent.symbol == "SPY"
    assert intent.size_pct is not None
    assert 0.0 < intent.size_pct <= governor.config.max_position_pct


def test_low_mode_no_action_within_buffer() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=80_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.20,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=None,
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])
    assert intent.action_type == "NO_ACTION"


def test_watchful_regime_does_not_block_buy_when_signal_is_positive() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySignalEngine(),
    )
    world_context = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "macro_view": {"macro_label": "calm", "macro_score": 0.15},
        "final_regime": {
            "final_label": "watchful",
            "final_score": 0.68,
            "divergence": True,
            "fusion_reason": "probabilistic_more_cautious",
        },
    }

    intent, _ = engine.decide(
        snapshot, world_tags=["DEFAULT"], world_context=world_context
    )

    assert intent.action_type == "BUY"
    assert intent.symbol == "SPY"
    assert intent.target_risk_exposure_pct is not None
    assert intent.target_risk_exposure_pct < settings.target_risk_exposure_pct_low


def test_fused_stressed_regime_shapes_target_and_buffer_even_if_macro_view_is_calm() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySymbolSignalEngine("XLE", score=1.6),
    )
    world_context = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "macro_view": {"macro_label": "calm", "macro_score": 0.12},
        "final_regime": {
            "final_label": "stressed",
            "final_score": 0.82,
            "divergence": True,
            "fusion_reason": "probabilistic_more_cautious",
        },
    }

    intent, _ = engine.decide(
        snapshot, world_tags=["DEFAULT"], world_context=world_context
    )

    assert intent.action_type == "BUY"
    assert intent.target_risk_exposure_pct is not None
    assert intent.rebalance_buffer_pct is not None
    assert intent.target_risk_exposure_pct < settings.target_risk_exposure_pct_low
    assert intent.rebalance_buffer_pct > settings.rebalance_buffer_pct


class DummySameSymbolCorrelatedSignalEngine:
    def build_signals(self):
        from valuesteward.core.signal_engine import SignalResult, SymbolSignal

        sig = SymbolSignal(
            symbol="SPY",
            score=0.1,
            momentum_rank=1,
            vol_rank=1,
            drawdown_rank=1,
            volatility=0.01,
            last_close=100.0,
            day_return=0.01,
            trend_strength=1.0,
            mom_5d=0.01,
            mom_20d=0.02,
            mom_60d=0.05,
            rel_strength_20d=0.01,
            rel_strength_60d=0.02,
            momentum_raw=0.05,
            drawdown=0.0,
            bars=100,
        )
        return SignalResult(
            universe_size=1,
            evaluated=1,
            skipped=0,
            signals=[sig],
            by_symbol={"SPY": sig},
            correlations={"SPY": {"SPY": 1.0}},
        )


def test_same_symbol_candidate_is_not_blocked_as_correlated_redundancy() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=99_995.0,
        equity=100_000.0,
        positions=[
            Position(
                symbol="SPY",
                quantity=0.05,
                market_value=5.0,
                asset_class="us_equity",
            )
        ],
        risk_exposure_pct=0.05,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySameSymbolCorrelatedSignalEngine(),
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])

    assert intent.action_type == "BUY"
    assert intent.reason_code == "UNDER_TARGET_BUY"


class DummySymbolSignalEngine:
    def __init__(
        self,
        symbol: str,
        score: float = 1.6,
        rel_strength_20d: float = 0.01,
        rel_strength_60d: float = 0.02,
        trend_strength: float = 1.0,
    ) -> None:
        self.symbol = symbol
        self.score = score
        self.rel_strength_20d = rel_strength_20d
        self.rel_strength_60d = rel_strength_60d
        self.trend_strength = trend_strength

    def build_signals(self):
        from valuesteward.core.signal_engine import SignalResult, SymbolSignal

        sig = SymbolSignal(
            symbol=self.symbol,
            score=self.score,
            momentum_rank=1,
            vol_rank=1,
            drawdown_rank=1,
            volatility=0.01,
            last_close=100.0,
            day_return=0.01,
            trend_strength=self.trend_strength,
            mom_5d=0.01,
            mom_20d=0.02,
            mom_60d=0.05,
            rel_strength_20d=self.rel_strength_20d,
            rel_strength_60d=self.rel_strength_60d,
            momentum_raw=0.05,
            drawdown=0.0,
            bars=100,
        )
        return SignalResult(
            universe_size=1,
            evaluated=1,
            skipped=0,
            signals=[sig],
            by_symbol={self.symbol: sig},
            correlations={},
        )


def test_stressed_regime_allows_defensive_sector_buy_with_smaller_size() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySymbolSignalEngine("XLE", score=1.6),
    )
    world_context = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "final_regime": {
            "final_label": "stressed",
            "final_score": 0.82,
            "divergence": True,
            "fusion_reason": "probabilistic_more_cautious",
        },
    }

    intent, _ = engine.decide(
        snapshot, world_tags=["DEFAULT"], world_context=world_context
    )

    assert intent.action_type == "BUY"
    assert intent.symbol == "XLE"
    assert intent.size_pct is not None
    assert intent.size_pct < governor.config.max_position_pct


def test_stressed_regime_blocks_non_defensive_new_buy() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySymbolSignalEngine("SPY", score=1.6),
    )
    world_context = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "final_regime": {
            "final_label": "stressed",
            "final_score": 0.82,
            "divergence": True,
            "fusion_reason": "probabilistic_more_cautious",
        },
    }

    intent, _ = engine.decide(
        snapshot, world_tags=["DEFAULT"], world_context=world_context
    )

    assert intent.action_type == "NO_ACTION"
    assert intent.reason_code == "BUY_BLOCKED"


def test_crisis_regime_allows_existing_position_add_on_with_strong_signal() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=99_995.0,
        equity=100_000.0,
        positions=[
            Position(
                symbol="SPY",
                quantity=0.05,
                market_value=5.0,
                asset_class="us_equity",
            )
        ],
        risk_exposure_pct=0.05,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySymbolSignalEngine("SPY", score=0.15),
    )
    world_context = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "final_regime": {
            "final_label": "crisis-prone",
            "final_score": 0.9,
            "divergence": True,
            "fusion_reason": "probabilistic_more_cautious",
        },
    }

    intent, _ = engine.decide(
        snapshot, world_tags=["DEFAULT"], world_context=world_context
    )

    assert intent.action_type == "BUY"
    assert intent.symbol == "SPY"


def test_new_entry_is_blocked_when_relative_strength_is_not_benchmark_positive() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySymbolSignalEngine(
            "SPY",
            score=1.6,
            rel_strength_20d=-0.02,
            rel_strength_60d=0.03,
            trend_strength=0.02,
        ),
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])

    assert intent.action_type == "NO_ACTION"
    assert intent.reason_code == "BUY_BLOCKED"
    assert "entry_quality" in intent.explanation


def test_existing_position_add_on_remains_looser_than_new_entry_gate() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=99_995.0,
        equity=100_000.0,
        positions=[
            Position(
                symbol="SPY",
                quantity=0.05,
                market_value=5.0,
                asset_class="us_equity",
            )
        ],
        risk_exposure_pct=0.05,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySymbolSignalEngine(
            "SPY",
            score=0.15,
            rel_strength_20d=-0.04,
            rel_strength_60d=-0.01,
            trend_strength=0.01,
        ),
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])

    assert intent.action_type == "BUY"
    assert intent.reason_code == "UNDER_TARGET_BUY"


def test_buy_is_blocked_when_sandbox_headroom_is_below_minimum_notional() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=99_980.5,
        equity=100_000.0,
        positions=[
            Position(
                symbol="SPY",
                quantity=0.195,
                market_value=19.5,
                asset_class="us_equity",
            )
        ],
        risk_exposure_pct=0.000195,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySameSymbolCorrelatedSignalEngine(),
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])

    assert intent.action_type == "NO_ACTION"
    assert intent.reason_code == "BUY_BLOCKED"
    assert "sandbox_headroom" in intent.explanation


def test_buy_size_is_clamped_to_remaining_sandbox_headroom() -> None:
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=99_983.0,
        equity=100_000.0,
        positions=[
            Position(
                symbol="SPY",
                quantity=0.17,
                market_value=17.0,
                asset_class="us_equity",
            )
        ],
        risk_exposure_pct=0.00017,
    )
    settings = build_settings()
    governor = RiskGovernor(mode=RiskMode.LOW, settings=settings)
    engine = DecisionEngine(
        risk_governor=governor,
        pattern_library=PatternLibrary(),
        settings=settings,
        portfolio_repository=DummyPortfolioRepository(),
        signal_engine=DummySameSymbolCorrelatedSignalEngine(),
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])

    assert intent.action_type == "BUY"
    assert intent.size_pct is not None
    assert abs(intent.size_pct - (3.0 / 100_000.0)) < 1e-12
