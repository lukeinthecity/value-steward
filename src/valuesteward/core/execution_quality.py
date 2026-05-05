"""Execution-quality helpers for symbol ranking."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


@dataclass
class ExecutionQualityStats:
    """Local execution-quality evidence for one symbol."""

    quality_score: float = 0.5
    submission_rate: float = 0.5
    fill_rate: float = 0.5
    expire_rate: float = 0.0
    repeat_attempt_penalty: float = 0.0
    submitted_orders: int = 0
    filled_orders: int = 0
    expired_or_canceled_orders: int = 0
    buy_intents: int = 0


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _iter_jsonl(path: Path) -> Iterable[dict]:
    if not path.exists():
        return []
    records: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return records


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except ValueError:
        return None


def load_execution_quality_map(
    symbols: Iterable[str],
    *,
    portfolio_path: str = "data/portfolio-live.json",
    intent_log_path: str = "logs/intent_log.jsonl",
    lookback_days: int = 30,
) -> dict[str, ExecutionQualityStats]:
    """Build per-symbol execution stats from recent local evidence."""

    symbol_set = {str(symbol).upper() for symbol in symbols if symbol}
    if not symbol_set:
        return {}

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=lookback_days)
    portfolio = _load_json(Path(portfolio_path))
    recent_orders = portfolio.get("recent_orders") or []

    submitted_by_symbol = {symbol: 0 for symbol in symbol_set}
    filled_by_symbol = {symbol: 0 for symbol in symbol_set}
    expired_by_symbol = {symbol: 0 for symbol in symbol_set}

    for order in recent_orders:
        symbol = str(order.get("symbol") or "").upper()
        if symbol not in symbol_set:
            continue
        order_ts = _parse_ts(order.get("submitted_at")) or _parse_ts(order.get("filled_at"))
        if order_ts and order_ts < cutoff:
            continue
        submitted_by_symbol[symbol] += 1
        status = str(order.get("status") or "").strip().lower()
        if status in {"filled", "partially_filled"} or order.get("filled_at"):
            filled_by_symbol[symbol] += 1
        if status in {"expired", "canceled", "cancelled", "rejected"}:
            expired_by_symbol[symbol] += 1

    buy_intents_by_symbol = {symbol: 0 for symbol in symbol_set}
    for intent in _iter_jsonl(Path(intent_log_path)):
        action_type = str(intent.get("action_type") or "").upper()
        if action_type != "BUY":
            continue
        intent_ts = _parse_ts(intent.get("timestamp"))
        if intent_ts and intent_ts < cutoff:
            continue
        symbol = str(
            intent.get("signal_symbol")
            or intent.get("symbol")
            or intent.get("core_symbol")
            or ""
        ).upper()
        if symbol in symbol_set:
            buy_intents_by_symbol[symbol] += 1

    stats: dict[str, ExecutionQualityStats] = {}
    for symbol in symbol_set:
        submitted = submitted_by_symbol[symbol]
        filled = filled_by_symbol[symbol]
        expired = expired_by_symbol[symbol]
        buy_intents = buy_intents_by_symbol[symbol]

        if submitted == 0 and buy_intents == 0:
            stats[symbol] = ExecutionQualityStats()
            continue

        fill_rate = filled / submitted if submitted else 0.5
        expire_rate = expired / submitted if submitted else 0.0
        submission_rate = submitted / buy_intents if buy_intents else 0.5
        repeat_attempt_penalty = (
            max(0, buy_intents - submitted) / buy_intents if buy_intents else 0.0
        )
        quality_score = (
            0.35 * fill_rate
            + 0.20 * (1.0 - expire_rate)
            + 0.20 * submission_rate
            + 0.25 * (1.0 - repeat_attempt_penalty)
        )
        stats[symbol] = ExecutionQualityStats(
            quality_score=max(0.0, min(1.0, quality_score)),
            submission_rate=submission_rate,
            fill_rate=fill_rate,
            expire_rate=expire_rate,
            repeat_attempt_penalty=repeat_attempt_penalty,
            submitted_orders=submitted,
            filled_orders=filled,
            expired_or_canceled_orders=expired,
            buy_intents=buy_intents,
        )

    return stats
