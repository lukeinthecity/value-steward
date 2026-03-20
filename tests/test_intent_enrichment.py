"""Tests for intent enrichment fields."""

from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.models import PortfolioSnapshot, RiskMode


class DummyPortfolioRepository:
    def get_position_for_symbol(self, snapshot: PortfolioSnapshot, symbol: str):
        return None


class DummySignalEngine:
    def build_signals(self):
        from valuesteward.core.signal_engine import SignalResult, SymbolSignal
        sig = SymbolSignal(
            symbol="SPY", 
            score=0.0, 
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
        signal_engine=DummySignalEngine(),
    )
    snapshot = PortfolioSnapshot(
        timestamp=datetime.now(timezone.utc),
        cash=100_000.0,
        equity=100_000.0,
        positions=[],
        risk_exposure_pct=0.0,
    )

    intent, _ = engine.decide(snapshot, world_tags=["DEFAULT"])
    assert intent.core_symbol == "SPY"
    assert intent.target_risk_exposure_pct == settings.target_risk_exposure_pct_low
    assert intent.rebalance_buffer_pct == settings.rebalance_buffer_pct
    assert intent.reason_code == "UNDER_TARGET_BUY"
    assert intent.gate_scout_binding is False


def test_decision_engine_uses_fused_regime_for_buy_block() -> None:
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
        signal_engine=DummySignalEngine(),
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
        "macro_view": {"macro_label": "calm", "macro_score": 0.1},
        "final_regime": {
            "final_label": "stressed",
            "final_score": 0.72,
            "divergence": True,
            "fusion_reason": "scout_more_cautious",
        },
        "scout_label": "stressed",
        "scout_score": 0.72,
    }

    intent, _ = engine.decide(
        snapshot,
        world_tags=["DEFAULT", "REGIME_DIVERGENT"],
        world_context=world_context,
    )

    assert intent.reason_code == "BUY_BLOCKED"
    assert intent.explanation == "Buy blocked: macro_label=stressed"
