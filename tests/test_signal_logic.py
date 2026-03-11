from valuesteward.core.signal_engine import SignalEngine
from valuesteward.core.signal_engine import SymbolSignal
from unittest.mock import MagicMock

def test_signal_ranking_logic():
    engine = SignalEngine(alpaca_client=MagicMock())
    
    # Create mock signals
    # Good: High Mom, Low Vol, Low DD
    sig_good = SymbolSignal(
        symbol="GOOD", last_close=100, day_return=0.01, trend_strength=0.1,
        mom_5d=0.05, mom_20d=0.1, mom_60d=0.2, rel_strength_20d=0.05, rel_strength_60d=0.1,
        momentum_raw=1.0, momentum_rank=0.0, vol_rank=0.0, drawdown_rank=0.0,
        volatility=0.01, drawdown=0.01, score=0.0, bars=100
    )
    
    # Bad: Low Mom, High Vol, High DD
    sig_bad = SymbolSignal(
        symbol="BAD", last_close=100, day_return=-0.01, trend_strength=-0.1,
        mom_5d=-0.05, mom_20d=-0.1, mom_60d=-0.2, rel_strength_20d=-0.05, rel_strength_60d=-0.1,
        momentum_raw=-1.0, momentum_rank=0.0, vol_rank=0.0, drawdown_rank=0.0,
        volatility=0.1, drawdown=0.1, score=0.0, bars=100
    )

    signals = [sig_good, sig_bad]
    
    # Mock the weights
    engine._get_env_float = MagicMock(side_effect=lambda key, default: {
        "VS_SIGNAL_W_RANK_MOM": 1.0,
        "VS_SIGNAL_W_RANK_VOL": 0.4,
        "VS_SIGNAL_W_RANK_DD": 0.4
    }.get(key, default))

    # We need to bypass build_signals and just test the ranking/scoring logic
    momentum_values = [s.momentum_raw for s in signals]
    vol_values = [s.volatility for s in signals]
    dd_values = [s.drawdown for s in signals]

    mom_ranks = engine._percentile_ranks(momentum_values, higher_is_better=True)
    vol_ranks = engine._percentile_ranks(vol_values, higher_is_better=False)
    dd_ranks = engine._percentile_ranks(dd_values, higher_is_better=False)

    for idx, signal in enumerate(signals):
        signal.momentum_rank = mom_ranks.get(idx, 0.0)
        signal.vol_rank = vol_ranks.get(idx, 0.0)
        signal.drawdown_rank = dd_ranks.get(idx, 0.0)
        signal.score = (
            1.0 * signal.momentum_rank
            + 0.4 * signal.vol_rank
            + 0.4 * signal.drawdown_rank
        )

    print(f"GOOD score: {sig_good.score}, BAD score: {sig_bad.score}")
    assert sig_good.score > sig_bad.score
    assert sig_good.momentum_rank == 1.0
    assert sig_good.vol_rank == 1.0
    assert sig_good.drawdown_rank == 1.0
    assert sig_bad.momentum_rank == 0.0
    assert sig_bad.vol_rank == 0.0
    assert sig_bad.drawdown_rank == 0.0

if __name__ == "__main__":
    test_signal_ranking_logic()
    print("Signal logic test passed!")
