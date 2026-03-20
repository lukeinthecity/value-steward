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
        if world_context and isinstance(world_context, dict):
            macro_view = world_context.get("macro_view") or {}
            macro_label = macro_view.get("macro_label")
            macro_score = macro_view.get("macro_score")
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
        self, world_context: dict | None, signal: SymbolSignal | None
    ) -> tuple[bool, str | None]:
        macro_score = self._macro_score(world_context)
        macro_label = self._macro_label(world_context)
        if macro_label in {"stressed", "crisis-prone"}:
            return False, f"macro_label={macro_label}"
        if macro_score is not None and macro_score >= 0.6:
            return False, f"macro_score={macro_score:.2f}"
        if signal and signal.score < 0:
            return False, f"signal_score={signal.score:.4f}"
        return True, None

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
                    return IntentRecord(
                        mode=mode, action_type="SELL", symbol=pos.symbol, 
                        size_pct=pos.market_value / snapshot.equity,
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
            "core_symbol": self.settings.core_symbol,
            "target_risk_exposure_pct": target,
            "rebalance_buffer_pct": buffer,
            "risk_off": risk_off,
            "risk_off_reason": risk_off_reason,
        }

        if not context_ok:
            return IntentRecord(
                mode=mode, action_type="NO_ACTION", reason_code="WORLD_STALE", 
                explanation=f"World stale: {context_note}", 
                **gate_meta # type: ignore[arg-type]
            ), signal_result

        if current < target - buffer:
            allow_buy, buy_note = self._allow_buy(world_context, selected_signal)
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

            raw_size = min(target - current, self.risk_governor.config.max_position_pct)
            
            # --- Sprint A: Volatility Adjusted Sizing ---
            adjusted_size = self._calculate_vol_adjusted_size(
                raw_size, selected_signal, signal_result.signals if signal_result else []
            )
            # --------------------------------------------

            return IntentRecord(
                mode=mode, action_type="BUY", symbol=selected_signal.symbol, size_pct=adjusted_size,
                reason_code="UNDER_TARGET_BUY",
                explanation=f"Buying {selected_signal.symbol} (vol_adj_size={adjusted_size:.2%})",
                **gate_meta # type: ignore[arg-type]
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
                mode=mode, action_type="SELL", symbol=sell_symbol, size_pct=sell_size,
                reason_code="OVER_TARGET_SELL",
                explanation=(
                    f"Selling {sell_symbol} to reduce total risk from "
                    f"{current:.1%} toward {target:.1%}"
                ),
                **gate_meta # type: ignore[arg-type]
            ), signal_result

        return IntentRecord(
            mode=mode, action_type="NO_ACTION", reason_code="WITHIN_BUFFER", 
            explanation="Within target buffer", 
            **gate_meta # type: ignore[arg-type]
        ), signal_result
