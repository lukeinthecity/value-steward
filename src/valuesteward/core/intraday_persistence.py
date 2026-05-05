"""Intraday candidate-persistence priors derived from observation snapshots."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path


DEFAULT_INTRADAY_OBSERVATIONS_PATH = Path("data/intraday-observations.jsonl")


@dataclass
class IntradayPersistencePrior:
    """Compact prior describing how persistently a symbol reappears intraday."""

    quality_score: float
    seen_count: int
    day_count: int


def _safe_lines(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            rows.append(payload)
    return rows


def _parse_exchange_date(value: object) -> date | None:
    try:
        if not value:
            return None
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def _candidate_matches_observation_day(
    candidate: dict,
    observation_date: date | None,
) -> bool:
    if observation_date is None:
        return True
    candidate_date = _parse_exchange_date(str(candidate.get("timestamp") or "")[:10])
    if candidate_date is None:
        return False
    return candidate_date == observation_date


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def load_intraday_persistence_map(
    symbols: list[str],
    *,
    observations_path: str | Path = DEFAULT_INTRADAY_OBSERVATIONS_PATH,
    lookback_days: int = 5,
) -> dict[str, IntradayPersistencePrior]:
    """Return a mild persistence prior for requested symbols.

    The prior rewards repeated candidate appearances across recent intraday
    observation snapshots. Unseen symbols remain neutral at 0.5.
    """

    wanted = {str(symbol).upper() for symbol in symbols if symbol}
    if not wanted:
        return {}

    rows = _safe_lines(Path(observations_path))
    exchange_dates = [
        parsed
        for parsed in (_parse_exchange_date(row.get("exchange_date")) for row in rows)
        if parsed is not None
    ]
    anchor_date = max(exchange_dates) if exchange_dates else None
    min_date = (
        anchor_date - timedelta(days=max(0, lookback_days - 1))
        if anchor_date is not None
        else None
    )

    counts: dict[str, int] = {symbol: 0 for symbol in wanted}
    day_sets: dict[str, set[str]] = {symbol: set() for symbol in wanted}

    for row in rows:
        row_date = _parse_exchange_date(row.get("exchange_date"))
        if min_date is not None and row_date is not None and row_date < min_date:
            continue
        seen_in_row: set[str] = set()
        for candidate in row.get("top_candidates") or []:
            if not isinstance(candidate, dict):
                continue
            if not _candidate_matches_observation_day(candidate, row_date):
                continue
            symbol = str((candidate or {}).get("symbol") or "").upper()
            if symbol in wanted:
                seen_in_row.add(symbol)
        for symbol in seen_in_row:
            counts[symbol] += 1
            if row_date is not None:
                day_sets[symbol].add(row_date.isoformat())

    priors: dict[str, IntradayPersistencePrior] = {}
    for symbol in wanted:
        seen_count = counts[symbol]
        day_count = len(day_sets[symbol])
        if seen_count == 0:
            priors[symbol] = IntradayPersistencePrior(
                quality_score=0.5,
                seen_count=0,
                day_count=0,
            )
            continue

        observation_component = min(1.0, seen_count / 4.0)
        day_component = min(1.0, day_count / max(1, lookback_days))
        quality_score = 0.5 + 0.35 * observation_component + 0.15 * day_component
        priors[symbol] = IntradayPersistencePrior(
            quality_score=_clamp(quality_score, 0.0, 1.0),
            seen_count=seen_count,
            day_count=day_count,
        )

    return priors
