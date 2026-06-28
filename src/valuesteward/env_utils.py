"""Environment-variable parsing helpers with safe defaults.

Single source of truth for reading tunables from the environment. Both return
``default`` when the variable is unset, blank, or unparseable, so callers never
crash on a malformed override.
"""

import os


def get_env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def get_env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default
