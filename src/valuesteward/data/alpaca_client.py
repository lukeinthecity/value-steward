"""Alpaca API wrapper for the Value Steward agent."""

from __future__ import annotations

import sys
from datetime import datetime
from typing import List, Literal

from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.requests import MarketOrderRequest

from valuesteward.config import ValueStewardSettings, get_settings
from valuesteward.models import PortfolioSnapshot, Position


class AlpacaClient:
    """Thin wrapper around Alpaca's trading SDK.

    TODO: add support for limit orders
    TODO: add retry / error handling
    TODO: add separate data feed for market data if needed
    """

    def __init__(self, settings: ValueStewardSettings | None = None) -> None:
        self.settings = settings or get_settings()
        self._trading_client = TradingClient(
            api_key=self.settings.alpaca_api_key_id,
            secret_key=self.settings.alpaca_secret_key,
            paper=True,
            url_override=self.settings.alpaca_base_url,
        )

    def get_account(self):
        """Return raw account info from Alpaca."""

        return self._trading_client.get_account()

    def get_positions(self) -> List[Position]:
        """Return current positions as Position models."""

        positions = []
        for position in self._trading_client.get_all_positions():
            positions.append(
                Position(
                    symbol=position.symbol,
                    quantity=float(position.qty),
                    market_value=float(position.market_value),
                    asset_class=getattr(position, "asset_class", "us_equity"),
                )
            )
        return positions

    def get_portfolio_snapshot(self) -> PortfolioSnapshot:
        """Build a basic PortfolioSnapshot from Alpaca account data."""

        account = self.get_account()
        positions = self.get_positions()
        return PortfolioSnapshot(
            timestamp=datetime.utcnow(),
            cash=float(account.cash),
            equity=float(account.equity),
            positions=positions,
            risk_exposure_pct=0.0,
        )

    def submit_order(
        self,
        symbol: str,
        qty: float,
        side: str,
        time_in_force: str = "day",
    ) -> None:
        """Submit an order to Alpaca.

        For v1, this will be used only in paper trading.
        """

        side_lower = side.lower()
        if side_lower not in {"buy", "sell"}:
            raise ValueError("side must be 'buy' or 'sell'.")

        order_side = OrderSide.BUY if side_lower == "buy" else OrderSide.SELL
        tif = TimeInForce.DAY
        if time_in_force.lower() != "day":
            raise ValueError("Only 'day' time_in_force is supported in v1.")

        order = MarketOrderRequest(
            symbol=symbol,
            qty=qty,
            side=order_side,
            time_in_force=tif,
        )
        try:
            self._trading_client.submit_order(order_data=order)
            print(f"[EXEC] Alpaca order submitted for {symbol} qty={qty}.")
        except Exception as exc:  # noqa: BLE001 - surface Alpaca errors clearly
            print(f"[ERROR] Alpaca order submission failed: {exc}", file=sys.stderr)
            # TODO: pass a logger instead of print.
            raise

        # TODO: support limit orders and other TIFs later.

    def submit_market_order(
        self,
        symbol: str,
        side: Literal["buy", "sell"],
        notional: float,
    ) -> None:
        """Submit a notional-based market order to Alpaca paper trading."""

        order_side = OrderSide.BUY if side == "buy" else OrderSide.SELL
        order = MarketOrderRequest(
            symbol=symbol,
            notional=round(notional, 2),
            side=order_side,
            time_in_force=TimeInForce.DAY,
        )
        try:
            self._trading_client.submit_order(order_data=order)
            print(
                f"[EXEC] Alpaca notional order submitted for {symbol} "
                f"notional=${notional:.2f}."
            )
        except Exception as exc:  # noqa: BLE001 - surface Alpaca errors clearly
            print(
                f"[ERROR] Alpaca notional order submission failed: {exc}",
                file=sys.stderr,
            )
            # TODO: pass a logger instead of print.
            raise

        # TODO: support limit orders and other TIFs later.
