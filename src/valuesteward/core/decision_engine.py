"""Decision engine for Value Steward."""

import os
from collections import defaultdict
from datetime import datetime, timezone

from valuesteward.config import ValueStewardSettings
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.sector_map import SectorMap
from valuesteward.core.signal_engine import SignalEngine, SignalResult, SymbolSignal
from valuesteward.data.portfolio_repository import PortfolioRepository
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode, TradeAction


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

    def _apply_signal_adjustments(
        self,
        target: float,
        buffer: float,
        signal: SymbolSignal | None,
    ) -> tuple[float, float, str | None]:
        if not signal:
            return target, buffer, None

        # Scale target with trend and penalties for volatility/drawdown.
        signal_factor = 1 + (signal.score * 5)
        signal_factor = max(0.4, min(1.2, signal_factor))
        target_adj = target * signal_factor

        # Widen buffer when volatility/drawdown rises.
        buffer_factor = 1 + min(1.0, signal.volatility * 10 + signal.drawdown * 2)
        buffer_adj = min(0.15, buffer * buffer_factor)

        note = (
            f"Signal {signal.symbol}: score={signal.score:.4f} "
            f"mom20={signal.mom_20d:.4f} mom60={signal.mom_60d:.4f} "
            f"rel20={signal.rel_strength_20d:.4f} rel60={signal.rel_strength_60d:.4f} "
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
        macro_score = None
        macro_label = None
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

            if isinstance(macro_score, (int, float)):
                original_target = target
                original_buffer = buffer
                target = target * (1 - min(0.5, macro_score) * 0.6)
                buffer = buffer * (1 + min(0.5, macro_score) * 0.6)
                macro_score_note = (
                    f"Macro score adjustment: score={macro_score:.2f} "
                    f"target {original_target:.0%}->{target:.0%} "
                    f"buffer {original_buffer:.0%}->{buffer:.0%}."
                )
                macro_note = (
                    f"{macro_note} {macro_score_note}"
                    if macro_note
                    else macro_score_note
                )

        return target, buffer, macro_note

    def _macro_score(self, world_context: dict | None) -> float | None:
        if not world_context or not isinstance(world_context, dict):
            return None
        macro_view = world_context.get("macro_view") or {}
        score = macro_view.get("macro_score")
        if isinstance(score, (int, float)):
            return float(score)
        return None

    def _risk_off_defensive_symbols(self) -> list[str]:
        raw = os.getenv(
            "VS_RISK_OFF_ETFS", "XLU,XLV,XLP,TLT,IEF,SHY,GLD"
        ).strip()
        if not raw:
            return []
        return [item.strip().upper() for item in raw.split(",") if item.strip()]

    def _risk_off_status(
        self, world_context: dict | None
    ) -> tuple[bool, str | None, list[str]]:
        enabled = os.getenv("VS_RISK_OFF_ENABLED", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
        }
        defensive_symbols = self._risk_off_defensive_symbols()
        if not enabled:
            return False, None, defensive_symbols

        macro_label = self._macro_label(world_context)
        macro_score = self._macro_score(world_context)
        label_raw = os.getenv("VS_RISK_OFF_LABELS", "stressed,crisis-prone")
        labels = {item.strip() for item in label_raw.split(",") if item.strip()}
        threshold = float(os.getenv("VS_RISK_OFF_MACRO_SCORE", "0.6"))

        triggered = False
        reason = None
        if macro_label and macro_label in labels:
            triggered = True
            reason = f"macro_label={macro_label}"
        if not triggered and macro_score is not None and macro_score >= threshold:
            triggered = True
            reason = f"macro_score={macro_score:.2f}"

        if triggered:
            note = (
                f"Risk-off mode active ({reason}); defensive={','.join(defensive_symbols) or 'n/a'}."
            )
            return True, note, defensive_symbols

        return False, None, defensive_symbols

    def _macro_label(self, world_context: dict | None) -> str | None:
        if not world_context or not isinstance(world_context, dict):
            return None
        macro_view = world_context.get("macro_view") or {}
        label = macro_view.get("macro_label")
        return str(label) if label is not None else None

    def _world_context_age_minutes(self, world_context: dict | None) -> float | None:
        if not world_context or not isinstance(world_context, dict):
            return None
        generated_at = world_context.get("generated_at")
        if not generated_at:
            return None
        try:
            ts = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
        except ValueError:
            return None
        now = datetime.now(tz=timezone.utc)
        return (now - ts.astimezone(timezone.utc)).total_seconds() / 60.0

    def _world_context_fresh(self, world_context: dict | None) -> tuple[bool, str | None]:
        required = os.getenv("VS_WORLD_CONTEXT_REQUIRED", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
        }
        if not required:
            return True, None
        age = self._world_context_age_minutes(world_context)
        if age is None:
            return False, "missing_or_invalid"
        max_age = float(os.getenv("VS_WORLD_CONTEXT_MAX_AGE_MINUTES", "180"))
        if age > max_age:
            return False, f"age={age:.1f}min max={max_age:.0f}min"
        return True, None

    def _allow_buy(self, world_context: dict | None, signal: SymbolSignal | None) -> tuple[bool, str | None]:
        macro_score = self._macro_score(world_context)
        macro_label = self._macro_label(world_context)
        block_score = float(os.getenv("VS_MACRO_BUY_BLOCK_SCORE", "0.6"))
        if macro_label in {"stressed", "crisis-prone"}:
            return False, f"macro_label={macro_label}"
        if macro_score is not None and macro_score >= block_score:
            return False, f"macro_score={macro_score:.2f}"
        if signal is None:
            return True, None
        min_score = float(os.getenv("VS_SIGNAL_BUY_MIN_SCORE", "0"))
        min_trend = float(os.getenv("VS_SIGNAL_BUY_MIN_TREND", "0"))
        if signal.score < min_score:
            return False, f"signal_score={signal.score:.4f}"
        if signal.trend_strength < min_trend:
            return False, f"signal_trend={signal.trend_strength:.4f}"
        return True, None

    def _allow_sell(
        self,
        world_context: dict | None,
        signal: SymbolSignal | None,
        current: float,
        target: float,
        buffer: float,
    ) -> tuple[bool, str | None]:
        macro_score = self._macro_score(world_context)
        min_macro = float(os.getenv("VS_SELL_HOLD_MACRO_MAX", "0.3"))
        min_signal = float(os.getenv("VS_SELL_HOLD_SIGNAL_MIN", "0.05"))
        buffer_mult = float(os.getenv("VS_SELL_HOLD_BUFFER_MULT", "1.5"))
        if signal and macro_score is not None:
            if macro_score <= min_macro and signal.score >= min_signal:
                if current <= target + buffer * buffer_mult:
                    return False, (
                        f"hold_macro={macro_score:.2f} "
                        f"signal={signal.score:.4f} "
                        f"overage={(current - target):.4f}"
                    )
        return True, None

    def _pick_by_sector(
        self,
        signals: list[SymbolSignal],
        max_symbols: int,
    ) -> list[str]:
        enabled = os.getenv("VS_SECTOR_BALANCE_ENABLED", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
        }
        if not enabled:
            return [sig.symbol for sig in signals[:max_symbols]]

        per_sector = int(os.getenv("VS_SECTOR_MAX_SYMBOLS", "1"))
        unknown_max = int(os.getenv("VS_SECTOR_UNKNOWN_MAX", str(per_sector)))

        picks: list[str] = []
        counts = defaultdict(int)
        for sig in signals:
            sector = self.sector_map.get(sig.symbol)
            limit = unknown_max if sector == "UNKNOWN" else per_sector
            if counts[sector] >= limit:
                continue
            picks.append(sig.symbol)
            counts[sector] += 1
            if len(picks) >= max_symbols:
                break
        return picks

    def _prefetch_sectors(self, signals: list[SymbolSignal] | None) -> None:
        if not signals:
            return
        limit = int(os.getenv("VS_SECTOR_PREFETCH_LIMIT", "200"))
        if limit <= 0:
            return
        symbols = [sig.symbol for sig in signals[:limit]]
        self.sector_map.resolve(symbols)

    def _sort_positions_for_risk_off(
        self,
        positions: list,
        signal_result: SignalResult | None,
        defensive_set: set[str],
    ) -> list:
        if not positions:
            return []
        scored = []
        for pos in positions:
            score = -1.0
            if signal_result:
                sig = signal_result.by_symbol.get(pos.symbol)
                if sig:
                    score = sig.score
            is_defensive = pos.symbol in defensive_set
            scored.append((is_defensive, score, pos))
        scored.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in scored]

    def decide(
        self,
        snapshot: PortfolioSnapshot,
        world_tags: list[str],
        world_context: dict | None = None,
    ) -> IntentRecord:
        """Return a decision intent.

        v0 always returns NO_ACTION; real strategy will be added later.
        """

        mode = self.risk_governor.mode
        target = self.settings.target_risk_exposure_pct_low
        buffer = self.settings.rebalance_buffer_pct
        macro_note = None
        target, buffer, macro_note = self._apply_macro_adjustments(
            target, buffer, world_context
        )

        risk_off, risk_off_note, defensive_symbols = self._risk_off_status(world_context)
        defensive_set = {item for item in defensive_symbols if item}
        risk_note = f" {risk_off_note}" if risk_off_note else ""
        require_signal = (
            os.getenv("VS_REQUIRE_SIGNAL", "true").strip().lower()
            in {"1", "true", "yes", "y"}
        )

        signal_note = None
        signal_result: SignalResult | None = None
        selected_signal: SymbolSignal | None = None
        defensive_signals: list[SymbolSignal] = []
        if self.signal_engine:
            signal_result = self.signal_engine.build_signals()
            selected_signal = signal_result.best()

            if risk_off and defensive_set:
                defensive_signals = [
                    sig for sig in signal_result.signals if sig.symbol in defensive_set
                ]
                if defensive_signals:
                    selected_signal = defensive_signals[0]

            if selected_signal:
                target, buffer, signal_note = self._apply_signal_adjustments(
                    target, buffer, selected_signal
                )
            if signal_result:
                if signal_result.top_limit:
                    evaluated_total = (
                        signal_result.evaluated_total
                        if signal_result.evaluated_total is not None
                        else signal_result.evaluated
                    )
                    universe_note = (
                        f"Universe scan: total={signal_result.universe_size} "
                        f"evaluated={evaluated_total} top_limit={signal_result.top_limit} "
                        f"kept={signal_result.evaluated} skipped={signal_result.skipped}."
                    )
                else:
                    universe_note = (
                        f"Universe scan: total={signal_result.universe_size} "
                        f"evaluated={signal_result.evaluated} skipped={signal_result.skipped}."
                    )
                smooth_note = None
                if signal_result.smoothing_days and signal_result.smoothing_alpha:
                    smooth_note = (
                        f"Signal smoothing: days={signal_result.smoothing_days} "
                        f"alpha={signal_result.smoothing_alpha:.2f}."
                    )
                signal_note = (
                    f"{signal_note} {universe_note}"
                    if signal_note
                    else universe_note
                )
                if smooth_note:
                    signal_note = (
                        f"{signal_note} {smooth_note}"
                        if signal_note
                        else smooth_note
                    )

        if signal_result:
            self._prefetch_sectors(signal_result.signals)

        signal_meta = {
            "signal_symbol": selected_signal.symbol if selected_signal else None,
            "signal_sector": self.sector_map.get(selected_signal.symbol)
            if selected_signal
            else None,
            "signal_score": selected_signal.score if selected_signal else None,
            "signal_score_raw": selected_signal.score_raw if selected_signal else None,
            "signal_score_smoothed": selected_signal.score_smoothed
            if selected_signal
            else None,
            "signal_trend_strength": selected_signal.trend_strength if selected_signal else None,
            "signal_volatility": selected_signal.volatility if selected_signal else None,
            "signal_drawdown": selected_signal.drawdown if selected_signal else None,
            "signal_day_return": selected_signal.day_return if selected_signal else None,
            "signal_mom_5d": selected_signal.mom_5d if selected_signal else None,
            "signal_mom_20d": selected_signal.mom_20d if selected_signal else None,
            "signal_mom_60d": selected_signal.mom_60d if selected_signal else None,
            "signal_rel_strength_20d": selected_signal.rel_strength_20d if selected_signal else None,
            "signal_rel_strength_60d": selected_signal.rel_strength_60d if selected_signal else None,
            "signal_momentum_rank": selected_signal.momentum_rank if selected_signal else None,
            "signal_vol_rank": selected_signal.vol_rank if selected_signal else None,
            "signal_drawdown_rank": selected_signal.drawdown_rank if selected_signal else None,
            "signal_universe_size": signal_result.universe_size if signal_result else None,
            "risk_off": risk_off,
            "risk_off_reason": risk_off_note,
        }

        if require_signal and not selected_signal:
            return IntentRecord(
                mode=mode,
                action_type="NO_ACTION",
                core_symbol=self.settings.core_symbol,
                target_exposure_pct=target,
                buffer_pct=buffer,
                reason_code="NO_SIGNAL",
                pre_risk_exposure_pct=snapshot.risk_exposure_pct,
                post_risk_exposure_pct=snapshot.risk_exposure_pct,
                target_risk_exposure_pct=target,
                rebalance_buffer_pct=buffer,
                world_tags=world_tags,
                patterns_consulted=[],
                explanation=(
                    "No eligible signal available; skipping trades."
                    + (f" {macro_note}" if macro_note else "")
                    + (f" {signal_note}" if signal_note else "")
                    + risk_note
                ),
                **signal_meta,
            )

        max_target = float(os.getenv("VS_MAX_TARGET_EXPOSURE_PCT", "0.30"))
        target = min(target, max_target)
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
                **signal_meta,
            )

        core_symbol = self.settings.core_symbol
        selected_symbol = selected_signal.symbol if selected_signal else None
        current = snapshot.risk_exposure_pct
        max_pos = self.risk_governor.config.max_position_pct
        position = self.portfolio_repository.get_position_for_symbol(
            snapshot, selected_symbol
        )
        max_symbols = getattr(self.settings, "max_symbols_per_day", 5)
        max_total_notional = getattr(self.settings, "max_effective_capital_dollars", 20.0)
        max_trade_notional = getattr(self.settings, "max_trade_notional_dollars", 5.0)
        min_trade_notional = getattr(self.settings, "min_trade_notional_dollars", 1.0)
        cash_available = snapshot.cash or 0.0
        equity = snapshot.equity or 0.0
        allow_buy, buy_block_note = self._allow_buy(world_context, selected_signal)
        allow_sell, sell_block_note = self._allow_sell(
            world_context, selected_signal, current, target, buffer
        )
        if risk_off and defensive_symbols:
            allow_defensive = (
                os.getenv("VS_RISK_OFF_ALLOW_DEFENSIVE_BUY", "true")
                .strip()
                .lower()
                in {"1", "true", "yes", "y"}
            )
            if allow_defensive and not allow_buy:
                allow_buy = True
                note = "risk_off_override"
                buy_block_note = (
                    f"{note}({buy_block_note})" if buy_block_note else note
                )
        context_ok, context_note = self._world_context_fresh(world_context)
        if not context_ok:
            return IntentRecord(
                mode=mode,
                action_type="NO_ACTION",
                core_symbol=selected_symbol,
                target_exposure_pct=target,
                buffer_pct=buffer,
                reason_code="WORLD_CONTEXT_STALE",
                pre_risk_exposure_pct=current,
                post_risk_exposure_pct=current,
                target_risk_exposure_pct=target,
                rebalance_buffer_pct=buffer,
                world_tags=world_tags,
                patterns_consulted=[],
                explanation=(
                    "World context stale; no trades permitted."
                    + (f" {context_note}" if context_note else "")
                    + (f" {macro_note}" if macro_note else "")
                    + (f" {signal_note}" if signal_note else "")
                    + risk_note
                ),
                **signal_meta,
            )
        rotation_enabled = (
            os.getenv("VS_ENABLE_ROTATION", "true").strip().lower()
            in {"1", "true", "yes", "y"}
        )

        if current < target - buffer:
            if not allow_buy:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=selected_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="BUY_BLOCKED",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                explanation=(
                    "Buy blocked by macro/market gate."
                    + (f" {buy_block_note}" if buy_block_note else "")
                    + (f" {macro_note}" if macro_note else "")
                    + (f" {signal_note}" if signal_note else "")
                    + risk_note
                ),
                **signal_meta,
            )
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
                    explanation=(
                        "Trade blocked by risk governor (caps exceeded)."
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    **signal_meta,
                )
            if selected_symbol is None:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=core_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="NO_SIGNAL",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation=(
                        "No eligible signal available; skipping buys."
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    **signal_meta,
                )
            if risk_off and defensive_symbols and not defensive_signals:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=selected_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="RISK_OFF_NO_DEFENSIVE_SIGNAL",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation=(
                        "Risk-off active but no defensive signals were eligible; "
                        "skipping buys."
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    **signal_meta,
                )

            actions: list[TradeAction] = []
            action_symbols = [selected_symbol]
            if risk_off and defensive_symbols:
                if defensive_signals:
                    action_symbols = self._pick_by_sector(
                        defensive_signals, max_symbols
                    )
            elif signal_result and signal_result.signals:
                action_symbols = self._pick_by_sector(
                    signal_result.signals, max_symbols
                )
            budget = min(max_total_notional, cash_available)
            per_action = budget / len(action_symbols) if action_symbols else 0.0
            for symbol in action_symbols:
                notional = min(per_action, max_trade_notional)
                if notional < min_trade_notional:
                    continue
                size_pct_action = notional / equity if equity else None
                if size_pct_action is not None and not self.risk_governor.check_trade_allowed(
                    snapshot, size_pct_action
                ):
                    continue
                actions.append(
                    TradeAction(
                        symbol=symbol,
                        side="buy",
                        notional=round(notional, 2),
                        size_pct=size_pct_action,
                        reason="UNDER_TARGET_BUY",
                    )
                )

            if not actions:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=selected_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="BUY_BUDGET_TOO_SMALL",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation=(
                        "Buy budget too small to place any orders."
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    **signal_meta,
                )

            post_risk = min(current + size_pct, 1.0)
            action_type = "MULTI" if len(actions) > 1 else "BUY"
            return IntentRecord(
                mode=mode,
                action_type=action_type,
                symbol=actions[0].symbol if actions else selected_symbol,
                size_pct=size_pct,
                core_symbol=selected_symbol,
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
                    f"Increasing exposure from {current:.0%} "
                    f"toward LOW-mode target {target:.0%} (buffer ±{buffer:.0%}). "
                    f"Planned buys={len(actions)} total_budget=${budget:.2f}."
                    + (f" {macro_note}" if macro_note else "")
                    + (f" {signal_note}" if signal_note else "")
                    + risk_note
                ),
                actions=actions,
                **signal_meta,
            )

        if current > target + buffer and snapshot.positions:
            if not allow_sell:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=selected_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="SELL_BLOCKED",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation=(
                        "Sell blocked by macro/market gate."
                        + (f" {sell_block_note}" if sell_block_note else "")
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    **signal_meta,
                )
            delta = current - target
            size_pct = min(delta, max_pos)
            post_risk = max(current - size_pct, 0.0)
            sell_symbol = position.symbol if position else snapshot.positions[0].symbol
            actions: list[TradeAction] = []
            positions = snapshot.positions[:]
            if risk_off and defensive_set:
                positions = self._sort_positions_for_risk_off(
                    positions, signal_result, defensive_set
                )
            elif signal_result:
                scored = []
                for pos in positions:
                    sig = signal_result.by_symbol.get(pos.symbol)
                    if sig:
                        scored.append((pos, sig.score))
                    else:
                        scored.append((pos, -1))
                scored.sort(key=lambda item: item[1])
                positions = [item[0] for item in scored]
            if positions:
                sell_symbol = positions[0].symbol
            positions = positions[:max_symbols]
            total_position_value = sum(pos.market_value for pos in positions)
            budget = min(max_total_notional, total_position_value)
            per_action = budget / len(positions) if positions else 0.0
            for pos in positions:
                notional = min(per_action, max_trade_notional, pos.market_value)
                if notional < min_trade_notional:
                    continue
                size_pct_action = notional / equity if equity else None
                actions.append(
                    TradeAction(
                        symbol=pos.symbol,
                        side="sell",
                        notional=round(notional, 2),
                        size_pct=size_pct_action,
                        reason="OVER_TARGET_SELL",
                    )
                )

            if not actions:
                return IntentRecord(
                    mode=mode,
                    action_type="NO_ACTION",
                    core_symbol=sell_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="SELL_BUDGET_TOO_SMALL",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation=(
                        "Sell budget too small to place any orders."
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    **signal_meta,
                )

            action_type = "MULTI" if len(actions) > 1 else "SELL"
            return IntentRecord(
                mode=mode,
                action_type=action_type,
                symbol=actions[0].symbol if actions else sell_symbol,
                size_pct=size_pct,
                core_symbol=sell_symbol,
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
                    f"Reducing exposure from {current:.0%} "
                    f"toward LOW-mode target {target:.0%} (buffer ±{buffer:.0%}). "
                    f"Planned sells={len(actions)} total_budget=${budget:.2f}."
                    + (f" {macro_note}" if macro_note else "")
                    + (f" {signal_note}" if signal_note else "")
                    + risk_note
                ),
                actions=actions,
                **signal_meta,
            )

        if rotation_enabled and snapshot.positions and cash_available >= min_trade_notional:
            buy_actions: list[TradeAction] = []
            sell_actions: list[TradeAction] = []

            if allow_buy:
                action_symbols = [selected_symbol]
                if risk_off and defensive_symbols:
                    if defensive_signals:
                        action_symbols = self._pick_by_sector(
                            defensive_signals, max_symbols
                        )
                    else:
                        action_symbols = []
                elif signal_result and signal_result.signals:
                    action_symbols = self._pick_by_sector(
                        signal_result.signals, max_symbols
                    )
                budget = min(max_total_notional, cash_available)
                per_action = budget / len(action_symbols) if action_symbols else 0.0
                for symbol in action_symbols:
                    notional = min(per_action, max_trade_notional)
                    if notional < min_trade_notional:
                        continue
                    size_pct_action = notional / equity if equity else None
                    if size_pct_action is not None and not self.risk_governor.check_trade_allowed(
                        snapshot, size_pct_action
                    ):
                        continue
                    buy_actions.append(
                        TradeAction(
                            symbol=symbol,
                            side="buy",
                            notional=round(notional, 2),
                            size_pct=size_pct_action,
                            reason="ROTATION_BUY",
                        )
                    )

            if allow_sell:
                positions = snapshot.positions[:]
                if risk_off and defensive_set:
                    positions = self._sort_positions_for_risk_off(
                        positions, signal_result, defensive_set
                    )
                elif signal_result:
                    scored = []
                    for pos in positions:
                        sig = signal_result.by_symbol.get(pos.symbol)
                        if sig:
                            scored.append((pos, sig.score))
                        else:
                            scored.append((pos, -1))
                    scored.sort(key=lambda item: item[1])
                    positions = [item[0] for item in scored]
                positions = positions[:max_symbols]
                total_position_value = sum(pos.market_value for pos in positions)
                budget = min(max_total_notional, total_position_value)
                per_action = budget / len(positions) if positions else 0.0
                for pos in positions:
                    notional = min(per_action, max_trade_notional, pos.market_value)
                    if notional < min_trade_notional:
                        continue
                    size_pct_action = notional / equity if equity else None
                    sell_actions.append(
                        TradeAction(
                            symbol=pos.symbol,
                            side="sell",
                            notional=round(notional, 2),
                            size_pct=size_pct_action,
                            reason="ROTATION_SELL",
                        )
                    )

            if buy_actions or sell_actions:
                actions = sell_actions + buy_actions
                action_type = "MULTI"
                return IntentRecord(
                    mode=mode,
                    action_type=action_type,
                    symbol=actions[0].symbol,
                    size_pct=0.0,
                    core_symbol=selected_symbol,
                    target_exposure_pct=target,
                    buffer_pct=buffer,
                    reason_code="ROTATION",
                    pre_risk_exposure_pct=current,
                    post_risk_exposure_pct=current,
                    target_risk_exposure_pct=target,
                    rebalance_buffer_pct=buffer,
                    world_tags=world_tags,
                    patterns_consulted=[],
                    explanation=(
                        "Rotation plan: reallocating across signals within exposure band."
                        + (f" {macro_note}" if macro_note else "")
                        + (f" {signal_note}" if signal_note else "")
                        + risk_note
                    ),
                    actions=actions,
                    **signal_meta,
                )

        return IntentRecord(
            mode=mode,
            action_type="NO_ACTION",
            core_symbol=selected_symbol,
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
                + (f" {macro_note}" if macro_note else "")
                + (f" {signal_note}" if signal_note else "")
                + risk_note
            ),
            **signal_meta,
        )
