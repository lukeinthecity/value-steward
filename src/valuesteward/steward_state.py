"""Unified system state for Value Steward with cross-process safety."""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from datetime import date as date_cls
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

STATE_PATH = Path("data/steward-state.json")
STATE_LOCK_PATH = Path(f"{STATE_PATH}.lock")
LOCK_TIMEOUT_SEC = float(os.getenv("VS_STATE_LOCK_TIMEOUT_MS", "5000")) / 1000.0
LOCK_STALE_SEC = float(os.getenv("VS_STATE_LOCK_STALE_MS", "15000")) / 1000.0
LOCK_RETRY_SEC = float(os.getenv("VS_STATE_LOCK_RETRY_MS", "25")) / 1000.0


def _default_state() -> dict[str, Any]:
    return {
        "current_mode": "INACTIVE",
        "last_run_at": None,
        "last_mode_transition_reason": "initial_boot",
        "last_known_positions": [],
        "trading_enabled": True,
        "force_no_trade": False,
        "control_reason": None,
        "control_updated_at": None,
        "daily_starting_equity": None,
        "last_equity_reset_date": None,
        "executions_today": 0,
        "last_executed_date": None,
        "last_executed_at": None,
        "last_health_email_at": None,
        "last_health_email_date": None,
        "phase1_start_date": None,
        "phase1_milestones_sent": [],
        "phase1_ready_notified": False,
        "last_eod_email_date": None,
        "version": 1,
    }


def _normalize_state(data: dict[str, Any] | None = None) -> dict[str, Any]:
    source = data if isinstance(data, dict) else {}
    state = {**_default_state(), **source}
    milestones = state.get("phase1_milestones_sent") or []
    if isinstance(milestones, list):
        cleaned = sorted(
            {
                int(value)
                for value in milestones
                if isinstance(value, (int, float)) and value > 0
            }
        )
        state["phase1_milestones_sent"] = cleaned
    else:
        state["phase1_milestones_sent"] = []
    state["phase1_ready_notified"] = bool(state.get("phase1_ready_notified"))
    if state.get("phase1_start_date") is not None and not isinstance(
        state.get("phase1_start_date"), str
    ):
        state["phase1_start_date"] = None
    return state


def _market_timezone() -> ZoneInfo:
    tz = os.getenv("VS_MARKET_TIMEZONE") or "America/New_York"
    try:
        return ZoneInfo(tz)
    except Exception:
        return ZoneInfo("America/New_York")


def _coerce_exchange_date(value: Any) -> date_cls | None:
    if value is None:
        return None
    if isinstance(value, date_cls) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(_market_timezone()).date()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if len(raw) == 10:
            try:
                return date_cls.fromisoformat(raw)
            except ValueError:
                return None
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_market_timezone()).date()
    return None


def _read_state_unlocked() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {}
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def _write_state_unlocked(state: dict[str, Any]) -> None:
    payload = _normalize_state(state)
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = STATE_PATH.with_name(
        f"{STATE_PATH.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp_path, STATE_PATH)


@contextmanager
def _state_lock():
    deadline = time.monotonic() + LOCK_TIMEOUT_SEC
    while True:
        try:
            STATE_LOCK_PATH.mkdir()
            break
        except FileExistsError:
            try:
                age = time.time() - STATE_LOCK_PATH.stat().st_mtime
                if age > LOCK_STALE_SEC:
                    STATE_LOCK_PATH.rmdir()
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out acquiring state lock for {STATE_PATH}")
            time.sleep(LOCK_RETRY_SEC)
    try:
        yield
    finally:
        try:
            STATE_LOCK_PATH.rmdir()
        except OSError:
            pass


def load_steward_state() -> dict[str, Any]:
    """Load state with retries to tolerate concurrent atomic renames."""
    for i in range(3):
        try:
            return _normalize_state(_read_state_unlocked())
        except (json.JSONDecodeError, PermissionError, FileNotFoundError):
            if i == 2:
                break
            time.sleep(0.05 * (i + 1))
    return _normalize_state({})


def save_steward_state(state: dict[str, Any]) -> None:
    """Save a complete state payload under a cross-process lock."""
    with _state_lock():
        _write_state_unlocked(state)


def update_steward_state(
    mutator: Callable[[dict[str, Any]], dict[str, Any] | None]
) -> dict[str, Any]:
    """Read-modify-write state under a cross-process lock."""
    with _state_lock():
        current = _normalize_state(_read_state_unlocked())
        draft = dict(current)
        updated = mutator(draft)
        next_state = draft if updated is None else updated
        payload = _normalize_state(next_state)
        _write_state_unlocked(payload)
        return payload


def get_phase1_start_date(state: dict[str, Any] | None = None) -> date_cls | None:
    current = _normalize_state(state) if state is not None else load_steward_state()
    return _coerce_exchange_date(
        current.get("phase1_start_date") or os.getenv("VS_PHASE1_START_DATE")
    )


def is_on_or_after_phase1_start(
    value: Any, state: dict[str, Any] | None = None
) -> bool:
    candidate = _coerce_exchange_date(value)
    if candidate is None:
        return False
    start = get_phase1_start_date(state)
    return start is None or candidate >= start
