"""Persistent memory engine for intents."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import List

from valuesteward.models import IntentRecord, RiskMode


class MemoryEngine:
    """Persistent memory store backed by a JSONL log.

    TODO: pattern extraction logic
    """

    def __init__(self, log_path: str = "logs/intent_log.jsonl") -> None:
        self.log_path = Path(log_path)
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
                            payload["timestamp"] = datetime.fromisoformat(
                                payload["timestamp"]
                            )
                        if "mode" in payload:
                            payload["mode"] = RiskMode(payload["mode"])
                        self._intents.append(IntentRecord(**payload))
                    except (ValueError, TypeError) as exc:
                        print(
                            f"[ERROR] Skipping invalid intent log line: {exc}",
                            file=sys.stderr,
                        )
        except OSError as exc:
            print(f"[ERROR] Failed to read intent log: {exc}", file=sys.stderr)

    def append(self, intent: IntentRecord) -> None:
        """Append an intent to memory and persistence."""

        self._intents.append(intent)
        os.makedirs(self.log_path.parent, exist_ok=True)
        record = intent.to_json_dict()
        try:
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
        except OSError as exc:
            print(f"[ERROR] Failed to write intent log: {exc}", file=sys.stderr)

    def get_recent_intents(self, limit: int = 50) -> List[IntentRecord]:
        """Return the most recent intents."""

        return list(self._intents[-limit:])

    def get_all_intents(self) -> List[IntentRecord]:
        """Return the full intent history."""

        return list(self._intents)
