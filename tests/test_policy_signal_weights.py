"""Tests for signal_weights field handling in policy.py."""

from valuesteward.config import ValueStewardSettings
from valuesteward.policy import (
    SIGNAL_WEIGHT_MAX,
    SIGNAL_WEIGHT_MIN,
    apply_policy_to_settings,
    validate_policy,
)


def _make_settings(**overrides) -> ValueStewardSettings:
    base: dict = {
        "alpaca_api_key_id": "x",  # nosec B106
        "alpaca_secret_key": "y",  # nosec B106
        "alpaca_base_url": "https://paper-api.alpaca.markets",
        "mode": "LOW",
        "shadow_mode": True,
        "execution_armed": False,
        "core_symbol": "SPY",
        "target_risk_exposure_pct_low": 0.20,
        "target_risk_exposure_pct_medium": 0.40,
        "target_risk_exposure_pct_high": 0.60,
        "rebalance_buffer_pct": 0.02,
        "max_effective_capital_dollars": 20.0,
        "max_sandbox_deployed_dollars": 20.0,
        "max_trade_notional_dollars": 5.0,
        "min_trade_notional_dollars": 1.0,
        "max_symbols_per_day": 5,
        "w_rank_mom": 1.0,
        "w_rank_vol": 0.4,
        "w_rank_dd": 0.4,
        "market_check_disabled": False,
        "use_alpaca_clock": False,
        "max_daily_loss_pct": 0.03,
        "max_signal_age_days": 1,
    }
    base.update(overrides)
    return ValueStewardSettings.model_construct(**base)


def test_validate_policy_accepts_signal_weights() -> None:
    policy, warnings = validate_policy(
        {
            "schema_version": 1,
            "signal_weights": {"momentum": 1.2, "vol": 0.5, "drawdown": 0.6},
        }
    )
    assert warnings == []
    assert policy["signal_weights"] == {
        "momentum": 1.2,
        "vol": 0.5,
        "drawdown": 0.6,
    }


def test_validate_policy_clamps_out_of_range_weights() -> None:
    policy, warnings = validate_policy(
        {
            "schema_version": 1,
            "signal_weights": {"momentum": 5.0, "vol": -0.1, "drawdown": 0.5},
        }
    )
    # Two clamp warnings expected.
    assert sum("outside" in w for w in warnings) == 2
    assert policy["signal_weights"]["momentum"] == SIGNAL_WEIGHT_MAX
    assert policy["signal_weights"]["vol"] == SIGNAL_WEIGHT_MIN
    assert policy["signal_weights"]["drawdown"] == 0.5


def test_validate_policy_rejects_non_numeric_weight_entry() -> None:
    policy, warnings = validate_policy(
        {
            "schema_version": 1,
            "signal_weights": {"momentum": "high", "vol": 0.5},
        }
    )
    assert any("must be numeric" in w for w in warnings)
    assert "momentum" not in policy["signal_weights"]
    assert policy["signal_weights"]["vol"] == 0.5


def test_validate_policy_rejects_non_dict_signal_weights() -> None:
    # Pydantic schema rejects non-dict values at model_validate time, before
    # our custom validation runs. The early-return path returns an empty
    # policy with a single validation-error warning.
    policy, warnings = validate_policy(
        {"schema_version": 1, "signal_weights": [1, 2, 3]}
    )
    assert any("Policy validation error" in w for w in warnings)
    assert policy == {}


def test_apply_policy_to_settings_overrides_signal_weights() -> None:
    settings = _make_settings()
    updated = apply_policy_to_settings(
        settings,
        {"signal_weights": {"momentum": 1.3, "vol": 0.6, "drawdown": 0.5}},
    )
    assert updated.w_rank_mom == 1.3
    assert updated.w_rank_vol == 0.6
    assert updated.w_rank_dd == 0.5


def test_apply_policy_to_settings_clamps_runtime_weights() -> None:
    settings = _make_settings()
    updated = apply_policy_to_settings(
        settings,
        {"signal_weights": {"momentum": 99.0, "vol": -1.0, "drawdown": 0.5}},
    )
    assert updated.w_rank_mom == SIGNAL_WEIGHT_MAX
    assert updated.w_rank_vol == SIGNAL_WEIGHT_MIN
    assert updated.w_rank_dd == 0.5


def test_apply_policy_to_settings_leaves_weights_when_policy_silent() -> None:
    settings = _make_settings(w_rank_mom=1.1, w_rank_vol=0.7, w_rank_dd=0.3)
    # No signal_weights key — nothing should change.
    updated = apply_policy_to_settings(settings, {"risk_level": 0.25})
    assert updated.w_rank_mom == 1.1
    assert updated.w_rank_vol == 0.7
    assert updated.w_rank_dd == 0.3
