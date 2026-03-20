"""Tests for runtime integrity and policy cap propagation."""

from __future__ import annotations

import hashlib

import pytest

from valuesteward.config import ValueStewardSettings
from valuesteward.policy import apply_policy_to_settings
from valuesteward.runtime_integrity import verify_runtime_expectations


def test_policy_can_override_cap_fields() -> None:
    settings = ValueStewardSettings(
        alpaca_api_key_id="test-key",
        alpaca_secret_key="test-secret",
        max_effective_capital_dollars=20.0,
        max_trade_notional_dollars=5.0,
        min_trade_notional_dollars=1.0,
    )
    policy = {
        "max_effective_capital_dollars": 12.5,
        "max_trade_notional_dollars": 4.25,
        "min_trade_notional_dollars": 2.0,
    }

    updated = apply_policy_to_settings(settings, policy)

    assert updated.max_effective_capital_dollars == 12.5
    assert updated.max_trade_notional_dollars == 4.25
    assert updated.min_trade_notional_dollars == 2.0


def test_verify_runtime_expectations_detects_hash_mismatch(monkeypatch) -> None:
    monkeypatch.setenv("VS_EXPECTED_SHA_CLI_PY", "deadbeef")

    with pytest.raises(RuntimeError, match="Runtime integrity check failed"):
        verify_runtime_expectations()


def test_verify_runtime_expectations_accepts_actual_hashes(monkeypatch) -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    targets = {
        "VS_EXPECTED_SHA_CLI_PY": root / "src/valuesteward/cli.py",
        "VS_EXPECTED_SHA_EXECUTION_ENGINE_PY": root / "src/valuesteward/core/execution_engine.py",
        "VS_EXPECTED_SHA_CONFIG_PY": root / "src/valuesteward/config.py",
        "VS_EXPECTED_SHA_POLICY_PY": root / "src/valuesteward/policy.py",
    }
    for env_name, path in targets.items():
        monkeypatch.setenv(
            env_name, hashlib.sha256(path.read_bytes()).hexdigest()
        )

    result = verify_runtime_expectations()

    assert result["files"]["src/valuesteward/cli.py"] == hashlib.sha256(
        targets["VS_EXPECTED_SHA_CLI_PY"].read_bytes()
    ).hexdigest()
