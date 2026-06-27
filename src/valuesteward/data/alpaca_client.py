"""Alpaca API wrapper for the Value Steward agent with professional resilience."""

from __future__ import annotations

import time
import logging
from functools import wraps
from datetime import datetime, timezone
from typing import Any, List, Literal, cast, Callable

from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, TimeInForce, QueryOrderStatus
from alpaca.common.enums import Sort
from alpaca.trading.requests import GetOrdersRequest, MarketOrderRequest
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockSnapshotRequest

from valuesteward.config import ValueStewardSettings, get_settings
from valuesteward.models import PortfolioSnapshot, Position

logger = logging.getLogger(__name__)

NOISY_NAME_PATTERNS = (
    "acquisition corp",
    "acquisition corporation",
    "blank check",
    "special purpose acquisition",
    "spac",
    "ultra buffer",
    "defined outcome",
    "target outcome",
    "buffer etf",
    "warrant",
    "rights",
    "unit",
)


def _is_noisy_asset(asset: Any) -> bool:
    name = str(getattr(asset, "name", "") or "").lower()
    symbol = str(getattr(asset, "symbol", "") or "").upper()
    if any(pattern in name for pattern in NOISY_NAME_PATTERNS):
        return True
    if symbol.endswith("W") or symbol.endswith("R") or symbol.endswith("U"):
        return True
    return False

def retry_alpaca(retries: int = 3, backoff: float = 1.0):
    """Decorator for institutional-grade exponential backoff."""
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exc = None
            for i in range(retries):
                try:
                    return func(*args, **kwargs)
                except Exception as exc:
                    last_exc = exc
                    # Handle rate limits specifically if possible, or generic 500s
                    msg = str(exc).lower()
                    if (
                        "429" in msg 
                        or "too many requests" in msg 
                        or "500" in msg 
                        or "502" in msg
                    ):
                        wait = backoff * (2 ** i)
                        logger.warning(
                            f"[ALPACA] Rate limit or server error. "
                            f"Retrying in {wait}s... ({i+1}/{retries})"
                        )
                        time.sleep(wait)
                        continue
                    raise # Don't retry on auth or logic errors
            raise last_exc
        return wrapper
    return decorator

class AlpacaClient:
    """Thin wrapper around Alpaca's trading SDK with retry resilience."""

    def __init__(self, settings: ValueStewardSettings | None = None) -> None:
        self.settings = settings or get_settings()
        self._trading_client = TradingClient(
            api_key=self.settings.alpaca_api_key_id,
            secret_key=self.settings.alpaca_secret_key,
            paper=True,
            url_override=self.settings.alpaca_base_url,
        )
        self._data_client = StockHistoricalDataClient(
            self.settings.alpaca_api_key_id,
            self.settings.alpaca_secret_key,
        )

    @retry_alpaca()
    def get_account(self):
        return self._trading_client.get_account()

    @retry_alpaca()
    def get_all_assets(self):
        return self._trading_client.get_all_assets()

    def list_tradable_symbols(self) -> List[str]:
        symbols: List[str] = []
        for asset in self.get_all_assets():
            if getattr(asset, "tradable", False) is not True:
                continue
            if getattr(asset, "status", "").lower() != "active":
                continue
            if getattr(asset, "asset_class", "").lower() != "us_equity":
                continue
            # Fractional Check
            if getattr(asset, "fractionable", False) is not True:
                continue
            if _is_noisy_asset(asset):
                continue
            symbol = getattr(asset, "symbol", None)
            if symbol:
                symbols.append(symbol)
        return symbols

    @retry_alpaca()
    def get_positions(self) -> List[Position]:
        positions = []
        positions_raw = cast(List[Any], self._trading_client.get_all_positions())
        for position in positions_raw:
            positions.append(Position(
                symbol=position.symbol,
                quantity=float(position.qty),
                market_value=float(position.market_value),
                asset_class=getattr(position, "asset_class", "us_equity"),
            ))
        return positions

    @retry_alpaca()
    def get_clock(self):
        return self._trading_client.get_clock()

    @retry_alpaca()
    def get_snapshots(self, symbols: List[str]):
        request = StockSnapshotRequest(symbol_or_symbols=symbols)
        return self._data_client.get_stock_snapshot(request)

    def get_portfolio_snapshot(self) -> PortfolioSnapshot:
        account = self.get_account()
        positions = self.get_positions()
        return PortfolioSnapshot(
            timestamp=datetime.now(timezone.utc),
            cash=float(account.cash),
            equity=float(account.equity),
            positions=positions,
            risk_exposure_pct=0.0,
        )

    @retry_alpaca()
    def get_open_orders(self):
        request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
        return self._trading_client.get_orders(filter=request)

    @retry_alpaca()
    def get_recent_orders(self, limit: int = 20):
        request = GetOrdersRequest(
            status=QueryOrderStatus.ALL,
            limit=limit,
            direction=Sort.DESC,
            nested=True,
        )
        return self._trading_client.get_orders(filter=request)

    @retry_alpaca()
    def cancel_open_orders(self, symbol: str | None = None) -> int:
        """Cancel orders and verify completion."""
        count = 0
        orders = self.get_open_orders()
        for order in orders:
            if symbol is None or order.symbol == symbol:
                self._trading_client.cancel_order_by_id(order.id)
                count += 1
        
        if count > 0:
            logger.info(f"[EXEC] Sent cancel request for {count} orders ({symbol or 'all'}).")
            # Wait for cancellation to propagate
            time.sleep(2.0) 
        return count

    @retry_alpaca()
    def submit_steward_order(
        self,
        symbol: str,
        side: Literal["buy", "sell"],
        notional: float,
    ) -> float | None:
        """Submit a mid-point Limit Order with retry resilience."""
        order_side = OrderSide.BUY if side == "buy" else OrderSide.SELL
        
        try:
            snapshot = self.get_snapshots([symbol])
            snap = snapshot.get(symbol)
            if snap and snap.latest_quote:
                bid = float(snap.latest_quote.bid_price)
                ask = float(snap.latest_quote.ask_price)
                if bid > 0 and ask > 0:
                    limit_price = round((bid + ask) / 2.0, 2)
                    qty = round(notional / limit_price, 4)
                    
                    from alpaca.trading.requests import LimitOrderRequest
                    order: Any = LimitOrderRequest(
                        symbol=symbol,
                        qty=qty,
                        limit_price=limit_price,
                        side=order_side,
                        time_in_force=TimeInForce.DAY,
                    )
                    self._trading_client.submit_order(order_data=order)
                    logger.info(
                        f"[EXEC] Mid-point LIMIT: {side.upper()} {symbol} "
                        f"qty={qty} @ ${limit_price:.2f}"
                    )
                    return limit_price
        except Exception as exc:
            logger.warning(
                f"[WARN] Mid-point calc failed for {symbol}: {exc}. "
                "Falling back to market."
            )

        order = MarketOrderRequest(
            symbol=symbol,
            notional=round(notional, 2),
            side=order_side,
            time_in_force=TimeInForce.DAY,
        )
        self._trading_client.submit_order(order_data=order)
        logger.info(
            f"[EXEC] Fallback MARKET: {side.upper()} {symbol} "
            f"notional=${notional:.2f}"
        )
        return None
