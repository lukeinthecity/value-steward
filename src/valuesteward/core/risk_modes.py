"""Risk mode configurations for the Value Steward."""

from pydantic import BaseModel

from valuesteward.models import RiskMode


class RiskModeConfig(BaseModel):
    """Risk caps that constrain trading behavior for a given mode.

    max_risk_exposure_pct: Maximum percent of portfolio in risk assets.
    max_position_pct: Maximum percent of portfolio in a single position.
    max_weekly_loss_pct: Maximum tolerated weekly loss as a percent.
    max_trades_per_week: Maximum number of trades per week.
    """

    max_risk_exposure_pct: float
    max_position_pct: float
    max_weekly_loss_pct: float
    max_trades_per_week: int


def get_risk_mode_config(mode: RiskMode) -> RiskModeConfig:
    """Return configuration for the requested risk mode.

    v0 operates in LOW, but other modes are defined for future use.
    """

    if mode == RiskMode.MEDIUM:
        return RiskModeConfig(
            max_risk_exposure_pct=0.5,
            max_position_pct=0.12,
            max_weekly_loss_pct=0.05,
            max_trades_per_week=5,
        )
    if mode == RiskMode.HIGH:
        return RiskModeConfig(
            max_risk_exposure_pct=0.8,
            max_position_pct=0.2,
            max_weekly_loss_pct=0.1,
            max_trades_per_week=10,
        )

    return RiskModeConfig(
        max_risk_exposure_pct=0.3,
        max_position_pct=0.08,
        max_weekly_loss_pct=0.02,
        max_trades_per_week=2,
    )
