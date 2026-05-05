"""Persistent memory engine for intents with professional atomic writes."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import List

from valuesteward.models import IntentRecord, RiskMode

logger = logging.getLogger(__name__)


class MemoryEngine:
    """Persistent memory store backed by a JSONL log."""

    def __init__(self, log_path: str | None = None) -> None:
        if log_path:
            self.log_path = Path(log_path)
        else:
            # Elite Quant: Use absolute path rooted in the project directory
            # to ensure consistency between Cron, NPM, and CLI contexts.
            base_dir = Path(__file__).parent.parent.parent.parent
            self.log_path = base_dir / "logs" / "intent_log.jsonl"
        
        self._intents: List[IntentRecord] = []
        self.load_all()

    def load_all(self) -> None:
        """Load intents from the JSONL log into memory."""
        if not self.log_path.exists():
            return

        try:
            with self.log_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                        if "timestamp" in payload:
                            # Standardize to UTC for internal handling
                            ts = datetime.fromisoformat(payload["timestamp"].replace("Z", "+00:00"))
                            payload["timestamp"] = ts
                        if "mode" in payload:
                            payload["mode"] = RiskMode(payload["mode"])
                        self._intents.append(IntentRecord(**payload))
                    except (ValueError, TypeError, json.JSONDecodeError) as exc:
                        logger.error(f"[MEMORY] Skipping invalid intent line: {exc}")
        except OSError as exc:
            logger.error(f"[MEMORY] Failed to read intent log: {exc}")

    def append(self, intent: IntentRecord) -> None:
        """Append an intent to memory and persistence using Atomic pattern."""
        self._intents.append(intent)
        
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            record = intent.to_json_dict()
            fd = os.open(
                self.log_path,
                os.O_APPEND | os.O_CREAT | os.O_WRONLY,
                0o644,
            )
            try:
                os.write(fd, f"{json.dumps(record)}\n".encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError as exc:
            logger.error(f"[MEMORY] Failed to append intent to log: {exc}")

    def get_recent_intents(self, limit: int = 50) -> List[IntentRecord]:
        return list(self._intents[-limit:])

    def get_all_intents(self) -> List[IntentRecord]:
        return list(self._intents)
