"""Execution engine for Value Steward intents."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import os
import logging
from typing import Literal, cast

from valuesteward.config import ValueStewardSettings, get_settings
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.models import IntentRecord, PortfolioSnapshot
from valuesteward.steward_state import load_steward_state, update_steward_state

logger = logging.getLogger(__name__)

def _get_market_timezone() -> ZoneInfo:
    tz = (
        os.getenv("VS_EXECUTION_TIMEZONE")
        or os.getenv("VS_MARKET_TIMEZONE")
        or "America/New_York"
    )
    try:
        return ZoneInfo(tz)
    except Exception:
        return ZoneInfo("America/New_York")

def _today_in_market_tz(now: datetime | None = None) -> str:
    tz = _get_market_timezone()
    now = now or datetime.now(tz=tz)
    return now.astimezone(tz).date().isoformat()


def _parse_hhmm(value: str | None, default_hour: int, default_minute: int) -> tuple[int, int]:
    if not value:
        return default_hour, default_minute
    try:
        hour_str, minute_str = str(value).strip().split(":", 1)
        hour = int(hour_str)
        minute = int(minute_str)
    except Exception:
        return default_hour, default_minute
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return default_hour, default_minute
    return hour, minute


def _market_close_time(now: datetime) -> datetime | None:
    from valuesteward.market_holidays import ensure_holiday_file

    tz = _get_market_timezone()
    local_now = now.astimezone(tz)
    today_str = local_now.date().isoformat()

    if local_now.weekday() >= 5:
        return None

    holidays = ensure_holiday_file()
    if today_str in (holidays.get("holidays") or []):
        return None

    close_hour, close_minute = _parse_hhmm(
        os.getenv("VS_MARKET_CLOSE_TIME"),
        16,
        0,
    )
    for entry in holidays.get("early_closes") or []:
        if entry.get("date") == today_str:
            close_hour, close_minute = _parse_hhmm(
                entry.get("close_time"),
                close_hour,
                close_minute,
            )
            break

    return local_now.replace(
        hour=close_hour,
        minute=close_minute,
        second=0,
        microsecond=0,
    )

def _is_market_open_now(snapshot: PortfolioSnapshot | None = None) -> bool:
    """Check if NYSE market is currently open (9:30 AM - 4:00 PM ET, non-holiday)."""
    from valuesteward.market_holidays import ensure_holiday_file
    
    tz = _get_market_timezone()
    now = datetime.now(tz=tz)
    
    # 1. Weekends
    if now.weekday() >= 5:
        return False
        
    # 2. Market Hours (9:30 AM to 4:00 PM ET)
    market_open = now.replace(hour=9, minute=30, second=0, microsecond=0)
    market_close = now.replace(hour=16, minute=0, second=0, microsecond=0)
    
    if not (market_open <= now <= market_close):
        return False
        
    # 3. Holidays & Early Closes
    holidays = ensure_holiday_file()
    today_str = now.date().isoformat()
    
    if today_str in (holidays.get("holidays") or []):
        return False
        
    for ec in (holidays.get("early_closes") or []):
        if ec.get("date") == today_str:
            # Parse early close time (usually 13:00)
            ec_time = ec.get("close_time", "13:00").split(":")
            ec_close = now.replace(
                hour=int(ec_time[0]), minute=int(ec_time[1]), second=0, microsecond=0
            )
            if now > ec_close:
                return False
                
    return True

class ExecutionEngine:
    """Execute approved intents, respecting shadow mode and unified state."""

    def __init__(
        self,
        alpaca_client: AlpacaClient,
        risk_governor: RiskGovernor,
        settings: ValueStewardSettings | None = None,
        policy: dict | None = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.risk_governor = risk_governor
        self.settings = settings or get_settings()
        self.policy = policy or {}

    def check_circuit_breaker(self, snapshot: PortfolioSnapshot) -> tuple[bool, str]:
        """Return (True, ok) if account equity is within safe daily limits."""
        state = load_steward_state()
        today = _today_in_market_tz()
        
        last_reset = state.get("last_equity_reset_date")
        starting_equity = state.get("daily_starting_equity")

        if last_reset != today or starting_equity is None:
            starting_equity = snapshot.equity
            update_steward_state(
                lambda current: {
                    **current,
                    "daily_starting_equity": starting_equity,
                    "last_equity_reset_date": today,
                }
            )
            return True, "baseline_captured"

        if starting_equity <= 0:
            return True, "invalid_baseline"

        loss_pct = (snapshot.equity / starting_equity) - 1.0
        threshold = -abs(self.settings.max_daily_loss_pct)

        if loss_pct < threshold:
            return False, (
                f"DAILY_LOSS_LIMIT: {loss_pct:.2%} exceeds {threshold:.2%} "
                f"(Start: ${starting_equity:,.2f})"
            )

        return True, "ok"

    def _record_execution(self, action: str, symbol: str | None, count: int = 1):
        today = _today_in_market_tz()
        executed_at = datetime.now(timezone.utc).isoformat()

        def mutate(state: dict) -> dict:
            if state.get("last_executed_date") != today:
                state["executions_today"] = 0
            state["last_executed_date"] = today
            state["executions_today"] = state.get("executions_today", 0) + count
            state["last_executed_at"] = executed_at
            return state

        update_steward_state(mutate)

    def is_in_execution_window(self) -> bool:
        """Check if current time is within the final execution window before market close."""
        tz = _get_market_timezone()
        now = datetime.now(tz=tz)

        market_close = _market_close_time(now)
        if market_close is None:
            return False

        try:
            start_before_close = int(
                os.getenv("VS_EXECUTION_WINDOW_START_MINUTES_BEFORE_CLOSE", "30")
            )
        except ValueError:
            start_before_close = 30
        try:
            end_before_close = int(
                os.getenv("VS_EXECUTION_WINDOW_END_MINUTES_BEFORE_CLOSE", "5")
            )
        except ValueError:
            end_before_close = 5

        window_start = market_close - timedelta(minutes=start_before_close)
        window_end = market_close - timedelta(minutes=end_before_close)
        return window_start <= now <= window_end

    def execute_intent(self, intent: IntentRecord, snapshot: PortfolioSnapshot) -> None:
        state = load_steward_state()
        if state.get("force_no_trade"):
            logger.warning(f"[EXEC] System halted: {state.get('control_reason')}")
            return
        if not state.get("trading_enabled", True):
            logger.info("[EXEC] Trading disabled in state.")
            return

        # --- Professional Hardening: Execution Window Guard ---
        if intent.action_type in {"BUY", "SELL"} or intent.actions:
            if not self.is_in_execution_window():
                logger.warning(
                    f"[EXEC-GATE] Action {intent.action_type} blocked: "
                    "outside the configured execution window before market close."
                )
                return
        # ------------------------------------------------------

        # --- Professional Hardening: Equity Guard ---
        if snapshot.equity <= 0:
            logger.error(
                f"[EXEC] Total Equity is zero or negative (${snapshot.equity:,.2f}). "
                "Aborting execution."
            )
            return
        # --------------------------------------------

        breaker_ok, breaker_msg = self.check_circuit_breaker(snapshot)
        if not breaker_ok:
            logger.warning(f"[EXEC-HALT] {breaker_msg}")
            return

        open_orders = self.alpaca_client.get_open_orders()
        deployed_notional = self._current_deployed_notional(snapshot)

        # --- MULTI ACTION BLOCK ---
        if intent.actions:
            executed = 0
            for action in intent.actions:
                symbol = action.symbol
                
                # --- Elite Quant: Capital Clamping ---
                raw_notional = float(action.notional)
                effective_notional = min(raw_notional, self.settings.max_effective_capital_dollars)
                target_notional = min(effective_notional, self.settings.max_trade_notional_dollars)
                # ------------------------------------

                side = action.side.lower()
                if side == "buy":
                    target_notional = self._clamp_to_sandbox_headroom(
                        target_notional,
                        deployed_notional,
                    )
                    if target_notional < self.settings.min_trade_notional_dollars:
                        logger.info(
                            "[EXEC] MULTI buy blocked by sandbox cap. "
                            f"deployed=${deployed_notional:.2f} "
                            f"max=${self.settings.max_sandbox_deployed_dollars:.2f}"
                        )
                        continue
                
                # Check for partial fills
                remaining_notional = target_notional
                for order in open_orders:
                    if order.symbol == symbol:
                        filled_qty = float(order.filled_qty or 0)
                        if filled_qty > 0:
                            # Use position-based price for better fallback
                            pos = next((p for p in snapshot.positions if p.symbol == symbol), None)
                            avg_price = float(order.filled_avg_price or 0)
                            if avg_price <= 0 and pos and pos.quantity != 0:
                                avg_price = pos.market_value / pos.quantity
                            
                            if avg_price > 0:
                                remaining_notional -= (filled_qty * avg_price)
                                logger.info(
                                    f"[EXEC] MULTI: Partial fill for {symbol}: "
                                    f"${filled_qty*avg_price:.2f} already processed."
                                )
                        
                        self.alpaca_client.cancel_open_orders(symbol)

                if remaining_notional < self.settings.min_trade_notional_dollars:
                    continue

                if self.settings.shadow_mode or not self.settings.execution_armed:
                    logger.info(
                        f"[EXEC] MULTI Would trade {symbol} notional=${remaining_notional:.2f}"
                    )
                    continue

                price = self.alpaca_client.submit_steward_order(
                    symbol=symbol,
                    side=cast(Literal["buy", "sell"], side),
                    notional=round(remaining_notional, 2),
                )
                if price:
                    action.reason = f"{action.reason or ''} mid_price={price:.2f}".strip()
                if side == "buy":
                    deployed_notional += remaining_notional
                elif side == "sell":
                    deployed_notional = max(
                        deployed_notional - remaining_notional,
                        0.0,
                    )
                executed += 1
            
            if executed:
                self._record_execution("MULTI", None, executed)
            return

        # --- SINGLE ACTION BLOCK ---
        if intent.action_type in {"BUY", "SELL"}:
            intent_symbol = intent.symbol
            if not intent_symbol:
                return
            target_symbol: str = intent_symbol

            # --- Elite Quant: Capital Clamping ---
            raw_notional = (intent.size_pct or 0.0) * snapshot.equity
            effective_notional = min(
                raw_notional, self.settings.max_effective_capital_dollars
            )
            target_notional = min(
                effective_notional, self.settings.max_trade_notional_dollars
            )
            # ------------------------------------

            pos = next((p for p in snapshot.positions if p.symbol == target_symbol), None)
            
            if intent.action_type == "SELL":
                if pos:
                    target_notional = min(target_notional, pos.market_value)
                else:
                    return
            else:
                target_notional = self._clamp_to_sandbox_headroom(
                    target_notional,
                    deployed_notional,
                )
                if target_notional < self.settings.min_trade_notional_dollars:
                    logger.info(
                        "[EXEC] Buy blocked by sandbox cap. "
                        f"deployed=${deployed_notional:.2f} "
                        f"max=${self.settings.max_sandbox_deployed_dollars:.2f}"
                    )
                    return

            remaining_notional = target_notional
            for order in open_orders:
                if order.symbol == target_symbol:
                    filled_qty = float(order.filled_qty or 0)
                    if filled_qty > 0:
                        avg_price = float(order.filled_avg_price or 0)
                        if avg_price <= 0 and pos and pos.quantity != 0:
                            avg_price = pos.market_value / pos.quantity
                        
                        if avg_price > 0:
                            remaining_notional -= (filled_qty * avg_price)
                            logger.info(
                                f"[EXEC] Partial fill for {target_symbol}: "
                                f"${filled_qty*avg_price:.2f} processed."
                            )
                    
                    self.alpaca_client.cancel_open_orders(target_symbol)

            if remaining_notional < self.settings.min_trade_notional_dollars:
                logger.info(
                    f"[EXEC] Remaining notional for {target_symbol} "
                    f"too small (${remaining_notional:.2f}); skipping."
                )
                return

            if self.settings.shadow_mode or not self.settings.execution_armed:
                logger.info(
                    f"[EXEC] Would trade {target_symbol} notional=${remaining_notional:.2f}"
                )
                return

            price = self.alpaca_client.submit_steward_order(
                symbol=target_symbol,
                side="buy" if intent.action_type == "BUY" else "sell",
                notional=round(remaining_notional, 2)
            )
            intent.expected_price = price
            self._record_execution(intent.action_type, target_symbol)

    def _current_deployed_notional(self, snapshot: PortfolioSnapshot) -> float:
        return sum(
            max(float(position.market_value), 0.0)
            for position in snapshot.positions
        )

    def _clamp_to_sandbox_headroom(
        self,
        target_notional: float,
        deployed_notional: float,
    ) -> float:
        remaining_headroom = max(
            self.settings.max_sandbox_deployed_dollars - deployed_notional,
            0.0,
        )
        return min(target_notional, remaining_headroom)
