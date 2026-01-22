"""Configuration loading for the Value Steward agent."""

from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ValueStewardSettings(BaseSettings):
    """Central configuration object for the Value Steward.

    All modules should use this settings object rather than reading environment
    variables directly.

    core_symbol is the single ETF/asset used in v1 for LOW-mode rebalancing.
    In LOW mode, the steward targets target_risk_exposure_pct_low with a
    rebalance_buffer_pct deadzone to avoid constant micro-trades.
    execution_armed must be True and shadow_mode must be False to submit orders.
    """

    alpaca_api_key_id: str = Field(..., validation_alias="ALPACA_API_KEY_ID")
    alpaca_secret_key: str = Field(..., validation_alias="ALPACA_SECRET_KEY")
    alpaca_base_url: str = Field(
        "https://paper-api.alpaca.markets",
        validation_alias="ALPACA_PAPER_BASE_URL",
    )
    mode: str = Field("LOW", validation_alias="VS_MODE")
    shadow_mode: bool = Field(True, validation_alias="VS_SHADOW_MODE")
    core_symbol: str = Field("SPY", validation_alias="VS_CORE_SYMBOL")
    target_risk_exposure_pct_low: float = Field(
        0.20, validation_alias="VS_TARGET_RISK_EXPOSURE_PCT_LOW"
    )
    rebalance_buffer_pct: float = Field(
        0.02, validation_alias="VS_REBALANCE_BUFFER_PCT"
    )
    execution_armed: bool = Field(False, validation_alias="VS_EXECUTION_ARMED")
    max_effective_capital_dollars: float = Field(
        20.0, validation_alias="VS_MAX_EFFECTIVE_CAPITAL_DOLLARS", gt=0
    )
    max_trade_notional_dollars: float = Field(
        10.0, validation_alias="VS_MAX_TRADE_NOTIONAL_DOLLARS", gt=0
    )
    min_trade_notional_dollars: float = Field(
        1.0, validation_alias="VS_MIN_TRADE_NOTIONAL_DOLLARS", gt=0
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore",
        populate_by_name=True,
    )


@lru_cache(maxsize=1)
def get_settings() -> ValueStewardSettings:
    """Return a singleton settings instance for the process."""

    return ValueStewardSettings()
