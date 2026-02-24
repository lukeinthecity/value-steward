"""World context loader and macro classifier."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


REQUIRED_TAGS = [
    "macro_risk",
    "rate_hawkishness",
    "geopolitical_tension",
    "energy_shock_risk",
    "recession_fear",
]


def _safe_float(value: Any) -> Optional[float]:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num:  # NaN
        return None
    return num


def classify_macro_from_tags(tags: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not tags:
        return {
            "macro_score": None,
            "macro_label": "n/a",
            "inputs_used": [],
            "null_count": len(REQUIRED_TAGS),
            "confidence": 0,
            "coverage_note": "no tag signals",
        }

    values: Dict[str, float] = {}
    null_count = 0
    for key in REQUIRED_TAGS:
        raw = tags.get(key)
        if raw is None:
            null_count += 1
            values[key] = 0.0
        else:
            parsed = _safe_float(raw)
            if parsed is None:
                null_count += 1
                values[key] = 0.0
            else:
                values[key] = parsed

    raw_score = (
        values["macro_risk"] * 0.4
        + values["recession_fear"] * 0.3
        + values["geopolitical_tension"] * 0.15
        + values["energy_shock_risk"] * 0.15
    )
    macro_score = max(0.0, min(1.0, raw_score))

    if macro_score >= 0.8:
        macro_label = "crisis-prone"
    elif macro_score >= 0.6:
        macro_label = "stressed"
    elif macro_score >= 0.3:
        macro_label = "watchful"
    else:
        macro_label = "calm"

    inputs_used = [
        key
        for key in REQUIRED_TAGS
        if tags.get(key) is not None and _safe_float(tags.get(key)) is not None
    ]
    coverage = len(inputs_used) / len(REQUIRED_TAGS)

    if len(inputs_used) == 0:
        confidence = 0.0
        coverage_note = "no tag signals"
    elif coverage < 0.4:
        confidence = 0.3
        coverage_note = "very sparse tags"
    elif coverage < 0.8:
        confidence = 0.7
        coverage_note = "partial coverage"
    else:
        confidence = 1.0
        coverage_note = "full coverage"

    return {
        "macro_score": macro_score,
        "macro_label": macro_label,
        "inputs_used": inputs_used,
        "null_count": null_count,
        "confidence": confidence,
        "coverage_note": coverage_note,
    }


def load_latest_world_context(
    path: Path | str = Path("data/world-context.jsonl"),
) -> Optional[Dict[str, Any]]:
    context_path = Path(path)
    if not context_path.exists():
        return None

    raw = context_path.read_text(encoding="utf-8").strip()
    if not raw:
        return None

    entries: List[Dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    if not entries:
        return None

    def sort_key(entry: Dict[str, Any]) -> tuple:
        date = entry.get("date") or ""
        generated_at = entry.get("generated_at")
        try:
            gen_ts = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
        except Exception:
            gen_ts = datetime.fromtimestamp(0, tz=timezone.utc)
        return (str(date), gen_ts)

    latest = sorted(
        [entry for entry in entries if entry.get("generated_at")],
        key=sort_key,
    )[-1]

    macro_view = classify_macro_from_tags(latest.get("tags"))
    latest["macro_view"] = macro_view
    return latest


def world_context_age_minutes(world_context: Optional[Dict[str, Any]]) -> Optional[float]:
    if not world_context or not world_context.get("generated_at"):
        return None
    try:
        ts = datetime.fromisoformat(
            world_context["generated_at"].replace("Z", "+00:00")
        )
    except Exception:
        return None
    delta = datetime.now(tz=timezone.utc) - ts.astimezone(timezone.utc)
    return delta.total_seconds() / 60.0
