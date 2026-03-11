"""Reporting helpers for intent history."""

from __future__ import annotations

from statistics import mean
from typing import Any, Dict, List

from valuesteward.models import IntentRecord


def build_report(intents: List[IntentRecord]) -> Dict[str, Any]:
    """Compute summary statistics for a list of intents."""

    total = len(intents)
    counts = {"NO_ACTION": 0, "BUY": 0, "SELL": 0}
    for intent in intents:
        if intent.action_type in counts:
            counts[intent.action_type] += 1

    buy_sell_intents = [
        intent
        for intent in intents
        if intent.action_type in {"BUY", "SELL"}
    ]
    avg_pre_trade_exposure = (
        mean(intent.pre_risk_exposure_pct for intent in buy_sell_intents)
        if buy_sell_intents
        else None
    )

    latest = intents[-1] if intents else None
    if latest:
        latest_mode = latest.mode.value
        latest_core_symbol = latest.core_symbol or latest.symbol or "-"
        latest_target = latest.target_risk_exposure_pct
        latest_buffer = latest.rebalance_buffer_pct
        latest_pre = latest.pre_risk_exposure_pct
        latest_post = latest.post_risk_exposure_pct
        latest_reason = latest.reason_code or "-"
    else:
        latest_mode = "-"
        latest_core_symbol = "-"
        latest_target = None
        latest_buffer = None
        latest_pre = 0.0
        latest_post = 0.0
        latest_reason = "-"

    def pct(count: int) -> float:
        return (count / total) * 100 if total > 0 else 0.0

    return {
        "total": total,
        "no_action_count": counts["NO_ACTION"],
        "buy_count": counts["BUY"],
        "sell_count": counts["SELL"],
        "no_action_pct": pct(counts["NO_ACTION"]),
        "buy_pct": pct(counts["BUY"]),
        "sell_pct": pct(counts["SELL"]),
        "avg_pre_trade_exposure": avg_pre_trade_exposure,
        "mode": latest_mode,
        "core_symbol": latest_core_symbol,
        "target_exposure_pct": latest_target,
        "buffer_pct": latest_buffer,
        "latest_pre_risk": latest_pre,
        "latest_post_risk": latest_post,
        "latest_reason": latest_reason,
    }
