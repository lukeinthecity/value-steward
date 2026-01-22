"""Risk governor enforcing portfolio constraints."""

from valuesteward.config import ValueStewardSettings, get_settings
from valuesteward.core.risk_modes import RiskModeConfig, get_risk_mode_config
from valuesteward.models import PortfolioSnapshot, RiskMode


class RiskGovernor:
    """Law layer that decides whether a trade is allowed.

    It never knows why a trade is suggested; it only enforces constraints.
    """

    def __init__(
        self, mode: RiskMode | None = None, settings: ValueStewardSettings | None = None
    ) -> None:
        if mode is None:
            settings = settings or get_settings()
            mode = RiskMode(settings.mode.upper())
        self.mode = mode
        self.config: RiskModeConfig = get_risk_mode_config(self.mode)

    def estimate_post_trade_risk(
        self, snapshot: PortfolioSnapshot, intended_position_pct: float
    ) -> float:
        """Estimate risk exposure after a hypothetical trade."""

        return snapshot.risk_exposure_pct + intended_position_pct

    def check_trade_allowed(
        self, snapshot: PortfolioSnapshot, intended_position_pct: float
    ) -> bool:
        """Return True if a trade is allowed under current risk caps."""

        post_risk = self.estimate_post_trade_risk(snapshot, intended_position_pct)
        if post_risk > self.config.max_risk_exposure_pct:
            return False
        if intended_position_pct > self.config.max_position_pct:
            return False
        return True
