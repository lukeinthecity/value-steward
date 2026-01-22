"""World recognition stubs for Value Steward."""

from typing import List

from valuesteward.models import PortfolioSnapshot


def infer_world_tags(snapshot: PortfolioSnapshot) -> List[str]:
    """Infer high-level market regime tags from the current snapshot.

    TODO: incorporate recent price history
    TODO: detect basic regimes (TREND_UP, VOL_HIGH, etc.)
    """

    return ["DEFAULT"]
