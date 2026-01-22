"""Tests for intent memory and serialization."""

import json

from valuesteward.core.memory import MemoryEngine
from valuesteward.models import IntentRecord, RiskMode


def test_memory_appends_and_persists(tmp_path) -> None:
    log_path = tmp_path / "intent_log.jsonl"
    memory = MemoryEngine(log_path=str(log_path))
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="NO_ACTION",
        explanation="test intent",
    )

    memory.append(intent)

    assert len(memory.get_all_intents()) == 1
    lines = log_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["id"]


def test_intentrecord_defaults_and_serialization() -> None:
    intent = IntentRecord(
        mode=RiskMode.LOW,
        action_type="NO_ACTION",
        explanation="test",
    )

    assert intent.id
    assert intent.world_tags == []
    assert intent.patterns_consulted == []
    assert intent.size_pct is None
    assert intent.pre_risk_exposure_pct == 0.0
    assert intent.post_risk_exposure_pct == 0.0
    assert intent.core_symbol is None
    assert intent.target_exposure_pct is None
    assert intent.buffer_pct is None
    assert intent.reason_code is None

    payload = intent.to_json_dict()
    assert isinstance(payload["timestamp"], str)
    assert payload["mode"] == "LOW"
