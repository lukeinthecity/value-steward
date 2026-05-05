"""Symbol-level realized alpha priors derived from scorecard history."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


DEFAULT_SCORECARD_PATH = Path("data/signal-scorecard.jsonl")


@dataclass
class RealizedAlphaPrior:
    """Compact benchmark-relative prior for a symbol."""

    quality_score: float
    avg_excess_benchmark: float
    sample_count: int


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


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def load_realized_alpha_prior_map(
    symbols: list[str],
    *,
    scorecard_path: str | Path = DEFAULT_SCORECARD_PATH,
    horizons: tuple[int, ...] = (1, 5),
    min_samples: int = 2,
    scale: float = 0.05,
) -> dict[str, RealizedAlphaPrior]:
    """Return benchmark-relative priors for the requested symbols.

    The score is intentionally conservative:
    - neutral = 0.5
    - strong positive benchmark-relative history trends toward 1.0
    - strong negative benchmark-relative history trends toward 0.0
    - low sample counts are shrunk toward neutral
    """

    wanted = {str(symbol).upper() for symbol in symbols if symbol}
    if not wanted:
        return {}

    rows = _safe_lines(Path(scorecard_path))
    per_symbol: dict[str, list[float]] = {symbol: [] for symbol in wanted}

    for row in rows:
        if str(row.get("action_type") or "").upper() != "BUY":
            continue
        symbol = str(row.get("symbol") or "").upper()
        if symbol not in wanted:
            continue
        horizons_payload = row.get("horizons") or {}
        for horizon in horizons:
            horizon_data = horizons_payload.get(str(horizon)) or {}
            excess = horizon_data.get("excess_vs_benchmark")
            if isinstance(excess, (int, float)):
                per_symbol[symbol].append(float(excess))

    priors: dict[str, RealizedAlphaPrior] = {}
    for symbol in wanted:
        samples = per_symbol.get(symbol) or []
        if not samples:
            priors[symbol] = RealizedAlphaPrior(
                quality_score=0.5,
                avg_excess_benchmark=0.0,
                sample_count=0,
            )
            continue

        avg_excess = sum(samples) / len(samples)
        confidence = min(1.0, len(samples) / max(1, min_samples))
        normalized = _clamp(avg_excess / scale, -1.0, 1.0)
        quality_score = 0.5 + (0.5 * normalized * confidence)

        priors[symbol] = RealizedAlphaPrior(
            quality_score=_clamp(quality_score, 0.0, 1.0),
            avg_excess_benchmark=avg_excess,
            sample_count=len(samples),
        )

    return priors
