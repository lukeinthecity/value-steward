"""Unified system state for Value Steward with professional race-condition protection."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_PATH = Path("data/steward-state.json")

def load_steward_state() -> dict[str, Any]:
    """Load state with professional retry logic to handle concurrent writes."""
    default: dict[str, Any] = {
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
        "version": 1,
    }
    
    if not STATE_PATH.exists():
        return default
    
    for i in range(3):
        try:
            data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            return {**default, **data}
        except (json.JSONDecodeError, PermissionError):
            if i == 2:
                break
            time.sleep(0.05 * (i + 1))
            
    return default

def save_steward_state(state: dict[str, Any]) -> None:
    """Save state using Atomic Rename pattern to prevent file corruption."""
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    
    tmp_path = STATE_PATH.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    
    # Atomic replace
    os.replace(tmp_path, STATE_PATH)
