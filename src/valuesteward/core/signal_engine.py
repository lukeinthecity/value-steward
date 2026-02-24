"""Market signal engine for symbol ranking."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Dict, Iterable, List, Optional
import json
import os
import statistics

from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.data.market_data import MarketDataClient


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


@dataclass
class SignalResult:
    universe_size: int
    evaluated: int
    skipped: int
    evaluated_total: int | None = None
    top_limit: int | None = None
    signals: List[SymbolSignal]
    by_symbol: Dict[str, SymbolSignal]
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
    ) -> None:
        self.alpaca_client = alpaca_client
        self.data_client = data_client or MarketDataClient()

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

    def _get_symbol_override(self) -> List[str]:
        raw = os.getenv("VS_UNIVERSE_SYMBOLS", "")
        if not raw.strip():
            return []
        return [item.strip().upper() for item in raw.split(",") if item.strip()]

    def build_universe(self) -> List[str]:
        override = self._get_symbol_override()
        if override:
            return override
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
        indexed.sort(key=lambda item: item[1], reverse=higher_is_better)
        n = len(values)
        ranks: Dict[int, float] = {}
        if n == 1:
            ranks[indexed[0][0]] = 0.5
            return ranks
        for rank, (idx, _value) in enumerate(indexed):
            ranks[idx] = rank / (n - 1)
        return ranks

    def _load_smoothing_state(self, path: str) -> Dict[str, dict]:
        if not path:
            return {}
        try:
            if not os.path.exists(path):
                return {}
            with open(path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            symbols = raw.get("symbols") if isinstance(raw, dict) else None
            if isinstance(symbols, dict):
                return symbols
        except Exception:
            return {}
        return {}

    def _save_smoothing_state(self, path: str, symbols: Dict[str, dict], days: int) -> None:
        if not path:
            return
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        payload = {
            "as_of": datetime.utcnow().date().isoformat(),
            "days": days,
            "symbols": symbols,
        }
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)

    def _parse_date(self, value: str | None) -> date | None:
        if not value:
            return None
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None

    def _apply_smoothing(self, signals: List[SymbolSignal]) -> tuple[int | None, float | None]:
        days = self._get_env_int("VS_SIGNAL_SMOOTH_DAYS", 0)
        if days <= 1 or not signals:
            for signal in signals:
                signal.score_raw = signal.score
                signal.score_smoothed = signal.score
            return None, None

        alpha = 2 / (days + 1)
        path = os.getenv("VS_SIGNAL_SMOOTH_FILE", "data/signal-smoothing.json").strip()
        apply_same_day = (
            os.getenv("VS_SIGNAL_SMOOTH_APPLY_SAME_DAY", "false").strip().lower()
            in {"1", "true", "yes", "y"}
        )
        max_age_days = self._get_env_int("VS_SIGNAL_SMOOTH_MAX_AGE_DAYS", 30)
        today = datetime.utcnow().date()
        state = self._load_smoothing_state(path)
        changed = False

        for signal in signals:
            raw_score = float(signal.score)
            signal.score_raw = raw_score
            entry = state.get(signal.symbol)
            ema_prev = None
            last_date = None
            if isinstance(entry, dict):
                ema_prev = entry.get("ema")
                last_date = self._parse_date(entry.get("last_date"))
            if not isinstance(ema_prev, (int, float)):
                ema_prev = raw_score

            if last_date == today and not apply_same_day:
                smoothed = float(ema_prev)
                if isinstance(entry, dict):
                    entry["last_seen"] = today.isoformat()
                    changed = True
            else:
                smoothed = alpha * raw_score + (1 - alpha) * float(ema_prev)
                state[signal.symbol] = {
                    "ema": smoothed,
                    "last_date": today.isoformat(),
                    "last_seen": today.isoformat(),
                    "last_score": raw_score,
                }
                changed = True
            signal.score = smoothed
            signal.score_smoothed = smoothed

        if max_age_days > 0 and state:
            cutoff = today.toordinal() - max_age_days
            stale = []
            for symbol, entry in state.items():
                last_seen = None
                if isinstance(entry, dict):
                    last_seen = self._parse_date(entry.get("last_seen") or entry.get("last_date"))
                if last_seen is None or last_seen.toordinal() < cutoff:
                    stale.append(symbol)
            if stale:
                for symbol in stale:
                    state.pop(symbol, None)
                changed = True

        if changed:
            self._save_smoothing_state(path, state, days)

        return days, alpha

    def _get_top_movers_via_snapshots(self, symbols: List[str], top_n: int) -> List[str]:
        if not symbols or top_n <= 0:
            return symbols
        ranked: List[tuple[str, float]] = []
        for batch in self._chunk(symbols, 1000):
            try:
                snapshots = self.alpaca_client.get_snapshots(batch)
            except Exception:
                continue
            data = getattr(snapshots, "data", snapshots)
            if isinstance(data, dict):
                items = data.items()
            else:
                items = []
            for symbol, snap in items:
                if snap is None:
                    continue
                daily = getattr(snap, "daily_bar", None)
                prev = getattr(snap, "prev_daily_bar", None)
                if not daily or not prev:
                    continue
                close = getattr(daily, "close", None)
                prev_close = getattr(prev, "close", None)
                if not close or not prev_close:
                    continue
                try:
                    day_return = (float(close) - float(prev_close)) / float(prev_close)
                except (ValueError, ZeroDivisionError):
                    continue
                ranked.append((symbol, day_return))
        ranked.sort(key=lambda item: item[1], reverse=True)
        top = [item[0] for item in ranked[:top_n]]
        return top if top else symbols

    def build_signals(self) -> SignalResult:
        lookback_days = self._get_env_int("VS_SIGNAL_LOOKBACK_DAYS", 120)
        fast = self._get_env_int("VS_SIGNAL_SMA_FAST", 20)
        slow = self._get_env_int("VS_SIGNAL_SMA_SLOW", 60)
        vol_window = self._get_env_int("VS_SIGNAL_VOL_WINDOW", 20)
        min_bars = self._get_env_int("VS_SIGNAL_MIN_BARS", slow)
        min_price = self._get_env_float("VS_SIGNAL_MIN_PRICE", 0.0)
        min_avg_volume = self._get_env_float("VS_SIGNAL_MIN_AVG_VOLUME", 0.0)
        chunk_size = self._get_env_int("VS_SIGNAL_CHUNK", 200)
        top_performers = self._get_env_int("VS_SIGNAL_TOP_PERFORMERS", 0)
        use_snapshot_filter = (
            os.getenv("VS_SIGNAL_USE_SNAPSHOTS", "true").strip().lower()
            in {"1", "true", "yes", "y"}
        )
        benchmark = os.getenv("VS_SIGNAL_BENCHMARK", "SPY").strip().upper()
        mom_5 = self._get_env_int("VS_SIGNAL_MOMENTUM_5D", 5)
        mom_20 = self._get_env_int("VS_SIGNAL_MOMENTUM_20D", 20)
        mom_60 = self._get_env_int("VS_SIGNAL_MOMENTUM_60D", 60)
        w_mom_5 = self._get_env_float("VS_SIGNAL_W_MOM_5", 0.2)
        w_mom_20 = self._get_env_float("VS_SIGNAL_W_MOM_20", 0.3)
        w_mom_60 = self._get_env_float("VS_SIGNAL_W_MOM_60", 0.5)
        w_rel_20 = self._get_env_float("VS_SIGNAL_W_REL_20", 0.3)
        w_rel_60 = self._get_env_float("VS_SIGNAL_W_REL_60", 0.7)
        w_rank_mom = self._get_env_float("VS_SIGNAL_W_RANK_MOM", 1.0)
        w_rank_vol = self._get_env_float("VS_SIGNAL_W_RANK_VOL", 0.4)
        w_rank_dd = self._get_env_float("VS_SIGNAL_W_RANK_DD", 0.4)

        symbols = self.build_universe()
        universe_size = len(symbols)

        if top_performers and use_snapshot_filter:
            symbols = self._get_top_movers_via_snapshots(symbols, top_performers)

        benchmark_closes: List[float] = []
        if benchmark:
            bench_data = self.data_client.get_daily_bars([benchmark], lookback_days)
            bench_bars = bench_data.get(benchmark, [])
            benchmark_closes = [
                float(bar.close)
                for bar in bench_bars
                if getattr(bar, "close", None) is not None
            ]

        signals: List[SymbolSignal] = []
        skipped = 0

        for batch in self._chunk(symbols, chunk_size):
            bars_by_symbol = self.data_client.get_daily_bars(batch, lookback_days)
            for symbol, bars in bars_by_symbol.items():
                closes = [float(bar.close) for bar in bars if getattr(bar, "close", None) is not None]
                volumes = [float(bar.volume) for bar in bars if getattr(bar, "volume", None) is not None]
                if len(closes) < min_bars:
                    skipped += 1
                    continue
                last_close = closes[-1]
                prev_close = closes[-2] if len(closes) >= 2 else last_close
                day_return = (
                    (last_close - prev_close) / prev_close if prev_close else 0.0
                )
                if min_price and last_close < min_price:
                    skipped += 1
                    continue
                avg_volume = statistics.mean(volumes) if volumes else None
                if min_avg_volume and (avg_volume or 0.0) < min_avg_volume:
                    skipped += 1
                    continue

                sma_fast = statistics.mean(closes[-fast:])
                sma_slow = statistics.mean(closes[-slow:])
                trend_strength = (sma_fast / sma_slow - 1.0) if sma_slow else 0.0

                mom_5d = (
                    (last_close / closes[-(mom_5 + 1)] - 1.0)
                    if len(closes) >= mom_5 + 1
                    else 0.0
                )
                mom_20d = (
                    (last_close / closes[-(mom_20 + 1)] - 1.0)
                    if len(closes) >= mom_20 + 1
                    else 0.0
                )
                mom_60d = (
                    (last_close / closes[-(mom_60 + 1)] - 1.0)
                    if len(closes) >= mom_60 + 1
                    else 0.0
                )

                rel_strength_20d = 0.0
                rel_strength_60d = 0.0
                if benchmark_closes and len(benchmark_closes) >= mom_60 + 1:
                    bench_20 = (
                        benchmark_closes[-1] / benchmark_closes[-(mom_20 + 1)] - 1.0
                    )
                    bench_60 = (
                        benchmark_closes[-1] / benchmark_closes[-(mom_60 + 1)] - 1.0
                    )
                    rel_strength_20d = mom_20d - bench_20
                    rel_strength_60d = mom_60d - bench_60

                returns = []
                recent = closes[-(vol_window + 1) :]
                for i in range(1, len(recent)):
                    prev = recent[i - 1]
                    curr = recent[i]
                    if prev == 0:
                        continue
                    returns.append((curr - prev) / prev)
                volatility = statistics.pstdev(returns) if len(returns) >= 2 else 0.0

                peak = max(closes)
                drawdown = (peak - last_close) / peak if peak else 0.0

                momentum_raw = (
                    w_mom_5 * mom_5d
                    + w_mom_20 * mom_20d
                    + w_mom_60 * mom_60d
                    + w_rel_20 * rel_strength_20d
                    + w_rel_60 * rel_strength_60d
                )

                signals.append(
                    SymbolSignal(
                        symbol=symbol,
                        last_close=last_close,
                        day_return=day_return,
                        trend_strength=trend_strength,
                        mom_5d=mom_5d,
                        mom_20d=mom_20d,
                        mom_60d=mom_60d,
                        rel_strength_20d=rel_strength_20d,
                        rel_strength_60d=rel_strength_60d,
                        momentum_raw=momentum_raw,
                        momentum_rank=0.0,
                        vol_rank=0.0,
                        drawdown_rank=0.0,
                        volatility=volatility,
                        drawdown=drawdown,
                        score=0.0,
                        bars=len(closes),
                        avg_volume=avg_volume,
                    )
                )

        evaluated_total = len(signals)
        if top_performers and not use_snapshot_filter and evaluated_total > top_performers:
            top = sorted(signals, key=lambda item: item.day_return, reverse=True)[
                :top_performers
            ]
            top_symbols = {item.symbol for item in top}
            signals = [item for item in signals if item.symbol in top_symbols]

        momentum_values = [signal.momentum_raw for signal in signals]
        vol_values = [signal.volatility for signal in signals]
        dd_values = [signal.drawdown for signal in signals]

        mom_ranks = self._percentile_ranks(momentum_values, higher_is_better=True)
        vol_ranks = self._percentile_ranks(vol_values, higher_is_better=True)
        dd_ranks = self._percentile_ranks(dd_values, higher_is_better=True)
        for idx, signal in enumerate(signals):
            signal.momentum_rank = mom_ranks.get(idx, 0.0)
            signal.vol_rank = vol_ranks.get(idx, 0.0)
            signal.drawdown_rank = dd_ranks.get(idx, 0.0)
            signal.score = (
                w_rank_mom * signal.momentum_rank
                - w_rank_vol * signal.vol_rank
                - w_rank_dd * signal.drawdown_rank
            )

        smoothing_days, smoothing_alpha = self._apply_smoothing(signals)

        signals.sort(key=lambda item: item.score, reverse=True)
        by_symbol = {item.symbol: item for item in signals}
        return SignalResult(
            universe_size=universe_size,
            evaluated=len(signals),
            skipped=skipped,
            evaluated_total=evaluated_total,
            top_limit=top_performers if top_performers else None,
            signals=signals,
            by_symbol=by_symbol,
            smoothing_days=smoothing_days,
            smoothing_alpha=smoothing_alpha,
        )
