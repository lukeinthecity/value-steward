"""Market data access helpers for signal generation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame

from valuesteward.config import ValueStewardSettings, get_settings


class MarketDataClient:
    """Thin wrapper over Alpaca's historical data client."""

    def __init__(self, settings: ValueStewardSettings | None = None) -> None:
        self.settings = settings or get_settings()
        self._client = StockHistoricalDataClient(
            self.settings.alpaca_api_key_id,
            self.settings.alpaca_secret_key,
        )

    def get_daily_bars(
        self,
        symbols: Iterable[str],
        lookback_days: int,
    ) -> Dict[str, List]:
        """Return daily bars for each symbol over the lookback window."""

        # Alpaca Free Tier requires a 15-min delay for SIP data.
        # We use 16 mins to be safe.
        end = datetime.now(timezone.utc) - timedelta(minutes=16)
        start = end - timedelta(days=lookback_days)
        request = StockBarsRequest(
            symbol_or_symbols=list(symbols),
            timeframe=TimeFrame.Day,
            start=start,
            end=end,
        )
        bars = self._client.get_stock_bars(request)
        data = getattr(bars, "data", bars)
        if isinstance(data, dict):
            return data
        return {}
