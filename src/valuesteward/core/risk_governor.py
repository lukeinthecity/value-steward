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

    def check_vol_stop(self, day_return: float, volatility: float) -> bool:
        """Institutional Exit Rule: Return True if day return is worse than -2.0 SD.
        
        This identifies 'Abnormal Pain' beyond regular market noise.
        """
        if volatility <= 0:
            return False
        
        # 2.0 SD is the standard institutional threshold for a trend break
        threshold = -2.0 * volatility
        return day_return < threshold

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
