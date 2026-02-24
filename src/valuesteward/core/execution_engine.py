"""Execution engine for Value Steward intents."""

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import json
import os

from valuesteward.config import ValueStewardSettings, get_settings
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.models import IntentRecord, PortfolioSnapshot
from valuesteward.market_holidays import ensure_holiday_file

EXEC_STATE_PATH = Path("data/execution-state.json")
DEFAULT_HOLIDAYS = {
    # 2025 NYSE holidays
    "2025-01-01",
    "2025-01-20",
    "2025-02-17",
    "2025-04-18",
    "2025-05-26",
    "2025-06-19",
    "2025-07-04",
    "2025-09-01",
    "2025-11-27",
    "2025-12-25",
    # 2026 NYSE holidays
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25",
    # 2027 NYSE holidays
    "2027-01-01",
    "2027-01-18",
    "2027-02-15",
    "2027-03-26",
    "2027-05-31",
    "2027-06-18",
    "2027-07-05",
    "2027-09-06",
    "2027-11-25",
    "2027-12-24",
}


def _load_exec_state() -> dict:
    if not EXEC_STATE_PATH.exists():
        return {}
    try:
        return json.loads(EXEC_STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _save_exec_state(state: dict) -> None:
    EXEC_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EXEC_STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _get_exec_limit() -> int | None:
    raw = os.getenv("VS_MAX_EXECUTIONS_PER_DAY")
    if raw is None or not raw.strip():
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _get_market_timezone() -> ZoneInfo:
    tz = os.getenv("VS_EXECUTION_TIMEZONE") or "America/New_York"
    try:
        return ZoneInfo(tz)
    except Exception:
        return ZoneInfo("America/New_York")


def _use_alpaca_clock() -> bool:
    raw = os.getenv("VS_USE_ALPACA_CLOCK", "true").strip().lower()
    return raw in {"1", "true", "yes", "y"}


def _load_holiday_calendar() -> set[str]:
    if os.getenv("VS_MARKET_HOLIDAYS_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
    }:
        return set()
    path = os.getenv("VS_MARKET_HOLIDAYS_FILE", "data/market-holidays.json")
    auto_generate = os.getenv("VS_MARKET_HOLIDAYS_AUTO_GENERATE", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
    }
    if auto_generate:
        tz = os.getenv("VS_EXECUTION_TIMEZONE") or "America/New_York"
        try:
            payload = ensure_holiday_file(path=path, years=2, tz=tz)
            if isinstance(payload, dict) and isinstance(payload.get("holidays"), list):
                return {str(item) for item in payload["holidays"]}
        except Exception:
            pass
    try:
        holiday_path = Path(path)
        if holiday_path.exists():
            payload = json.loads(holiday_path.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                return {str(item) for item in payload}
            if isinstance(payload, dict) and isinstance(payload.get("holidays"), list):
                return {str(item) for item in payload["holidays"]}
    except Exception:
        return set(DEFAULT_HOLIDAYS)
    return set(DEFAULT_HOLIDAYS)


def _is_market_holiday(now: datetime) -> tuple[bool, str]:
    holidays = _load_holiday_calendar()
    today = now.date().isoformat()
    if not holidays:
        return False, "holiday_check=disabled"
    if today in holidays:
        return True, f"holiday_date={today}"
    return False, f"holiday_date={today}"


def _parse_market_time(value: str | None, default_hour: int, default_minute: int) -> tuple[int, int]:
    if not value:
        return default_hour, default_minute
    parts = value.strip().split(":")
    if len(parts) != 2:
        return default_hour, default_minute
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError:
        return default_hour, default_minute
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return default_hour, default_minute
    return hour, minute


def _get_market_open_close() -> tuple[tuple[int, int], tuple[int, int]]:
    open_raw = os.getenv("VS_MARKET_OPEN_TIME")
    close_raw = os.getenv("VS_MARKET_CLOSE_TIME")
    open_time = _parse_market_time(open_raw, 9, 30)
    close_time = _parse_market_time(close_raw, 16, 0)
    return open_time, close_time


def _is_market_open_now(now: datetime | None = None) -> bool:
    tz = _get_market_timezone()
    now = now or datetime.now(tz=tz)
    now = now.astimezone(tz)
    if now.weekday() >= 5:
        return False
    is_holiday, _ = _is_market_holiday(now)
    if is_holiday:
        return False
    (open_h, open_m), (close_h, close_m) = _get_market_open_close()
    open_dt = now.replace(hour=open_h, minute=open_m, second=0, microsecond=0)
    close_dt = now.replace(hour=close_h, minute=close_m, second=0, microsecond=0)
    return open_dt <= now <= close_dt


def _is_market_open_via_alpaca(alpaca_client: AlpacaClient) -> tuple[bool | None, str]:
    try:
        clock = alpaca_client.get_clock()
    except Exception as exc:  # noqa: BLE001 - surface Alpaca errors clearly
        return None, f"alpaca_clock_error={exc}"
    is_open = getattr(clock, "is_open", None)
    next_open = getattr(clock, "next_open", None)
    next_close = getattr(clock, "next_close", None)
    detail = f"alpaca_clock is_open={is_open} next_open={next_open} next_close={next_close}"
    return bool(is_open) if is_open is not None else None, detail


def _print_execution_debug(
    intent: IntentRecord,
    snapshot: PortfolioSnapshot,
    risk_governor: RiskGovernor,
    policy: dict,
    market_detail: str,
    daily_limit: int | None,
    daily_allowed: bool,
    risk_ok: bool | None,
) -> None:
    try:
        current = snapshot.risk_exposure_pct
        target = intent.target_exposure_pct
        buffer = intent.buffer_pct
        size_pct = intent.size_pct or 0.0
        post_risk = current + size_pct
        plan_count = len(intent.actions or [])
        plan_total = sum(action.notional for action in intent.actions or [])
        tz = _get_market_timezone()
        now = datetime.now(tz=tz)
        is_holiday, holiday_note = _is_market_holiday(now)
        print(
            "[EXEC-DEBUG] "
            f"mode={intent.mode.value} action={intent.action_type} "
            f"symbol={intent.symbol or '-'} reason={intent.reason_code or '-'}"
        )
        if plan_count:
            print(
                "[EXEC-DEBUG] "
                f"plan_actions={plan_count} plan_notional=${plan_total:.2f}"
            )
        print(
            "[EXEC-DEBUG] "
            f"current={current:.2%} target={target:.2%} buffer={buffer:.2%} "
            f"size_pct={size_pct:.2%} post={post_risk:.2%}"
        )
        print(
            "[EXEC-DEBUG] "
            f"caps=max_risk={risk_governor.config.max_risk_exposure_pct:.2%} "
            f"max_pos={risk_governor.config.max_position_pct:.2%} "
            f"risk_ok={risk_ok}"
        )
        print(
            "[EXEC-DEBUG] "
            f"policy_force_no_trade={policy.get('trade_gate_overrides', {}).get('force_no_trade')} "
            f"daily_limit={daily_limit} daily_allowed={daily_allowed}"
        )
        print(
            f"[EXEC-DEBUG] market_check={market_detail} "
            f"holiday={is_holiday} {holiday_note}"
        )
        if intent.explanation:
            print(f"[EXEC-DEBUG] explanation={intent.explanation}")
    except Exception as exc:  # noqa: BLE001 - avoid breaking execution on debug
        print(f"[EXEC-DEBUG] failed to render debug: {exc}")


def _today_in_market_tz(now: datetime | None = None) -> str:
    tz = _get_market_timezone()
    now = now or datetime.now(tz=tz)
    return now.astimezone(tz).date().isoformat()


def _execution_allowed_today() -> bool:
    max_per_day = _get_exec_limit()
    if max_per_day is None:
        return True
    if max_per_day <= 0:
        return False
    state = _load_exec_state()
    today = _today_in_market_tz()
    last_date = state.get("last_executed_date")
    count_today = state.get("count_today", 0) if last_date == today else 0
    return count_today < max_per_day


def _record_execution(action: str, symbol: str | None, order_count: int = 1) -> None:
    state = _load_exec_state()
    today = _today_in_market_tz()
    last_date = state.get("last_executed_date")
    count_today = state.get("count_today", 0) if last_date == today else 0
    state["last_executed_date"] = today
    state["count_today"] = count_today + 1
    state["last_executed_at"] = datetime.now(tz=_get_market_timezone()).isoformat()
    state["last_action"] = action
    state["last_symbol"] = symbol
    state["last_order_count"] = order_count
    _save_exec_state(state)


class ExecutionEngine:
    """Execute approved intents, respecting shadow mode."""

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

    def execute_intent(self, intent: IntentRecord, snapshot: PortfolioSnapshot) -> None:
        """Execute the supplied intent if allowed and not in shadow mode."""

        trade_gate = self.policy.get("trade_gate_overrides") or {}
        if trade_gate.get("force_no_trade"):
            reason = trade_gate.get("reason") or "policy_override"
            print(f"[EXEC] Policy trade gate forced no-trade: {reason}")
            return

        if intent.actions:
            market_detail = "fallback_time_check"
            is_open = None
            if _use_alpaca_clock():
                is_open, market_detail = _is_market_open_via_alpaca(self.alpaca_client)
            if is_open is None:
                tz = _get_market_timezone()
                now = datetime.now(tz=tz)
                (open_h, open_m), (close_h, close_m) = _get_market_open_close()
                open_str = f"{open_h:02d}:{open_m:02d}"
                close_str = f"{close_h:02d}:{close_m:02d}"
                is_open = _is_market_open_now(now)
                market_detail = (
                    f"time_window now={now.strftime('%Y-%m-%d %H:%M:%S %Z')} "
                    f"window={open_str}-{close_str} {tz}"
                )

            if is_open:
                tz = _get_market_timezone()
                now = datetime.now(tz=tz)
                is_holiday, holiday_note = _is_market_holiday(now)
                if is_holiday:
                    market_detail = f"{market_detail} {holiday_note}"
                    is_open = False

            daily_limit = _get_exec_limit()
            daily_allowed = _execution_allowed_today()

            _print_execution_debug(
                intent=intent,
                snapshot=snapshot,
                risk_governor=self.risk_governor,
                policy=self.policy,
                market_detail=market_detail,
                daily_limit=daily_limit,
                daily_allowed=daily_allowed,
                risk_ok=None,
            )

            if not is_open:
                print("[EXEC] Market closed; skipping order.")
                return

            if not _execution_allowed_today():
                max_per_day = _get_exec_limit()
                print(
                    "[EXEC] Daily execution limit reached "
                    f"(VS_MAX_EXECUTIONS_PER_DAY={max_per_day}); skipping order."
                )
                return

            if self.settings.shadow_mode:
                print("[EXEC] Shadow mode active; not submitting order.")
                return

            if not self.settings.execution_armed:
                print(
                    "[EXEC] Execution not armed (VS_EXECUTION_ARMED=false); "
                    "not submitting order."
                )
                return

            executed = 0
            for action in intent.actions:
                side = action.side.lower()
                if side not in {"buy", "sell"}:
                    continue
                notional = float(action.notional)
                if notional < self.settings.min_trade_notional_dollars:
                    continue
                if action.size_pct is not None and side == "buy":
                    if not self.risk_governor.check_trade_allowed(
                        snapshot, action.size_pct
                    ):
                        print(
                            f"[EXEC] Risk governor blocked {action.symbol}; skipping."
                        )
                        continue
                print(
                    f"[EXEC] Plan: {side.upper()} {action.symbol} "
                    f"notional=${notional:.2f}"
                )
                self.alpaca_client.submit_market_order(
                    symbol=action.symbol,
                    side=side,
                    notional=notional,
                )
                executed += 1

            if executed:
                _record_execution("MULTI", intent.symbol, executed)
            else:
                print("[EXEC] No valid actions to execute after filters.")
            return

        if intent.action_type in {"BUY", "SELL"}:
            risk_ok = None
            if intent.size_pct is not None:
                risk_ok = self.risk_governor.check_trade_allowed(
                    snapshot, intent.size_pct
                )

            market_detail = "fallback_time_check"
            is_open = None
            if _use_alpaca_clock():
                is_open, market_detail = _is_market_open_via_alpaca(self.alpaca_client)
            if is_open is None:
                tz = _get_market_timezone()
                now = datetime.now(tz=tz)
                (open_h, open_m), (close_h, close_m) = _get_market_open_close()
                open_str = f"{open_h:02d}:{open_m:02d}"
                close_str = f"{close_h:02d}:{close_m:02d}"
                is_open = _is_market_open_now(now)
                market_detail = (
                    f"time_window now={now.strftime('%Y-%m-%d %H:%M:%S %Z')} "
                    f"window={open_str}-{close_str} {tz}"
                )

            if is_open:
                tz = _get_market_timezone()
                now = datetime.now(tz=tz)
                is_holiday, holiday_note = _is_market_holiday(now)
                if is_holiday:
                    market_detail = f"{market_detail} {holiday_note}"
                    is_open = False

            daily_limit = _get_exec_limit()
            daily_allowed = _execution_allowed_today()

            _print_execution_debug(
                intent=intent,
                snapshot=snapshot,
                risk_governor=self.risk_governor,
                policy=self.policy,
                market_detail=market_detail,
                daily_limit=daily_limit,
                daily_allowed=daily_allowed,
                risk_ok=risk_ok,
            )

            if not is_open:
                print("[EXEC] Market closed; skipping order.")
                return

            if not _execution_allowed_today():
                max_per_day = _get_exec_limit()
                print(
                    "[EXEC] Daily execution limit reached "
                    f"(VS_MAX_EXECUTIONS_PER_DAY={max_per_day}); skipping order."
                )
                return
            if risk_ok is False:
                print("[EXEC] Risk governor blocked trade; skipping order.")
                return
            size_pct = intent.size_pct or 0.0
            print(
                f"[EXEC] Intent: {intent.action_type} {intent.symbol} "
                f"size_pct={size_pct:.2%} (pre_risk={intent.pre_risk_exposure_pct:.2%} "
                f"-> post_risk={intent.post_risk_exposure_pct:.2%})"
            )

            effective_equity = min(
                snapshot.equity, self.settings.max_effective_capital_dollars
            )
            raw_notional = effective_equity * size_pct
            notional = min(raw_notional, self.settings.max_trade_notional_dollars)
            print(
                "[EXEC] Notional sizing: "
                f"effective_capital=${effective_equity:.2f} "
                f"raw_notional=${raw_notional:.2f} "
                f"final_notional=${notional:.2f}"
            )

            if self.settings.shadow_mode:
                print("[EXEC] Shadow mode active; not submitting order.")
                return

            if not self.settings.execution_armed:
                print(
                    "[EXEC] Execution not armed (VS_EXECUTION_ARMED=false); "
                    "not submitting order."
                )
                return

            if intent.symbol is None or intent.size_pct is None:
                raise ValueError("BUY/SELL intents require symbol and size_pct.")

            side = "buy" if intent.action_type == "BUY" else "sell"
            if notional < self.settings.min_trade_notional_dollars:
                print(
                    "[EXEC] Notional ${:.2f} below minimum trade size; "
                    "skipping execution.".format(notional)
                )
                return

            self.alpaca_client.submit_market_order(
                symbol=intent.symbol,
                side=side,
                notional=notional,
            )
            _record_execution(intent.action_type, intent.symbol, 1)
            print(
                f"[EXEC] Notional order: ${notional:.2f} {intent.symbol} "
                f"(effective_capital=${effective_equity:.2f}, size_pct={size_pct:.2%})"
            )
            return

        if self.settings.shadow_mode:
            print("[SHADOW] Would execute intent:", intent.action_type)
        else:
            print("[EXECUTION] No actionable order for intent:", intent.action_type)
