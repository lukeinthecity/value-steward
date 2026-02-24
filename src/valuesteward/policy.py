"""Policy loading helpers for Value Steward."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from valuesteward.config import ValueStewardSettings

logger = logging.getLogger(__name__)

DEFAULT_POLICY_PATH = Path("config/policy.json")
SUPPORTED_SCHEMA_VERSION = 1
LOW_MAX_RISK = 0.34
MEDIUM_MAX_RISK = 0.67


class PolicySnapshot(BaseModel):
    """Loosely validated policy payload."""

    schema_version: int = 1
    version: int | None = None
    mode: str | None = None
    risk_level: float | None = None
    target_risk_exposure_pct_low: float | None = None
    rebalance_buffer_pct: float | None = None
    trade_gate_overrides: dict[str, Any] = Field(default_factory=dict)

    model_config = {"extra": "allow"}


def risk_level_to_mode(risk_level: float | None) -> str | None:
    if risk_level is None:
        return None
    if risk_level <= LOW_MAX_RISK:
        return "LOW"
    if risk_level <= MEDIUM_MAX_RISK:
        return "MEDIUM"
    return "HIGH"


def _validate_percent(
    policy: dict[str, Any], key: str, warnings: list[str]
) -> None:
    value = policy.get(key)
    if value is None:
        return
    if not isinstance(value, (int, float)) or not 0 <= float(value) <= 1:
        warnings.append(f"Invalid {key}={value}; expected 0..1.")
        policy[key] = None


def validate_policy(raw_policy: Any) -> tuple[dict[str, Any], list[str]]:
    """Validate and normalize a policy dict, returning warnings."""

    warnings: list[str] = []
    if not isinstance(raw_policy, dict):
        return {}, ["Policy payload is not a JSON object."]

    try:
        model = PolicySnapshot.model_validate(raw_policy)
    except ValidationError as exc:
        return {}, [f"Policy validation error: {exc}"]

    policy = model.model_dump()
    schema_version = policy.get("schema_version", 1)
    if schema_version != SUPPORTED_SCHEMA_VERSION:
        warnings.append(
            "Unsupported policy schema_version="
            f"{schema_version}; expected {SUPPORTED_SCHEMA_VERSION}."
        )

    _validate_percent(policy, "risk_level", warnings)
    _validate_percent(policy, "target_risk_exposure_pct_low", warnings)
    _validate_percent(policy, "rebalance_buffer_pct", warnings)

    trade_gate = policy.get("trade_gate_overrides")
    if trade_gate is None:
        policy["trade_gate_overrides"] = {}
    elif not isinstance(trade_gate, dict):
        warnings.append("trade_gate_overrides must be an object.")
        policy["trade_gate_overrides"] = {}
    else:
        force_no_trade = trade_gate.get("force_no_trade")
        if force_no_trade is not None and not isinstance(force_no_trade, bool):
            warnings.append("trade_gate_overrides.force_no_trade must be boolean.")
            trade_gate.pop("force_no_trade", None)

    return policy, warnings


def load_policy(path: Path | str = DEFAULT_POLICY_PATH) -> tuple[dict[str, Any], list[str]]:
    """Load the policy JSON file if present, otherwise return an empty dict."""

    policy_path = Path(path)
    if not policy_path.exists():
        return {}, ["Policy file not found; using defaults."]
    with policy_path.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)
    return validate_policy(raw)


def apply_policy_to_settings(
    settings: ValueStewardSettings, policy: dict[str, Any]
) -> ValueStewardSettings:
    """Return a settings copy with policy-driven overrides applied."""

    updates: dict[str, Any] = {}
    if isinstance(policy.get("target_risk_exposure_pct_low"), (int, float)):
        updates["target_risk_exposure_pct_low"] = float(
            policy["target_risk_exposure_pct_low"]
        )
    if isinstance(policy.get("rebalance_buffer_pct"), (int, float)):
        updates["rebalance_buffer_pct"] = float(policy["rebalance_buffer_pct"])

    mapped_mode = risk_level_to_mode(policy.get("risk_level"))
    if mapped_mode:
        updates["mode"] = mapped_mode

    if not updates:
        return settings

    return settings.model_copy(update=updates)
