"""Tests for load_policy resilience to missing / corrupt policy files.

A corrupt policy.json used to raise json.JSONDecodeError out of load_policy,
crashing the live tick. It must degrade to defaults-with-warning instead,
mirroring the existing not-found handling.
"""

import json

from valuesteward.policy import load_policy


def test_load_policy_missing_file_returns_defaults(tmp_path):
    policy, warnings = load_policy(tmp_path / "policy.json")
    assert policy == {}
    assert any("not found" in w for w in warnings)


def test_load_policy_corrupt_json_degrades_without_raising(tmp_path):
    corrupt = tmp_path / "policy.json"
    corrupt.write_text("{ this is not valid json", encoding="utf-8")
    # Must not raise.
    policy, warnings = load_policy(corrupt)
    assert policy == {}
    assert any("unreadable" in w for w in warnings)


def test_load_policy_valid_file_loads_and_validates(tmp_path):
    good = tmp_path / "policy.json"
    good.write_text(
        json.dumps({"schema_version": 1, "risk_level": 0.2}), encoding="utf-8"
    )
    policy, warnings = load_policy(good)
    assert policy.get("risk_level") == 0.2
