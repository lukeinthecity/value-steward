"""Decision engine for Value Steward."""

from valuesteward.config import ValueStewardSettings
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.data.portfolio_repository import PortfolioRepository
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode


class DecisionEngine:
    """Determine the next intent based on world tags and risk policy."""

    def __init__(
        self,
        risk_governor: RiskGovernor,
        pattern_library: PatternLibrary,
        settings: ValueStewardSettings,
        portfolio_repository: PortfolioRepository,
    ) -> None:
        self.risk_governor = risk_governor
        self.pattern_library = pattern_library
        self.settings = settings
        self.portfolio_repository = portfolio_repository

    def decide(self, snapshot: PortfolioSnapshot, world_tags: list[str]) -> IntentRecord:
        """Return a decision intent.

        v0 always returns NO_ACTION; real strategy will be added later.
        """

        mode = self.risk_governor.mode
        target = self.settings.target_risk_exposure_pct_low
        buffer = self.settings.rebalance_buffer_pct
        if target is None or buffer is None:
            raise ValueError("Missing target or buffer settings for decision engine.")
        if mode != RiskMode.LOW:
            return IntentRecord(
                mode=mode,
                action_type="NO_ACTION",
                core_symbol=self.settings.core_symbol,
                target_exposure_pct=self.settings.target_risk_exposure_pct_low,
                buffer_pct=self.settings.rebalance_buffer_pct,
                reason_code="MODE_NOT_IMPLEMENTED",
                pre_risk_exposure_pct=snapshot.risk_exposure_pct,
                post_risk_exposure_pct=snapshot.risk_exposure_pct,
                world_tags=world_tags,
                patterns_consulted=[],
                explanation="Decision engine v1 only implemented for LOW mode.",
            )

        core_symbol = self.settings.core_symbol
        current = snapshot.risk_exposure_pct
        max_pos = self.risk_governor.config.max_position_pct
        position = self.portfolio_repository.get_position_for_symbol(
            snapshot, core_symbol
        )

        if current < target - buffer:
            delta = target - current
            size_pct = min(delta, max_pos)
            if not self.risk_governor.check_trade_allowed(snapshot, size_pct):
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=core_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="BLOCKED_BY_RISK_GOVERNOR",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation="Trade blocked by risk governor (caps exceeded).",
                )

            post_risk = min(current + size_pct, 1.0)
            return IntentRecord(
                mode=mode,
                action_type="BUY",
                symbol=core_symbol,
                size_pct=size_pct,
                core_symbol=core_symbol,
                target_exposure_pct=target,
                buffer_pct=buffer,
                reason_code="UNDER_TARGET_BUY",
                pre_risk_exposure_pct=current,
                post_risk_exposure_pct=post_risk,
                target_risk_exposure_pct=target,
                rebalance_buffer_pct=buffer,
                world_tags=world_tags,
                patterns_consulted=[],
                explanation=(
                    f"Increasing exposure in {core_symbol} from {current:.0%} "
                    f"toward LOW-mode target {target:.0%} (buffer ±{buffer:.0%})."
                ),
            )

        if current > target + buffer and position is not None:
            delta = current - target
            size_pct = min(delta, max_pos)
            post_risk = max(current - size_pct, 0.0)
            return IntentRecord(
                mode=mode,
                action_type="SELL",
                symbol=core_symbol,
                size_pct=size_pct,
                core_symbol=core_symbol,
                target_exposure_pct=target,
                buffer_pct=buffer,
                reason_code="OVER_TARGET_SELL",
                pre_risk_exposure_pct=current,
                post_risk_exposure_pct=post_risk,
                target_risk_exposure_pct=target,
                rebalance_buffer_pct=buffer,
                world_tags=world_tags,
                patterns_consulted=[],
                explanation=(
                    f"Reducing exposure in {core_symbol} from {current:.0%} "
                    f"toward LOW-mode target {target:.0%} (buffer ±{buffer:.0%})."
                ),
            )

        return IntentRecord(
            mode=mode,
            action_type="NO_ACTION",
            core_symbol=core_symbol,
            target_exposure_pct=target,
            buffer_pct=buffer,
            reason_code="WITHIN_BUFFER_NO_ACTION",
            pre_risk_exposure_pct=current,
            post_risk_exposure_pct=current,
            target_risk_exposure_pct=target,
            rebalance_buffer_pct=buffer,
            world_tags=world_tags,
            patterns_consulted=[],
            explanation=(
                f"Exposure {current:.0%} is within LOW-mode target "
                f"{target:.0%} ±{buffer:.0%}; no rebalance needed."
            ),
        )
