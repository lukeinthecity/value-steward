"""World context loader and macro classifier with high-volume optimization."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def _safe_float(value: Any) -> Optional[float]:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num:  # NaN
        return None
    return num


def _load_macro_policy() -> Dict[str, Any]:
    policy_path = Path("config/macro-policy.json")
    default = {
        "required_tags": [
            "macro_risk", "rate_hawkishness", "geopolitical_tension",
            "energy_shock_risk", "recession_fear"
        ],
        "weights": {
            "macro_risk": 0.4, "recession_fear": 0.3,
            "geopolitical_tension": 0.15, "energy_shock_risk": 0.15
        },
        "thresholds": {"crisis_prone": 0.8, "stressed": 0.6, "watchful": 0.3}
    }
    if not policy_path.exists():
        return default
    try:
        return json.loads(policy_path.read_text(encoding="utf-8"))
    except Exception:
        return default


def classify_macro_from_tags(tags: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    policy = _load_macro_policy()
    required_tags = policy["required_tags"]
    weights = policy["weights"]
    thresholds = policy["thresholds"]

    if not tags:
        return {
            "macro_score": None,
            "macro_label": "n/a",
            "inputs_used": [],
            "null_count": len(required_tags),
            "confidence": 0,
            "coverage_note": "no tag signals",
        }

    values: Dict[str, float] = {}
    null_count = 0
    for key in required_tags:
        raw = tags.get(key)
        parsed = _safe_float(raw)
        if parsed is None:
            null_count += 1
            values[key] = 0.0
        else:
            values[key] = parsed

    raw_score = sum(values.get(k, 0.0) * w for k, w in weights.items())
    macro_score = max(0.0, min(1.0, raw_score))

    if macro_score >= thresholds.get("crisis_prone", 0.8):
        macro_label = "crisis-prone"
    elif macro_score >= thresholds.get("stressed", 0.6):
        macro_label = "stressed"
    elif macro_score >= thresholds.get("watchful", 0.3):
        macro_label = "watchful"
    else:
        macro_label = "calm"

    inputs_used = [
        k for k in required_tags 
        if tags.get(k) is not None and _safe_float(tags.get(k)) is not None
    ]
    coverage = len(inputs_used) / len(required_tags) if required_tags else 0

    return {
        "macro_score": macro_score,
        "macro_label": macro_label,
        "inputs_used": inputs_used,
        "null_count": null_count,
        "confidence": (
            1.0 if coverage > 0.8 else 0.7 if coverage > 0.4 else 0.0
        ),
        "coverage_note": (
            "full coverage" if coverage > 0.8 
            else "partial coverage" if coverage > 0.4 
            else "no tag signals"
        ),
    }


def load_latest_world_context(
    path: Path | str = Path("data/world-context.jsonl"),
) -> Optional[Dict[str, Any]]:
    """Load latest context using professional Tail-Read optimization for large files."""
    context_path = Path(path)
    if not context_path.exists():
        return None

    file_size = context_path.stat().st_size
    if file_size == 0:
        return None

    # Institutional Optimization: Only read the last 128KB of the history file
    # This prevents the bot from slowing down as the 60-day run progresses.
    read_size = min(file_size, 128 * 1024)
    try:
        with open(context_path, "rb") as f:
            f.seek(file_size - read_size)
            chunk = f.read(read_size).decode("utf-8", errors="ignore")
        
        lines = chunk.strip().splitlines()
        if not lines:
            return None
            
        # Search backwards for the first valid JSON entry with generated_at
        for line in reversed(lines):
            try:
                entry = json.loads(line)
                if entry.get("generated_at"):
                    macro_view = classify_macro_from_tags(entry.get("tags"))
                    entry["macro_view"] = macro_view
                    return entry
            except (json.JSONDecodeError, TypeError):
                continue
    except Exception:
        return None

    return None


def world_context_age_minutes(world_context: Optional[Dict[str, Any]]) -> Optional[float]:
    if not world_context or not world_context.get("generated_at"):
        return None
    try:
        ts = datetime.fromisoformat(world_context["generated_at"].replace("Z", "+00:00"))
        delta = datetime.now(tz=timezone.utc) - ts.astimezone(timezone.utc)
        return delta.total_seconds() / 60.0
    except Exception:
        return None
