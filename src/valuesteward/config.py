"""Configuration loading for the Value Steward agent."""

import logging
from functools import lru_cache

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


class ValueStewardSettings(BaseSettings):
    """Central configuration model for Value Steward.

    Values are loaded from environment variables and coerced from strings.
    core_symbol is the single ETF/asset used in v1 for LOW-mode rebalancing.
    In LOW mode, the steward targets target_risk_exposure_pct_low with a
    rebalance_buffer_pct deadzone to avoid constant micro-trades.
    execution_armed must be True and shadow_mode must be False to submit orders.
    """

    model_config = SettingsConfigDict(
        env_prefix="",
        env_file=".env",
        case_sensitive=True,
        extra="ignore",
        populate_by_name=True,
    )

    alpaca_api_key_id: str = Field(..., validation_alias="ALPACA_API_KEY_ID")
    alpaca_secret_key: str = Field(..., validation_alias="ALPACA_SECRET_KEY")
    alpaca_base_url: str = Field(
        "https://paper-api.alpaca.markets",
        validation_alias="ALPACA_PAPER_BASE_URL",
    )
    mode: str = Field(default="LOW", validation_alias="VS_MODE")
    shadow_mode: bool = Field(default=True, validation_alias="VS_SHADOW_MODE")
    execution_armed: bool = Field(default=False, validation_alias="VS_EXECUTION_ARMED")
    core_symbol: str = Field(default="SPY", validation_alias="VS_CORE_SYMBOL")
    target_risk_exposure_pct_low: float = Field(
        default=0.20, validation_alias="TARGET_RISK_EXPOSURE_PCT_LOW"
    )
    rebalance_buffer_pct: float = Field(
        default=0.02, validation_alias="REBALANCE_BUFFER_PCT"
    )
    max_effective_capital_dollars: float = Field(
        default=20.0, validation_alias="MAX_EFFECTIVE_CAPITAL_DOLLARS", gt=0
    )
    max_trade_notional_dollars: float = Field(
        default=5.0, validation_alias="MAX_TRADE_NOTIONAL_DOLLARS", gt=0
    )
    min_trade_notional_dollars: float = Field(
        default=1.0, validation_alias="MIN_TRADE_NOTIONAL_DOLLARS", gt=0
    )


@lru_cache(maxsize=1)
def get_settings() -> ValueStewardSettings:
    """Return a singleton settings instance for the process."""

    try:
        return ValueStewardSettings()
    except ValidationError as exc:
        logger.warning(
            "Invalid environment configuration for ValueStewardSettings; "
            "falling back to safe defaults. Error: %s",
            exc,
        )
        return ValueStewardSettings.model_construct(
            alpaca_api_key_id="",
            alpaca_secret_key="",
            alpaca_base_url="https://paper-api.alpaca.markets",
            mode="LOW",
            shadow_mode=True,
            execution_armed=False,
            core_symbol="SPY",
            target_risk_exposure_pct_low=0.20,
            rebalance_buffer_pct=0.02,
            max_effective_capital_dollars=20.0,
            max_trade_notional_dollars=5.0,
            min_trade_notional_dollars=1.0,
        )
