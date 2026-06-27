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


_REGIME_SEVERITY = {
    "calm": 0,
    "watchful": 1,
    "stressed": 2,
    "crisis-prone": 3,
}


def _normalize_regime_label(label: Any) -> Optional[str]:
    normalized = str(label or "").strip().lower()
    return normalized if normalized in _REGIME_SEVERITY else None


def fuse_macro_regime(
    macro_view: Optional[Dict[str, Any]],
    scout_label: Any = None,
    scout_score: Any = None,
) -> Dict[str, Any]:
    guardian_label = _normalize_regime_label((macro_view or {}).get("macro_label"))
    guardian_score = _safe_float((macro_view or {}).get("macro_score"))
    scout_norm_label = _normalize_regime_label(scout_label)
    scout_norm_score = _safe_float(scout_score)

    if guardian_label is None and scout_norm_label is None:
        return {
            "final_label": "n/a",
            "final_score": None,
            "source": "unavailable",
            "divergence": False,
            "fusion_reason": "no_valid_inputs",
            "guardian_label": (macro_view or {}).get("macro_label"),
            "guardian_score": guardian_score,
            "scout_label": scout_norm_label,
            "scout_score": scout_norm_score,
        }

    if guardian_label is None:
        return {
            "final_label": scout_norm_label,
            "final_score": scout_norm_score,
            "source": "scout",
            "divergence": False,
            "fusion_reason": "scout_only",
            "guardian_label": guardian_label,
            "guardian_score": guardian_score,
            "scout_label": scout_norm_label,
            "scout_score": scout_norm_score,
        }

    if scout_norm_label is None:
        return {
            "final_label": guardian_label,
            "final_score": guardian_score,
            "source": "guardian",
            "divergence": False,
            "fusion_reason": "guardian_only",
            "guardian_label": guardian_label,
            "guardian_score": guardian_score,
            "scout_label": scout_norm_label,
            "scout_score": scout_norm_score,
        }

    guardian_severity = _REGIME_SEVERITY[guardian_label]
    scout_severity = _REGIME_SEVERITY[scout_norm_label]
    divergence = guardian_label != scout_norm_label

    if scout_severity > guardian_severity:
        final_label = scout_norm_label
        final_score = scout_norm_score if scout_norm_score is not None else guardian_score
        source = "scout_more_cautious"
        fusion_reason = "scout_more_cautious" if divergence else "aligned"
    elif guardian_severity > scout_severity:
        final_label = guardian_label
        final_score = guardian_score if guardian_score is not None else scout_norm_score
        source = "guardian_more_cautious"
        fusion_reason = "guardian_more_cautious" if divergence else "aligned"
    else:
        final_label = guardian_label
        scores = [s for s in (guardian_score, scout_norm_score) if s is not None]
        final_score = max(scores) if scores else None
        source = "aligned"
        fusion_reason = "aligned"

    return {
        "final_label": final_label,
        "final_score": final_score,
        "source": source,
        "divergence": divergence,
        "fusion_reason": fusion_reason,
        "guardian_label": guardian_label,
        "guardian_score": guardian_score,
        "scout_label": scout_norm_label,
        "scout_score": scout_norm_score,
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

    # Only read the last 128KB of the history file
    # This prevents the bot from slowing down as the 60-day run progresses.
    read_size = min(file_size, 128 * 1024)
    try:
        with open(context_path, "rb") as f:
            f.seek(file_size - read_size)
            chunk = f.read(read_size).decode("utf-8", errors="ignore")
        
        lines = chunk.strip().splitlines()
        if not lines:
            return None

        # When we seeked mid-file, the first line is likely truncated — drop it.
        if read_size < file_size:
            lines = lines[1:]
        if not lines:
            return None
            
        # Search backwards for the first valid JSON entry with generated_at
        for line in reversed(lines):
            try:
                entry = json.loads(line)
                if entry.get("generated_at"):
                    macro_view = classify_macro_from_tags(entry.get("tags"))
                    entry["macro_view"] = macro_view
                    entry["final_regime"] = entry.get("final_regime") or fuse_macro_regime(
                        macro_view,
                        entry.get("scout_label"),
                        entry.get("scout_score"),
                    )
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
