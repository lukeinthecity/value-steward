"""Numeric coercion helpers with safe defaults."""

from typing import SupportsFloat, SupportsIndex, cast


def safe_float(value: object, default: float | None = None) -> float | None:
    """Best-effort float coercion.

    Returns ``default`` on a TypeError/ValueError or a NaN result, so callers
    never propagate a bad parse or NaN. Pass ``default=0.0`` for a guaranteed
    float, or leave it ``None`` for optional-numeric semantics.
    """
    try:
        parsed = float(cast(str | bytes | SupportsFloat | SupportsIndex, value))
    except (TypeError, ValueError):
        return default
    return parsed if parsed == parsed else default
