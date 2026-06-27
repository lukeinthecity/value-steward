"""Pattern extraction, storage, and matching for Value Steward.

Data flow
---------
  intent_log.jsonl  +  data/history.jsonl
          ↓
  EpisodeExtractor.build_episodes()   -- computes realized_pnl from history
          ↓
  PatternExtractor.extract()          -- groups episodes by regime-tag fingerprint
          ↓
  PatternLibrary                      -- persists cards to data/patterns.jsonl,
                                         exposes find_matching_patterns() for
                                         DecisionEngine to use

Run ``python -m valuesteward.cli patterns`` to rebuild the library from the
latest intents and history.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel

from valuesteward.models import IntentRecord, RiskMode

logger = logging.getLogger(__name__)

# Tag prefixes that encode market regime.  Slot/exposure tags are deliberately
# excluded -- they change every tick and would fragment episodes into groups
# too small to learn from.
_REGIME_PREFIXES = ("MACRO_", "RATE_", "GEO_", "ENERGY_", "RECESSION_")
_DEFAULT_PATTERNS_PATH = "data/patterns.jsonl"
_MIN_PATTERN_SAMPLES = 3


# History loading

@dataclass
class HistoryEntry:
    """One tick row from data/history.jsonl, reduced to what we need."""

    ts: datetime          # timezone-aware UTC
    equity: float
    positions: Dict[str, float]  # symbol → unrealizedPl


def _as_utc(ts: datetime) -> datetime:
    """Return a timezone-aware UTC datetime regardless of input awareness."""
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def load_history_entries(path: str = "data/history.jsonl") -> List[HistoryEntry]:
    """Load data/history.jsonl and return HistoryEntry objects."""
    history_path = Path(path)
    if not history_path.exists():
        logger.debug("History file not found: %s", path)
        return []
    entries: List[HistoryEntry] = []
    try:
        with history_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                    ts_str = raw.get("ranAt") or raw.get("timestamp") or raw.get("ts")
                    if not ts_str:
                        continue
                    ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                    equity = float(raw.get("equity") or raw.get("portfolioValue") or 0)
                    positions: Dict[str, float] = {}
                    for pos in raw.get("positions") or []:
                        sym = pos.get("symbol")
                        upl = pos.get("unrealizedPl")
                        if sym and upl is not None:
                            try:
                                positions[sym] = float(upl)
                            except (TypeError, ValueError):
                                pass
                    entries.append(HistoryEntry(ts=ts, equity=equity, positions=positions))
                except (ValueError, TypeError, KeyError):
                    continue
    except OSError as exc:
        logger.warning("Failed to read history file %s: %s", path, exc)
    return entries


# Domain models

class PatternCard(BaseModel):
    """A learned pattern linking a market-regime fingerprint to its outcomes."""

    pattern_id: str            # 12-char hex digest of tag_fingerprint
    tag_fingerprint: str       # pipe-separated sorted regime tags, e.g. "GEO_HIGH|MACRO_CALM"
    conditions: Dict[str, str] # {"regime_tags": tag_fingerprint} -- extensible
    status: str                # "pending" → "active" after first update cycle
    sample_size: int
    avg_return: float          # mean realized_pnl_pct across matched episodes
    max_drawdown: float        # worst (most negative) single-episode pnl
    last_updated: datetime

    def to_json_dict(self) -> dict:
        data = self.model_dump()
        data["last_updated"] = self.last_updated.isoformat()
        return data

    @classmethod
    def from_json_dict(cls, data: dict) -> "PatternCard":
        if "last_updated" in data and isinstance(data["last_updated"], str):
            data = dict(data)
            data["last_updated"] = datetime.fromisoformat(data["last_updated"])
        return cls(**data)


class TradingEpisode(BaseModel):
    """A group of same-day intents for one symbol, with computed outcome."""

    symbol: str
    mode: RiskMode
    world_tags: List[str]
    regime_tags: List[str]          # subset of world_tags used for fingerprinting
    intents: List[IntentRecord]
    start_timestamp: datetime
    end_timestamp: Optional[datetime] = None
    realized_pnl: Optional[float] = None  # pnl as fraction of equity; None = unknown
    has_buy: bool = False
    has_sell: bool = False


# Helpers

def _regime_tags_from(world_tags: List[str]) -> List[str]:
    """Return only the regime-relevant tags, sorted for stable fingerprinting."""
    return sorted(
        t for t in world_tags
        if any(t.startswith(p) for p in _REGIME_PREFIXES)
    )


def _fingerprint(regime_tags: List[str]) -> str:
    return "|".join(regime_tags) if regime_tags else "DEFAULT"


def _pattern_id(fingerprint: str) -> str:
    return hashlib.sha1(fingerprint.encode()).hexdigest()[:12]  # nosec B324


# EpisodeExtractor

class EpisodeExtractor:
    """Build TradingEpisode objects from intent history.

    When history_entries are provided (from data/history.jsonl), each
    episode's realized_pnl is estimated from the change in unrealizedPl
    for the traded symbol between the episode start and 24 h later.

    PnL is expressed as a fraction of equity at episode start so it is
    comparable across different account sizes.
    """

    def __init__(
        self,
        intents: List[IntentRecord],
        history_entries: Optional[List[HistoryEntry]] = None,
    ) -> None:
        self.intents = intents
        self.history_entries: List[HistoryEntry] = history_entries or []

    def _compute_episode_pnl(
        self,
        symbol: str,
        start_ts: datetime,
        end_ts: datetime,
    ) -> Optional[float]:
        """Estimate PnL for a symbol over an episode window.

        Looks for history entries bracketing [start_ts, end_ts + 24 h].
        Returns pnl as a fraction of equity, or None if data is insufficient.
        """
        if not self.history_entries:
            return None

        # 24-hour lookahead so we capture the next-day outcome for same-day episodes.
        lookahead = end_ts + timedelta(hours=24)
        before = [e for e in self.history_entries if e.ts <= start_ts]
        after = [e for e in self.history_entries if start_ts < e.ts <= lookahead]
        if not before or not after:
            return None

        start_entry = max(before, key=lambda e: e.ts)
        end_entry = min(after, key=lambda e: e.ts)
        equity = start_entry.equity if start_entry.equity > 0 else end_entry.equity
        if equity <= 0:
            return None

        # Prefer symbol-specific unrealizedPl delta.
        s_upl = start_entry.positions.get(symbol)
        e_upl = end_entry.positions.get(symbol)
        if s_upl is not None and e_upl is not None:
            return (e_upl - s_upl) / equity

        # Fall back to total equity delta as a proxy.
        return (end_entry.equity - start_entry.equity) / equity

    def build_episodes(self) -> List[TradingEpisode]:
        """Group intents by (symbol, calendar_day) and compute outcomes."""
        grouped: dict[tuple[str, date], List[IntentRecord]] = {}
        for intent in self.intents:
            # Use symbol if set, otherwise fall back to core_symbol.
            sym = (intent.symbol or intent.core_symbol or "UNKNOWN").strip().upper()
            key = (sym, intent.timestamp.date())
            grouped.setdefault(key, []).append(intent)

        episodes: List[TradingEpisode] = []
        for (symbol, _day), day_intents in grouped.items():
            day_intents = sorted(day_intents, key=lambda i: i.timestamp)

            # Choose world_tags from the first intent that has non-trivial tags.
            best_tags: List[str] = ["DEFAULT"]
            for intent in day_intents:
                if intent.world_tags and intent.world_tags != ["DEFAULT"]:
                    best_tags = intent.world_tags
                    break

            rtags = _regime_tags_from(best_tags)
            has_buy = any(i.action_type in ("BUY", "MULTI") for i in day_intents)
            has_sell = any(i.action_type == "SELL" for i in day_intents)

            start_ts = _as_utc(day_intents[0].timestamp)
            end_ts = _as_utc(day_intents[-1].timestamp)

            realized_pnl: Optional[float] = None
            if (has_buy or has_sell) and self.history_entries:
                realized_pnl = self._compute_episode_pnl(symbol, start_ts, end_ts)

            episodes.append(
                TradingEpisode(
                    symbol=symbol,
                    mode=day_intents[0].mode,
                    world_tags=best_tags,
                    regime_tags=rtags,
                    intents=day_intents,
                    start_timestamp=start_ts,
                    end_timestamp=end_ts,
                    realized_pnl=realized_pnl,
                    has_buy=has_buy,
                    has_sell=has_sell,
                )
            )
        return episodes


# PatternExtractor

class PatternExtractor:
    """Derive PatternCard objects from a list of TradingEpisodes.

    Only episodes where a trade occurred AND realized_pnl is known are used.
    Episodes are grouped by their regime-tag fingerprint; groups with fewer
    than min_samples are skipped.
    """

    def __init__(self, min_samples: int = _MIN_PATTERN_SAMPLES) -> None:
        self.min_samples = min_samples

    def extract(self, episodes: List[TradingEpisode]) -> List[PatternCard]:
        """Return PatternCard objects derived from episodes."""
        # Only episodes with a known outcome from an actual trade.
        scored = [
            ep for ep in episodes
            if ep.realized_pnl is not None and (ep.has_buy or ep.has_sell)
        ]

        # Group by regime fingerprint.
        groups: Dict[str, List[TradingEpisode]] = {}
        for ep in scored:
            fp = _fingerprint(ep.regime_tags)
            groups.setdefault(fp, []).append(ep)

        now = datetime.now(timezone.utc)
        cards: List[PatternCard] = []
        for fingerprint, group in groups.items():
            if len(group) < self.min_samples:
                continue
            pnls = [ep.realized_pnl for ep in group if ep.realized_pnl is not None]
            if not pnls:
                continue
            avg_return = sum(pnls) / len(pnls)
            max_drawdown = abs(min(pnls))
            pid = _pattern_id(fingerprint)
            cards.append(PatternCard(
                pattern_id=pid,
                tag_fingerprint=fingerprint,
                conditions={"regime_tags": fingerprint},
                status="active",
                sample_size=len(pnls),
                avg_return=avg_return,
                max_drawdown=max_drawdown,
                last_updated=now,
            ))
        return cards


# PatternLibrary

class PatternLibrary:
    """File-backed store of PatternCard objects.

    Persists to data/patterns.jsonl (one JSON object per line, keyed by
    pattern_id).  The tick command loads the library at startup so the
    DecisionEngine can use patterns without re-extracting on every tick.

    Call ``update_from_episodes()`` (via ``cli patterns``) to derive new
    cards from recent episode history and merge them in.
    """

    def __init__(
        self,
        path: str = _DEFAULT_PATTERNS_PATH,
        min_samples: int = _MIN_PATTERN_SAMPLES,
    ) -> None:
        self.path = Path(path)
        self.min_samples = min_samples
        self._patterns: Dict[str, PatternCard] = {}  # pattern_id → card
        self._load()

    # Persistence

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        card = PatternCard.from_json_dict(json.loads(line))
                        self._patterns[card.pattern_id] = card
                    except (ValueError, TypeError, KeyError) as exc:
                        logger.warning("Skipping invalid pattern line: %s", exc)
        except OSError as exc:
            logger.warning("Failed to read patterns file %s: %s", self.path, exc)

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("w", encoding="utf-8") as fh:
                for card in self._patterns.values():
                    fh.write(json.dumps(card.to_json_dict()) + "\n")
        except OSError as exc:
            logger.error("Failed to write patterns file %s: %s", self.path, exc)

    # Query

    def list_patterns(self) -> List[PatternCard]:
        """Return all active patterns."""
        return [c for c in self._patterns.values() if c.status == "active"]

    def find_matching_patterns(self, world_tags: List[str]) -> List[PatternCard]:
        """Return patterns whose regime tags substantially overlap with world_tags.

        A pattern matches when at least half of its own regime tags appear in
        world_tags.  This tolerates partial context (e.g. when some signals
        are null and therefore absent from world_tags).
        """
        if not self._patterns:
            return []
        tag_set = set(world_tags)
        matches: List[PatternCard] = []
        for card in self._patterns.values():
            if card.status != "active":
                continue
            if not card.tag_fingerprint or card.tag_fingerprint == "DEFAULT":
                continue
            pattern_tags = set(card.tag_fingerprint.split("|"))
            overlap = len(pattern_tags & tag_set)
            if overlap >= max(1, len(pattern_tags) // 2):
                matches.append(card)
        return matches

    # Update

    def update_from_episodes(
        self, episodes: List[TradingEpisode], save: bool = True
    ) -> List[PatternCard]:
        """Derive PatternCards from episodes and merge them into the library.

        New patterns start as 'pending'.  On their second update cycle they
        are promoted to 'active'.  Existing patterns are updated via EMA
        (alpha=0.3) so the library adapts to new data without abrupt swings.

        Returns the list of cards that were created or updated.
        """
        extractor = PatternExtractor(min_samples=self.min_samples)
        new_cards = extractor.extract(episodes)
        alpha = 0.3
        now = datetime.now(timezone.utc)
        updated: List[PatternCard] = []

        for card in new_cards:
            existing = self._patterns.get(card.pattern_id)
            if existing is None:
                # First time we see this fingerprint -- mark pending.
                pending = card.model_copy(update={"status": "pending"})
                self._patterns[pending.pattern_id] = pending
                updated.append(pending)
            else:
                # EMA blend of returns; take the worst drawdown observed.
                new_avg = alpha * card.avg_return + (1 - alpha) * existing.avg_return
                new_dd = max(existing.max_drawdown, card.max_drawdown)
                merged = existing.model_copy(update={
                    "avg_return": new_avg,
                    "max_drawdown": new_dd,
                    "sample_size": existing.sample_size + card.sample_size,
                    "status": "active",   # promote on second observation
                    "last_updated": now,
                })
                self._patterns[merged.pattern_id] = merged
                updated.append(merged)

        if save and updated:
            self._save()
        return updated

    def pattern_count(self) -> int:
        return len(self._patterns)

    def active_count(self) -> int:
        return sum(1 for c in self._patterns.values() if c.status == "active")
