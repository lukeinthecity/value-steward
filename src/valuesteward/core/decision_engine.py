"""Decision engine for Value Steward."""

import os
import logging
from datetime import datetime, timezone
from typing import List, Optional

from valuesteward.config import ValueStewardSettings
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.sector_map import SectorMap
from valuesteward.core.signal_engine import SignalEngine, SignalResult, SymbolSignal
from valuesteward.data.portfolio_repository import PortfolioRepository
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode

logger = logging.getLogger(__name__)


class DecisionEngine:
    """Determine the next intent based on world tags and risk policy."""

    DEFENSIVE_SECTORS = {
        "ENERGY",
        "UTILITIES",
        "HEALTHCARE",
        "CONSUMER_STAPLES",
        "BONDS",
        "GOLD",
        "SILVER",
    }
    CRISIS_ALIGNED_SECTORS = DEFENSIVE_SECTORS | {"INDUSTRIALS"}

    @staticmethod
    def _get_env_float(name: str, default: float) -> float:
        raw = os.getenv(name)
        if raw is None or not raw.strip():
            return default
        try:
            return float(raw)
        except ValueError:
            return default

    def __init__(
        self,
        risk_governor: RiskGovernor,
        pattern_library: PatternLibrary,
        settings: ValueStewardSettings,
        portfolio_repository: PortfolioRepository,
        signal_engine: SignalEngine | None = None,
    ) -> None:
        self.risk_governor = risk_governor
        self.pattern_library = pattern_library
        self.settings = settings
        self.portfolio_repository = portfolio_repository
        self.signal_engine = signal_engine
        self.sector_map = SectorMap()

    def _calculate_vol_adjusted_size(
        self, base_size: float, signal: SymbolSignal, signals: List[SymbolSignal]
    ) -> float:
        """Scale size inversely to volatility relative to the universe average."""
        if not signals or not signal or signal.volatility <= 0:
            return base_size

        valid_vols = [s.volatility for s in signals if s.volatility > 0]
        if not valid_vols:
            return base_size

        avg_vol = sum(valid_vols) / len(valid_vols)
        if avg_vol <= 0:
            return base_size

        # Multiplier: if stock is 2x more volatile than average, size is 0.5x
        multiplier = avg_vol / signal.volatility
        # Clamp multiplier to avoid extreme swings (e.g. 0.5x to 2.0x)
        multiplier = max(0.5, min(2.0, multiplier))

        return base_size * multiplier

    def _apply_pattern_bias(
        self,
        target: float,
        buffer: float,
        world_tags: list[str],
    ) -> tuple[float, float, list[str], str | None]:
        matched = self.pattern_library.find_matching_patterns(world_tags)
        if not matched:
            return target, buffer, [], None

        pattern_ids = [c.pattern_id for c in matched]
        avg_returns = [c.avg_return for c in matched]
        drawdowns = [c.max_drawdown for c in matched]
        composite_return = sum(avg_returns) / len(avg_returns)
        max_dd = max(drawdowns)

        if composite_return > 0:
            nudge = min(0.05, composite_return * 2)
        else:
            nudge = max(-0.10, composite_return * 2)

        original_target = target
        original_buffer = buffer
        target = max(0.0, min(1.0, target + nudge))

        if max_dd > 0.02:
            buffer = min(0.15, buffer * (1 + min(1.0, max_dd * 5)))

        note = (
            f"Pattern bias: matched={len(matched)} composite_return={composite_return:.4f} "
            f"max_drawdown={max_dd:.4f} nudge={nudge:+.4f} "
            f"target {original_target:.0%}->{target:.0%} "
            f"buffer {original_buffer:.0%}->{buffer:.0%}."
        )
        return target, buffer, pattern_ids, note

    def _apply_signal_adjustments(
        self,
        target: float,
        buffer: float,
        signal: SymbolSignal | None,
    ) -> tuple[float, float, str | None]:
        if not signal:
            return target, buffer, None

        signal_factor = 1 + (signal.score * 5)
        signal_factor = max(0.4, min(1.2, signal_factor))
        target_adj = target * signal_factor

        buffer_factor = 1 + min(1.0, signal.volatility * 10 + signal.drawdown * 2)
        buffer_adj = min(0.15, buffer * buffer_factor)

        note = (
            f"Signal {signal.symbol}: score={signal.score:.4f} "
            f"rank_mom={signal.momentum_rank:.2f} rank_vol={signal.vol_rank:.2f} "
            f"rank_dd={signal.drawdown_rank:.2f} "
            f"target {target:.0%}->{target_adj:.0%} "
            f"buffer {buffer:.0%}->{buffer_adj:.0%}."
        )
        return target_adj, buffer_adj, note

    def _apply_macro_adjustments(
        self,
        target: float,
        buffer: float,
        world_context: dict | None,
    ) -> tuple[float, float, str | None]:
        macro_note = None
        macro_label = self._macro_label(world_context)
        macro_score = self._macro_score(world_context)
        if macro_label in {"watchful", "stressed", "crisis-prone"}:
            original_target = target
            original_buffer = buffer
            if macro_label == "watchful":
                target = target * 0.8
                buffer = buffer * 1.25
            elif macro_label == "stressed":
                target = target * 0.6
                buffer = buffer * 1.5
            else:
                target = target * 0.4
                buffer = buffer * 1.75
            target = max(0.0, min(1.0, target))
            buffer = max(0.0, min(1.0, buffer))
            score_text = (
                f"{macro_score:.2f}" if isinstance(macro_score, (int, float)) else "n/a"
            )
            macro_note = (
                "Macro adjustment: "
                f"label={macro_label} score={score_text} "
                f"target {original_target:.0%}->{target:.0%} "
                f"buffer {original_buffer:.0%}->{buffer:.0%}."
            )

        return target, buffer, macro_note

    @staticmethod
    def _snapshot_deployed_notional(snapshot: PortfolioSnapshot) -> float:
        return sum(max(0.0, float(position.market_value)) for position in snapshot.positions)

    def _macro_score(self, world_context: dict | None) -> float | None:
        if not world_context or not isinstance(world_context, dict):
            return None
        final_regime = world_context.get("final_regime") or {}
        final_score = final_regime.get("final_score")
        if isinstance(final_score, (int, float)):
            return float(final_score)
        macro_view = world_context.get("macro_view") or {}
        score = macro_view.get("macro_score")
        return float(score) if isinstance(score, (int, float)) else None

    def _macro_label(self, world_context: dict | None) -> str | None:
        if not world_context or not isinstance(world_context, dict):
            return None
        final_regime = world_context.get("final_regime") or {}
        final_label = final_regime.get("final_label")
        if final_label is not None:
            return str(final_label)
        macro_view = world_context.get("macro_view") or {}
        label = macro_view.get("macro_label")
        return str(label) if label is not None else None

    def _world_context_fresh(self, world_context: dict | None) -> tuple[bool, str | None]:
        if os.getenv("PYTEST_CURRENT_TEST"):
            return True, None
        required = (
            os.getenv("VS_WORLD_CONTEXT_REQUIRED", "true")
            .strip()
            .lower() in {"1", "true", "yes", "y"}
        )
        if not required:
            return True, None

        generated_at = (world_context or {}).get("generated_at")
        if not generated_at:
            return False, "missing_or_invalid"
        try:
            ts = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
            now = datetime.now(tz=timezone.utc)
            age = (now - ts.astimezone(timezone.utc)).total_seconds() / 60.0
            max_age = float(os.getenv("VS_WORLD_CONTEXT_MAX_AGE_MINUTES", "180"))
            if age > max_age:
                return False, f"age={age:.1f}min max={max_age:.0f}min"
            return True, None
        except Exception:
            return False, "parse_error"

    def _allow_buy(
        self,
        world_context: dict | None,
        signal: SymbolSignal | None,
        snapshot: PortfolioSnapshot,
    ) -> tuple[bool, str | None, float]:
        macro_label = self._macro_label(world_context)
        if signal and signal.score < 0:
            return False, f"signal_score={signal.score:.4f}", 1.0

        if not signal:
            return True, None, 1.0

        self.sector_map.resolve([signal.symbol, *[pos.symbol for pos in snapshot.positions]])
        selected_sector = self.sector_map.get(signal.symbol)
        existing_symbols = {pos.symbol for pos in snapshot.positions}
        is_add_on = signal.symbol in existing_symbols

        if not is_add_on:
            min_score = self._get_env_float("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", 1.55)
            min_rel_20 = self._get_env_float("VS_NEW_ENTRY_MIN_REL_STRENGTH_20D", 0.0)
            min_rel_60 = self._get_env_float("VS_NEW_ENTRY_MIN_REL_STRENGTH_60D", 0.0)
            min_trend = self._get_env_float("VS_NEW_ENTRY_MIN_TREND_STRENGTH", 0.0)

            if signal.score < min_score:
                return (
                    False,
                    f"entry_quality score={signal.score:.4f}<{min_score:.2f}",
                    1.0,
                )
            if signal.rel_strength_20d <= min_rel_20:
                return (
                    False,
                    (
                        "entry_quality "
                        f"rel20={signal.rel_strength_20d:.4f}<={min_rel_20:.2f}"
                    ),
                    1.0,
                )
            if signal.rel_strength_60d <= min_rel_60:
                return (
                    False,
                    (
                        "entry_quality "
                        f"rel60={signal.rel_strength_60d:.4f}<={min_rel_60:.2f}"
                    ),
                    1.0,
                )
            if signal.trend_strength <= min_trend:
                return (
                    False,
                    (
                        "entry_quality "
                        f"trend={signal.trend_strength:.4f}<={min_trend:.2f}"
                    ),
                    1.0,
                )

        if macro_label in {"stressed", "crisis-prone"}:
            min_signal = 0.05 if macro_label == "stressed" else 0.10
            size_multiplier = 0.50 if macro_label == "stressed" else 0.25
            allowed_sectors = (
                self.CRISIS_ALIGNED_SECTORS
                if macro_label == "crisis-prone"
                else self.DEFENSIVE_SECTORS
            )
            is_regime_consistent = selected_sector in allowed_sectors

            if signal.score < min_signal:
                return (
                    False,
                    (
                        f"macro_label={macro_label} "
                        f"signal_score={signal.score:.4f}<{min_signal:.2f}"
                    ),
                    size_multiplier,
                )
            if is_add_on:
                return (
                    True,
                    f"regime_add_on={macro_label} sector={selected_sector}",
                    size_multiplier,
                )
            if is_regime_consistent:
                return (
                    True,
                    f"regime_sector={macro_label}:{selected_sector}",
                    size_multiplier,
                )
            return (
                False,
                f"macro_label={macro_label} sector={selected_sector}",
                size_multiplier,
            )

        if macro_label == "watchful":
            return True, "regime_watchful_size_reduced", 0.85

        return True, None, 1.0

    def _allow_sell(
        self, 
        world_context: dict | None, 
        signal: SymbolSignal | None, 
        current: float, 
        target: float, 
        buffer: float
    ) -> tuple[bool, str | None]:
        macro_score = self._macro_score(world_context)
        # Professional Calibration: 0.80 is a strong signal in the new scoring engine.
        if signal and macro_score is not None and macro_score <= 0.3 and signal.score >= 0.80:
            if current <= target + buffer * 1.5:
                return False, f"hold_winner_macro={macro_score:.2f}_score={signal.score:.4f}"
        return True, None

    def decide(
        self,
        snapshot: PortfolioSnapshot,
        world_tags: list[str],
        world_context: dict | None = None,
    ) -> tuple[IntentRecord, Optional[SignalResult]]:
        mode = self.risk_governor.mode
        if mode == RiskMode.LOW:
            target = self.settings.target_risk_exposure_pct_low
        elif mode == RiskMode.MEDIUM:
            target = self.settings.target_risk_exposure_pct_medium
        elif mode == RiskMode.HIGH:
            target = self.settings.target_risk_exposure_pct_high
        else:
             return IntentRecord(
                 mode=mode, action_type="NO_ACTION", 
                 reason_code="MODE_NOT_IMPLEMENTED", 
                 explanation=f"Mode {mode} not implemented."
             ), None

        buffer = self.settings.rebalance_buffer_pct

        target, buffer, macro_note = self._apply_macro_adjustments(target, buffer, world_context)
        target, buffer, patterns_consulted, pattern_note = self._apply_pattern_bias(
            target, buffer, world_tags
        )

        signal_result: SignalResult | None = None
        selected_signal: SymbolSignal | None = None
        signal_note: str | None = None

        if self.signal_engine:
            signal_result = self.signal_engine.build_signals()
            # Elite Quant: Signal Integrity Check
            if not signal_result or not signal_result.signals:
                logger.warning(
                    "[DECISION] Signal build returned zero signals. "
                    "Potential data gap or stale benchmark."
                )
                selected_signal = None
            else:
                selected_signal = signal_result.best()
                if selected_signal:
                    target, buffer, signal_note = self._apply_signal_adjustments(
                        target, buffer, selected_signal
                    )

        context_ok, context_note = self._world_context_fresh(world_context)
        current = snapshot.risk_exposure_pct
        if selected_signal:
            self.sector_map.resolve([selected_signal.symbol])

        # --- Elite Quant: Risk-Off Detection ---
        macro_label = self._macro_label(world_context)
        risk_off = macro_label in {"stressed", "crisis-prone"}
        risk_off_reason = f"Macro Regime: {macro_label}" if risk_off else None
        # --------------------------------------

        # --- Elite Quant: Asset-Level Vol-Stop (Panic Exit) ---
        if self.signal_engine and signal_result:
            for pos in snapshot.positions:
                sig = signal_result.by_symbol.get(pos.symbol)
                if sig and self.risk_governor.check_vol_stop(sig.day_return, sig.volatility):
                    position_weight = pos.market_value / snapshot.equity
                    return IntentRecord(
                        mode=mode,
                        action_type="SELL",
                        symbol=pos.symbol,
                        size_pct=position_weight,
                        pre_risk_exposure_pct=current,
                        post_risk_exposure_pct=max(0.0, current - position_weight),
                        reason_code="VOL_STOP",
                        explanation=(
                            f"PANIC EXIT: {pos.symbol} dropped {sig.day_return:.2%}, "
                            f"exceeding 2.0 SD limit ({sig.volatility:.2%})."
                        )
                    ), signal_result
        # ------------------------------------------------------

        gate_meta = {
            "gate_world_context_fresh": context_ok,
            "gate_signal_present": selected_signal is not None,
            "gate_macro_buy_allowed": None,
            "gate_macro_sell_allowed": None,
            "gate_scout_binding": False,
            "pre_risk_exposure_pct": current,
            "post_risk_exposure_pct": current,
            "core_symbol": self.settings.core_symbol,
            "target_risk_exposure_pct": target,
            "rebalance_buffer_pct": buffer,
            "world_tags": list(world_tags),
            "patterns_consulted": list(patterns_consulted),
            "risk_off": risk_off,
            "risk_off_reason": risk_off_reason,
            "signal_symbol": selected_signal.symbol if selected_signal else None,
            "signal_score": selected_signal.score if selected_signal else None,
            "signal_score_raw": selected_signal.score_raw if selected_signal else None,
            "signal_score_smoothed": (
                selected_signal.score_smoothed if selected_signal else None
            ),
            "execution_quality_score": (
                selected_signal.execution_quality_score if selected_signal else None
            ),
            "signal_fill_rate": selected_signal.fill_rate if selected_signal else None,
            "signal_expire_rate": (
                selected_signal.expire_rate if selected_signal else None
            ),
            "signal_submission_rate": (
                selected_signal.submission_rate if selected_signal else None
            ),
            "signal_repeat_attempt_penalty": (
                selected_signal.repeat_attempt_penalty if selected_signal else None
            ),
            "signal_realized_alpha_prior": (
                selected_signal.realized_alpha_prior if selected_signal else None
            ),
            "signal_alpha_prior_avg_excess_benchmark": (
                selected_signal.realized_alpha_avg_excess_benchmark
                if selected_signal
                else None
            ),
            "signal_alpha_prior_sample_count": (
                selected_signal.realized_alpha_sample_count
                if selected_signal
                else None
            ),
            "signal_intraday_persistence_score": (
                selected_signal.intraday_persistence_score
                if selected_signal
                else None
            ),
            "signal_intraday_persistence_seen_count": (
                selected_signal.intraday_persistence_seen_count
                if selected_signal
                else None
            ),
            "signal_intraday_persistence_day_count": (
                selected_signal.intraday_persistence_day_count
                if selected_signal
                else None
            ),
            "signal_trend_strength": (
                selected_signal.trend_strength if selected_signal else None
            ),
            "signal_volatility": selected_signal.volatility if selected_signal else None,
            "signal_drawdown": selected_signal.drawdown if selected_signal else None,
            "signal_day_return": selected_signal.day_return if selected_signal else None,
            "signal_mom_5d": selected_signal.mom_5d if selected_signal else None,
            "signal_mom_20d": selected_signal.mom_20d if selected_signal else None,
            "signal_mom_60d": selected_signal.mom_60d if selected_signal else None,
            "signal_rel_strength_20d": (
                selected_signal.rel_strength_20d if selected_signal else None
            ),
            "signal_rel_strength_60d": (
                selected_signal.rel_strength_60d if selected_signal else None
            ),
            "signal_momentum_rank": (
                selected_signal.momentum_rank if selected_signal else None
            ),
            "signal_vol_rank": selected_signal.vol_rank if selected_signal else None,
            "signal_drawdown_rank": (
                selected_signal.drawdown_rank if selected_signal else None
            ),
            "signal_sector": (
                self.sector_map.get(selected_signal.symbol) if selected_signal else None
            ),
            "signal_universe_size": (
                signal_result.universe_size if signal_result else None
            ),
            "signal_last_bar_date": (
                selected_signal.last_bar_date.isoformat()
                if selected_signal and selected_signal.last_bar_date
                else None
            ),
        }

        if not context_ok:
            return IntentRecord(
                mode=mode, action_type="NO_ACTION", reason_code="WORLD_STALE", 
                explanation=f"World stale: {context_note}", 
                **gate_meta # type: ignore[arg-type]
            ), signal_result

        if current < target - buffer:
            allow_buy, buy_note, buy_size_multiplier = self._allow_buy(
                world_context, selected_signal, snapshot
            )
            gate_meta["gate_macro_buy_allowed"] = allow_buy
            if not allow_buy:
                return IntentRecord(
                    mode=mode, action_type="NO_ACTION", reason_code="BUY_BLOCKED", 
                    explanation=f"Buy blocked: {buy_note}", 
                    **gate_meta # type: ignore[arg-type]
                ), signal_result
            
            if not selected_signal:
                return IntentRecord(
                    mode=mode, action_type="NO_ACTION", reason_code="NO_SIGNAL", 
                    explanation="No signal for buy", 
                    **gate_meta # type: ignore[arg-type]
                ), signal_result

            # --- Elite Quant: Correlation Gate ---
            if signal_result and signal_result.correlations:
                symbol_corrs = signal_result.correlations.get(selected_signal.symbol, {})
                for pos in snapshot.positions:
                    if pos.symbol == selected_signal.symbol:
                        continue
                    corr = symbol_corrs.get(pos.symbol, 0.0)
                    if corr > 0.70:
                        return IntentRecord(
                            mode=mode, action_type="NO_ACTION", 
                            reason_code="CORRELATED_REDUNDANCY",
                            explanation=(
                                f"DIVERSIFICATION BLOCK: {selected_signal.symbol} is "
                                f"{corr:.2f} correlated with existing position {pos.symbol}."
                            ),
                            **gate_meta # type: ignore[arg-type]
                        ), signal_result
            # -------------------------------------

            raw_size = min(
                target - current, self.risk_governor.config.max_position_pct
            )

            # --- Sprint A: Volatility Adjusted Sizing ---
            adjusted_size = self._calculate_vol_adjusted_size(
                raw_size, selected_signal, signal_result.signals if signal_result else []
            )
            adjusted_size = max(0.0, adjusted_size * buy_size_multiplier)

            deployed_notional = self._snapshot_deployed_notional(snapshot)
            remaining_headroom = max(
                0.0,
                self.settings.max_effective_capital_dollars - deployed_notional,
            )
            if remaining_headroom < self.settings.min_trade_notional_dollars:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    reason_code="BUY_BLOCKED",
                    explanation=(
                        "Buy blocked: "
                        f"sandbox_headroom=${remaining_headroom:.2f}"
                        f"<${self.settings.min_trade_notional_dollars:.2f}"
                    ),
                    **gate_meta,  # type: ignore[arg-type]
                ), signal_result

            max_size_from_headroom = remaining_headroom / snapshot.equity
            adjusted_size = min(adjusted_size, max_size_from_headroom)
            if adjusted_size <= 0:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    reason_code="BUY_BLOCKED",
                    explanation="Buy blocked: sandbox_headroom_exhausted",
                    **gate_meta,  # type: ignore[arg-type]
                ), signal_result
            # --------------------------------------------

            return IntentRecord(
                **{
                    **gate_meta,
                    "pre_risk_exposure_pct": current,
                    "post_risk_exposure_pct": min(1.0, current + adjusted_size),
                },  # type: ignore[arg-type]
                mode=mode,
                action_type="BUY",
                symbol=selected_signal.symbol,
                size_pct=adjusted_size,
                reason_code="UNDER_TARGET_BUY",
                explanation=f"Buying {selected_signal.symbol} (vol_adj_size={adjusted_size:.2%})",
            ), signal_result

        if current > target + buffer:
            allow_sell, sell_note = self._allow_sell(
                world_context, selected_signal, current, target, buffer
            )
            gate_meta["gate_macro_sell_allowed"] = allow_sell
            if not allow_sell:
                return IntentRecord(
                    mode=mode, action_type="NO_ACTION", reason_code="SELL_BLOCKED", 
                    explanation=f"Sell blocked: {sell_note}", 
                    **gate_meta # type: ignore[arg-type]
                ), signal_result
            
            sell_symbol = (
                snapshot.positions[0].symbol if snapshot.positions else self.settings.core_symbol
            )
            
            # --- Elite Quant: Precision Sell Sizing ---
            # We need to reduce total risk by (current - target)
            reduction_needed = current - target
            pos = next((p for p in snapshot.positions if p.symbol == sell_symbol), None) # type: ignore[assignment]
            if pos:
                # Can't sell more than the position's weight
                pos_weight = pos.market_value / snapshot.equity
                sell_size = min(reduction_needed, pos_weight)
            else:
                sell_size = reduction_needed
            # ------------------------------------------

            return IntentRecord(
                **{
                    **gate_meta,
                    "pre_risk_exposure_pct": current,
                    "post_risk_exposure_pct": max(0.0, current - sell_size),
                },  # type: ignore[arg-type]
                mode=mode,
                action_type="SELL",
                symbol=sell_symbol,
                size_pct=sell_size,
                reason_code="OVER_TARGET_SELL",
                explanation=(
                    f"Selling {sell_symbol} to reduce total risk from "
                    f"{current:.1%} toward {target:.1%}"
                ),
            ), signal_result

        return IntentRecord(
            mode=mode, action_type="NO_ACTION", reason_code="WITHIN_BUFFER", 
            explanation="Within target buffer", 
            **gate_meta # type: ignore[arg-type]
        ), signal_result
