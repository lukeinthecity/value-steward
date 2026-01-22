"""Repository for assembling portfolio snapshots."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.config import get_settings
from valuesteward.models import PortfolioSnapshot, Position


class PortfolioRepository:
    """Fetch and compute portfolio state.

    v0 uses a simple definition of risk: all non-cash positions are risk assets.
    """

    def __init__(self, alpaca_client: Optional[AlpacaClient] = None) -> None:
        self.alpaca_client = alpaca_client or AlpacaClient()

    def get_current_snapshot(self) -> PortfolioSnapshot:
        """Return a PortfolioSnapshot with basic risk exposure computed."""

        settings = get_settings()
        try:
            snapshot = self.alpaca_client.get_portfolio_snapshot()
        except Exception as exc:  # noqa: BLE001 - fallback for shadow mode only
            if not settings.shadow_mode:
                raise
            print(f"[WARN] Falling back to empty snapshot in shadow mode: {exc}")
            return PortfolioSnapshot(
                timestamp=datetime.utcnow(),
                cash=0.0,
                equity=0.0,
                positions=[],
                risk_exposure_pct=0.0,
            )
        total_position_value = sum(pos.market_value for pos in snapshot.positions)
        total_equity = snapshot.equity or (snapshot.cash + total_position_value)
        risk_exposure_pct = (
            total_position_value / total_equity if total_equity > 0 else 0.0
        )
        data = snapshot.dict()
        data["risk_exposure_pct"] = risk_exposure_pct
        return PortfolioSnapshot(**data)

    def get_position_for_symbol(
        self, snapshot: PortfolioSnapshot, symbol: str
    ) -> Position | None:
        """Return the Position for the given symbol, or None if not held."""

        for position in snapshot.positions:
            if position.symbol == symbol:
                return position
        return None
