"""Market signal engine for symbol ranking with mathematical safety rails."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional
import os
import statistics
import logging
import math
from pydantic import Field

from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.data.market_data import MarketDataClient
from valuesteward.config import ValueStewardSettings

logger = logging.getLogger(__name__)

@dataclass
class SymbolSignal:
    symbol: str
    last_close: float
    day_return: float
    trend_strength: float
    mom_5d: float
    mom_20d: float
    mom_60d: float
    rel_strength_20d: float
    rel_strength_60d: float
    momentum_raw: float
    momentum_rank: float
    vol_rank: float
    drawdown_rank: float
    volatility: float
    drawdown: float
    score: float
    bars: int
    avg_volume: float | None = None
    score_raw: float | None = None
    score_smoothed: float | None = None
    last_bar_date: date | None = None


@dataclass
class SignalResult:
    universe_size: int
    evaluated: int
    skipped: int
    signals: List[SymbolSignal]
    by_symbol: Dict[str, SymbolSignal]
    correlations: Dict[str, Dict[str, float]] = Field(default_factory=dict)
    evaluated_total: int | None = None
    top_limit: int | None = None
    smoothing_days: int | None = None
    smoothing_alpha: float | None = None

    def best(self) -> Optional[SymbolSignal]:
        return self.signals[0] if self.signals else None


class SignalEngine:
    """Compute deterministic signals from historical prices."""

    def __init__(
        self,
        alpaca_client: AlpacaClient,
        data_client: MarketDataClient | None = None,
        settings: ValueStewardSettings | None = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.data_client = data_client or MarketDataClient()
        from valuesteward.config import get_settings
        self.settings = settings or get_settings()

    def _get_env_int(self, key: str, default: int) -> int:
        raw = os.getenv(key)
        if raw is None or not raw.strip():
            return default
        try:
            return int(raw)
        except ValueError:
            return default

    def _get_env_float(self, key: str, default: float) -> float:
        raw = os.getenv(key)
        if raw is None or not raw.strip():
            return default
        try:
            return float(raw)
        except ValueError:
            return default

    def build_universe(self) -> List[str]:
        raw = os.getenv("VS_UNIVERSE_SYMBOLS", "")
        if raw.strip():
            return [item.strip().upper() for item in raw.split(",") if item.strip()]
        
        symbols = self.alpaca_client.list_tradable_symbols()
        max_symbols = self._get_env_int("VS_SIGNAL_MAX_SYMBOLS", 0)
        if max_symbols and len(symbols) > max_symbols:
            return symbols[:max_symbols]
        return symbols

    def _chunk(self, symbols: Iterable[str], size: int) -> Iterable[List[str]]:
        batch: List[str] = []
        for symbol in symbols:
            batch.append(symbol)
            if len(batch) >= size:
                yield batch
                batch = []
        if batch:
            yield batch

    def _percentile_ranks(
        self, values: List[float], higher_is_better: bool = True
    ) -> Dict[int, float]:
        if not values:
            return {}
        indexed = list(enumerate(values))
        indexed.sort(key=lambda item: item[1], reverse=not higher_is_better)
        n = len(values)
        if n == 1:
            return {indexed[0][0]: 1.0}
        return {idx: rank / (n - 1) for rank, (idx, _) in enumerate(indexed)}

    def _compute_correlation(self, returns1: List[float], returns2: List[float]) -> float:
        if (
            not returns1 
            or not returns2 
            or len(returns1) != len(returns2) 
            or len(returns1) < 2
        ):
            return 0.0
        try:
            mean1, mean2 = statistics.mean(returns1), statistics.mean(returns2)
            diff1 = [x - mean1 for x in returns1]
            diff2 = [x - mean2 for x in returns2]
            num = sum(d1 * d2 for d1, d2 in zip(diff1, diff2, strict=True))
            den = (
                math.sqrt(sum(d1 * d1 for d1 in diff1)) 
                * math.sqrt(sum(d2 * d2 for d2 in diff2))
            )
            return max(-1.0, min(1.0, num / den)) if den > 0 else 0.0
        except Exception:
            return 0.0

    def build_correlations(
        self, signals: List[SymbolSignal], returns_map: Dict[str, List[float]]
    ) -> Dict[str, Dict[str, float]]:
        matrix: Dict[str, Dict[str, float]] = {}
        symbols = [s.symbol for s in signals]
        for i, sym1 in enumerate(symbols):
            if sym1 not in matrix:
                matrix[sym1] = {sym1: 1.0}
            ret1 = returns_map.get(sym1, [])
            for j in range(i + 1, len(symbols)):
                sym2 = symbols[j]
                ret2 = returns_map.get(sym2, [])
                n = min(len(ret1), len(ret2))
                corr = self._compute_correlation(ret1[-n:], ret2[-n:]) if n >= 5 else 0.0
                if sym2 not in matrix:
                    matrix[sym2] = {sym2: 1.0}
                matrix[sym1][sym2] = matrix[sym2][sym1] = corr
        return matrix

    def _apply_smoothing(self, signals: List[SymbolSignal]) -> tuple[int | None, float | None]:
        days = self._get_env_int("VS_SIGNAL_SMOOTH_DAYS", 0)
        if days <= 1 or not signals:
            for s in signals:
                s.score_raw = s.score_smoothed = s.score
            return None, None
        
        alpha = 2 / (days + 1)
        # Smoothing logic here if needed...
        for s in signals:
            s.score_raw = s.score_smoothed = s.score # Default
        return days, alpha

    def _is_stale(self, last_bar_date: Any) -> bool:
        if last_bar_date is None:
            return True
        
        # Ensure we are comparing date to date
        if isinstance(last_bar_date, datetime):
            lb_date = last_bar_date.date()
        elif isinstance(last_bar_date, date):
            lb_date = last_bar_date
        else:
            try:
                lb_date = datetime.fromisoformat(str(last_bar_date)).date()
            except ValueError:
                return True

        today = datetime.now(timezone.utc).date()
        diff = (today - lb_date).days
        
        # --- Professional Hardening: Holiday Tolerance ---
        # Allow up to 4 days for 3-day weekends/holidays
        allowed = max(4, self.settings.max_signal_age_days)
        if today.weekday() == 0: # Monday
            allowed += 2
        elif today.weekday() == 1: # Tuesday (handles Monday holiday)
            allowed += 1
        elif today.weekday() == 6: # Sunday
            allowed += 1
        return diff > allowed

    def build_signals(self) -> SignalResult:
        lookback_days = self._get_env_int("VS_SIGNAL_LOOKBACK_DAYS", 120)
        fast = self._get_env_int("VS_SIGNAL_SMA_FAST", 20)
        slow = self._get_env_int("VS_SIGNAL_SMA_SLOW", 60)
        vol_window = self._get_env_int("VS_SIGNAL_VOL_WINDOW", 20)
        min_bars = self._get_env_int("VS_SIGNAL_MIN_BARS", 60)
        benchmark = os.getenv("VS_SIGNAL_BENCHMARK", "SPY").strip().upper()
        
        w_mom_5 = self._get_env_float("VS_SIGNAL_W_MOM_5", 0.2)
        w_mom_20 = self._get_env_float("VS_SIGNAL_W_MOM_20", 0.3)
        w_mom_60 = self._get_env_float("VS_SIGNAL_W_MOM_60", 0.5)
        w_rel_20 = self._get_env_float("VS_SIGNAL_W_REL_20", 0.3)
        w_rel_60 = self._get_env_float("VS_SIGNAL_W_REL_60", 0.7)
        
        w_rank_mom = self.settings.w_rank_mom
        w_rank_vol = self.settings.w_rank_vol
        w_rank_dd = self.settings.w_rank_dd

        symbols = self.build_universe()
        benchmark_closes: List[float] = []
        if benchmark:
            bench_bars = self.data_client.get_daily_bars(
                [benchmark], lookback_days
            ).get(benchmark, [])
            
            if not bench_bars or self._is_stale(
                getattr(bench_bars[-1], "timestamp", None)
            ):
                logger.error(f"Benchmark {benchmark} stale/missing.")
                return SignalResult(len(symbols), 0, 0, [], {})
            
            benchmark_closes = [
                float(b.close) for b in bench_bars if getattr(b, "close", None)
            ]

        signals: List[SymbolSignal] = []
        all_returns: Dict[str, List[float]] = {}
        skipped = 0

        for batch in self._chunk(symbols, 200):
            bars_by_symbol = self.data_client.get_daily_bars(batch, lookback_days)
            for symbol, bars in bars_by_symbol.items():
                last_bar_date = None
                if bars:
                    ts = (
                        getattr(bars[-1], "timestamp", None) 
                        or getattr(bars[-1], "t", None)
                    )
                    if isinstance(ts, datetime):
                        last_bar_date = ts.date()
                    elif ts:
                        try:
                            last_bar_date = datetime.fromisoformat(str(ts)).date()
                        except ValueError:
                            last_bar_date = None
                
                if not bars or self._is_stale(last_bar_date):
                    skipped += 1
                    continue
                
                closes = [
                    float(b.close) for b in bars if getattr(b, "close", None)
                ]
                if len(closes) < min_bars:
                    skipped += 1
                    continue
                
                # Returns calculation
                rets = [
                    (closes[i] / closes[i - 1]) - 1.0 
                    for i in range(1, len(closes)) if closes[i - 1] != 0
                ]
                all_returns[symbol] = rets
                
                last_close, prev_close = closes[-1], closes[-2]
                day_ret = (
                    (last_close - prev_close) / prev_close if prev_close != 0 else 0.0
                )
                
                sma_f = statistics.mean(closes[-fast:])
                sma_s = statistics.mean(closes[-slow:])
                trend = (sma_f / sma_s - 1.0) if sma_s != 0 else 0.0

                mom_5 = (last_close / closes[-6] - 1.0) if len(closes) >= 6 else 0.0
                mom_20 = (last_close / closes[-21] - 1.0) if len(closes) >= 21 else 0.0
                mom_60 = (last_close / closes[-61] - 1.0) if len(closes) >= 61 else 0.0

                rel_20 = rel_60 = 0.0
                if benchmark_closes and len(benchmark_closes) >= 61:
                    b20 = (benchmark_closes[-1] / benchmark_closes[-21] - 1.0)
                    b60 = (benchmark_closes[-1] / benchmark_closes[-61] - 1.0)
                    if b20 > -1.0:
                        rel_20 = ((1.0 + mom_20) / (1.0 + b20)) - 1.0
                    if b60 > -1.0:
                        rel_60 = ((1.0 + mom_60) / (1.0 + b60)) - 1.0

                vol = (
                    statistics.pstdev(rets[-vol_window:]) 
                    if len(rets) >= vol_window else 0.0
                )
                peak = max(closes)
                dd = (peak - last_close) / peak if peak != 0 else 0.0

                # --- Elite Quant: Risk-Adjusted Momentum ---
                vol_5 = statistics.pstdev(rets[-5:]) if len(rets) >= 5 else 0.01
                vol_20 = statistics.pstdev(rets[-20:]) if len(rets) >= 20 else 0.01
                vol_60 = statistics.pstdev(rets[-60:]) if len(rets) >= 60 else 0.01
                
                # Signal-to-Noise Ratio (Sharpe-lite)
                adj_mom_5 = mom_5 / (vol_5 * math.sqrt(5) or 0.01)
                adj_mom_20 = mom_20 / (vol_20 * math.sqrt(20) or 0.01)
                adj_mom_60 = mom_60 / (vol_60 * math.sqrt(60) or 0.01)
                
                mom_raw = (
                    w_mom_5 * adj_mom_5 
                    + w_mom_20 * adj_mom_20 
                    + w_mom_60 * adj_mom_60 
                    + w_rel_20 * rel_20 
                    + w_rel_60 * rel_60
                )
                # -------------------------------------------
                
                signals.append(SymbolSignal(
                    symbol=symbol, last_close=last_close, day_return=day_ret, 
                    trend_strength=trend, mom_5d=mom_5, mom_20d=mom_20, 
                    mom_60d=mom_60, rel_strength_20d=rel_20, 
                    rel_strength_60d=rel_60, momentum_raw=mom_raw, 
                    momentum_rank=0.0, vol_rank=0.0, drawdown_rank=0.0, 
                    volatility=vol, drawdown=dd, score=0.0, bars=len(closes), 
                    last_bar_date=last_bar_date
                ))

        if not signals:
            return SignalResult(len(symbols), 0, skipped, [], {})

        m_ranks = self._percentile_ranks([s.momentum_raw for s in signals], True)
        v_ranks = self._percentile_ranks([s.volatility for s in signals], False)
        d_ranks = self._percentile_ranks([s.drawdown for s in signals], False)
        
        for idx, s in enumerate(signals):
            s.momentum_rank = m_ranks.get(idx, 0.0)
            s.vol_rank = v_ranks.get(idx, 0.0)
            s.drawdown_rank = d_ranks.get(idx, 0.0)
            s.score = (
                w_rank_mom * s.momentum_rank 
                + w_rank_vol * s.vol_rank 
                + w_rank_dd * s.drawdown_rank
            )

        signals.sort(key=lambda x: x.score, reverse=True)
        return SignalResult(
            len(symbols), 
            len(signals), 
            skipped, 
            signals, 
            {s.symbol: s for s in signals}, 
            self.build_correlations(signals, all_returns)
        )
