"""World recognition stubs for Value Steward."""

from typing import List, Optional, Dict, Any

from valuesteward.models import PortfolioSnapshot


def infer_world_tags(
    snapshot: PortfolioSnapshot, world_context: Optional[Dict[str, Any]] = None
) -> List[str]:
    """Infer high-level market regime tags from the current snapshot.

    TODO: incorporate recent price history
    TODO: detect basic regimes (TREND_UP, VOL_HIGH, etc.)
    """

    tags = ["DEFAULT"]
    macro_view = (
        world_context.get("macro_view") if isinstance(world_context, dict) else None
    )
    if macro_view:
        label = str(macro_view.get("macro_label", "n/a")).upper().replace("-", "_")
        if label:
            tags.append(f"MACRO_{label}")
        score = macro_view.get("macro_score")
        if isinstance(score, (int, float)):
            tags.append(f"MACRO_SCORE_{score:.2f}")

    return tags
