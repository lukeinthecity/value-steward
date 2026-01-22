"""Pattern card and library stubs."""

from __future__ import annotations

from datetime import date, datetime
from typing import Dict, List

from pydantic import BaseModel

from valuesteward.models import IntentRecord, RiskMode

class PatternCard(BaseModel):
    """A learned pattern describing a potential trading edge."""

    pattern_id: str
    conditions: Dict[str, str]
    status: str
    sample_size: int
    avg_return: float
    max_drawdown: float
    last_updated: datetime


class PatternLibrary:
    """Collection of known patterns.

    For v0 this returns no patterns, but later will match against world tags.
    """

    def list_patterns(self) -> List[PatternCard]:
        """Return all known patterns."""

        return []

    def find_matching_patterns(self, world_tags: List[str]) -> List[PatternCard]:
        """Return patterns that match the supplied world tags."""

        return []


class TradingEpisode(BaseModel):
    """A grouped sequence of intents for later learning and evaluation."""

    symbol: str
    mode: RiskMode
    world_tags: List[str]
    intents: List[IntentRecord]
    start_timestamp: datetime
    end_timestamp: datetime | None = None
    realized_pnl: float | None = None


class EpisodeExtractor:
    """Build coarse episodes from intent history.

    TODO: When BUY/SELL intents exist, treat entry/exit as episode boundaries.
    TODO: Compute realized PnL from Alpaca fills.
    """

    def __init__(self, intents: List[IntentRecord]) -> None:
        self.intents = intents

    def build_episodes(self) -> List[TradingEpisode]:
        """Group intents by symbol and calendar day as a placeholder rule."""

        grouped: dict[tuple[str, date], List[IntentRecord]] = {}
        for intent in self.intents:
            if not intent.symbol:
                continue
            key = (intent.symbol, intent.timestamp.date())
            grouped.setdefault(key, []).append(intent)

        episodes: List[TradingEpisode] = []
        for (symbol, _day), intents in grouped.items():
            intents = sorted(intents, key=lambda item: item.timestamp)
            episodes.append(
                TradingEpisode(
                    symbol=symbol,
                    mode=intents[0].mode,
                    world_tags=intents[0].world_tags,
                    intents=intents,
                    start_timestamp=intents[0].timestamp,
                    end_timestamp=intents[-1].timestamp,
                    realized_pnl=None,
                )
            )
        return episodes
