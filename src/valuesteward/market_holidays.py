"""NYSE holiday calendar generator (offline fallback).

Generates a rolling two-year window by default, to avoid frequent updates.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """Return the date of the nth weekday in a month.

    weekday: Monday=0 ... Sunday=6
    n: 1..5
    """

    first = date(year, month, 1)
    days_to_weekday = (weekday - first.weekday()) % 7
    day = 1 + days_to_weekday + (n - 1) * 7
    return date(year, month, day)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """Return the date of the last weekday in a month."""

    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    last = next_month - timedelta(days=1)
    days_back = (last.weekday() - weekday) % 7
    return last - timedelta(days=days_back)


def _easter_sunday(year: int) -> date:
    """Compute Easter Sunday for the given year (Gregorian algorithm)."""

    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _observed_date(actual: date) -> date:
    """Apply NYSE-style observance for fixed-date holidays."""

    if actual.weekday() == 5:  # Saturday -> Friday
        return actual - timedelta(days=1)
    if actual.weekday() == 6:  # Sunday -> Monday
        return actual + timedelta(days=1)
    return actual


def generate_nyse_holidays(start_year: int, end_year: int) -> list[str]:
    """Generate NYSE full-day holidays for [start_year, end_year]."""

    holidays: set[date] = set()
    for year in range(start_year, end_year + 1):
        # Fixed-date holidays with observance.
        for month, day in [(1, 1), (6, 19), (7, 4), (12, 25)]:
            holidays.add(_observed_date(date(year, month, day)))

        # Floating holidays.
        holidays.add(_nth_weekday(year, 1, 0, 3))   # MLK Day (3rd Mon Jan)
        holidays.add(_nth_weekday(year, 2, 0, 3))   # Presidents Day (3rd Mon Feb)
        holidays.add(_last_weekday(year, 5, 0))     # Memorial Day (last Mon May)
        holidays.add(_nth_weekday(year, 9, 0, 1))   # Labor Day (1st Mon Sep)
        holidays.add(_nth_weekday(year, 11, 3, 4))  # Thanksgiving (4th Thu Nov)

        # Good Friday (2 days before Easter Sunday).
        easter = _easter_sunday(year)
        holidays.add(easter - timedelta(days=2))

    return sorted({d.isoformat() for d in holidays})


def _now_in_tz(tz: str) -> datetime:
    return datetime.now(tz=ZoneInfo(tz))


def build_calendar_payload(start_year: int, years: int, tz: str) -> dict:
    end_year = start_year + years - 1
    holidays = generate_nyse_holidays(start_year, end_year + 1)
    start = date(start_year, 1, 1)
    end = date(end_year, 12, 31)
    filtered = [d for d in holidays if start.isoformat() <= d <= end.isoformat()]
    return {
        "generated_at": _now_in_tz(tz).isoformat(),
        "years": [start_year, end_year],
        "timezone": tz,
        "holidays": filtered,
    }


def ensure_holiday_file(
    path: str | Path = "data/market-holidays.json",
    years: int = 2,
    tz: str = "America/New_York",
    max_age_days: int = 730,
) -> dict:
    """Ensure the holiday file exists and is fresh within max_age_days."""

    holiday_path = Path(path)
    now = _now_in_tz(tz)
    payload = None

    if holiday_path.exists():
        try:
            payload = json.loads(holiday_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            payload = None

    def is_stale(data: dict | None) -> bool:
        if not data or not isinstance(data, dict):
            return True
        generated_at = data.get("generated_at")
        if not generated_at:
            return True
        try:
            gen_ts = datetime.fromisoformat(str(generated_at))
        except ValueError:
            return True
        age_days = (now - gen_ts).days
        if age_days >= max_age_days:
            return True
        years_span = data.get("years")
        if (
            isinstance(years_span, list)
            and years_span
            and max(years_span) < now.year + 1
        ):
            return True
        return False

    if is_stale(payload):
        payload = build_calendar_payload(now.year, years, tz)
        holiday_path.parent.mkdir(parents=True, exist_ok=True)
        holiday_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    return payload or {}
