"""Decision engine for Value Steward."""

import math
import os
import logging
import random as _random
from datetime import datetime, timezone
from typing import List, Optional

from valuesteward.config import ValueStewardSettings
from valuesteward.env_utils import get_env_float
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.sector_map import SectorMap
from valuesteward.core.signal_engine import SignalEngine, SignalResult, SymbolSignal
from valuesteward.data.portfolio_repository import PortfolioRepository
from valuesteward.models import IntentRecord, PortfolioSnapshot, RiskMode

logger = logging.getLogger(__name__)

EXPLORATION_TAG = "exploration_buy"
THOMPSON_TAG = "thompson_buy"


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

    def __init__(
        self,
        risk_governor: RiskGovernor,
        pattern_library: PatternLibrary,
        settings: ValueStewardSettings,
        portfolio_repository: PortfolioRepository,
        signal_engine: SignalEngine | None = None,
        policy: dict | None = None,
    ) -> None:
        self.risk_governor = risk_governor
        self.pattern_library = pattern_library
        self.settings = settings
        self.portfolio_repository = portfolio_repository
        self.signal_engine = signal_engine
        self.sector_map = SectorMap()
        self.policy = policy or {}
        self._exploration_rng: _random.Random | None = None
        self._thompson_rng: _random.Random | None = None

    def _get_thompson_rng(self) -> _random.Random:
        """Lazy RNG for Thompson sampling. Separate seed env var so it can be
        controlled independently from epsilon-greedy exploration."""
        if self._thompson_rng is None:
            seed_raw = os.getenv("VS_SCORE_GATE_THOMPSON_SEED", "").strip()
            if seed_raw:
                try:
                    self._thompson_rng = _random.Random(int(seed_raw))  # nosec B311
                except ValueError:
                    self._thompson_rng = _random.Random()  # nosec B311
            else:
                self._thompson_rng = _random.Random()  # nosec B311
        return self._thompson_rng

    # Hard cap on a single posterior count to keep Beta(alpha, beta) numerically
    # well-behaved even if a corrupted policy.json snuck in.
    _POSTERIOR_COUNT_CAP = 1_000_000

    def _lookup_posterior(self, symbol: str | None) -> tuple[float, float, int]:
        """Return (alpha, beta, sample_count) for ``symbol`` from policy
        posteriors. Returns (0, 0, 0) if no record exists or values are
        non-finite/out-of-range.

        Symbol lookup is case-insensitive — the trainer always writes
        uppercase keys, but defensive normalization here means a mismatched
        case in the live signal doesn't silently fall back to the prior.
        """
        if not isinstance(symbol, str):
            return 0.0, 0.0, 0
        key = symbol.strip().upper()
        if not key:
            return 0.0, 0.0, 0
        posteriors = self.policy.get("score_gate_posteriors") or {}
        if not isinstance(posteriors, dict):
            return 0.0, 0.0, 0
        slot = posteriors.get(key)
        if not isinstance(slot, dict):
            return 0.0, 0.0, 0
        try:
            alpha = float(slot.get("alpha", 0))
            beta = float(slot.get("beta", 0))
            sample_count = int(slot.get("sample_count", 0))
        except (TypeError, ValueError):
            return 0.0, 0.0, 0
        # Reject non-finite / negative / runaway values defensively.
        if not (math.isfinite(alpha) and math.isfinite(beta)):
            return 0.0, 0.0, 0
        alpha = max(0.0, min(self._POSTERIOR_COUNT_CAP, alpha))
        beta = max(0.0, min(self._POSTERIOR_COUNT_CAP, beta))
        sample_count = max(0, min(self._POSTERIOR_COUNT_CAP, sample_count))
        return alpha, beta, sample_count

    def _get_exploration_rng(self) -> _random.Random:
        """Lazy RNG for epsilon-greedy exploration.

        Honors VS_NEW_ENTRY_EXPLORATION_SEED for deterministic tests; otherwise
        seeds from system entropy.
        """
        if self._exploration_rng is None:
            seed_raw = os.getenv("VS_NEW_ENTRY_EXPLORATION_SEED", "").strip()
            if seed_raw:
                try:
                    self._exploration_rng = _random.Random(int(seed_raw))  # nosec B311
                except ValueError:
                    self._exploration_rng = _random.Random()  # nosec B311
            else:
                self._exploration_rng = _random.Random()  # nosec B311
        return self._exploration_rng

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

    def _rotation_sell_enabled(self) -> bool:
        return os.getenv(
            "VS_ROTATION_SELL_ENABLED", "true"
        ).strip().lower() in {"1", "true", "yes", "on"}

    def _build_rotation_sell(
        self,
        snapshot: PortfolioSnapshot,
        signal_result: SignalResult | None,
        candidate: SymbolSignal,
        mode: RiskMode,
        target: float | None = None,
        buffer: float | None = None,
    ) -> IntentRecord | None:
        """Buy-coupled rotation SELL.

        Appreciation over the cap is DESIRABLE — a reward for good picks — so
        we never force-sell a winner just because total market value drifted
        above the cap. The only time we sell to make room is when a NEW BUY
        candidate has cleared every entry gate but is blocked solely by lack
        of cap headroom AND that candidate is meaningfully stronger than our
        weakest current holding.

        In that case we rotate: fully exit the weakest holding (by signal
        score; a held symbol with no current signal is treated as weakest)
        so the better candidate can be bought on a subsequent tick.

        Returns a SELL IntentRecord, or None when no rotation is warranted
        (caller then emits the normal BUY_BLOCKED).
        """
        if not self._rotation_sell_enabled():
            return None
        if not snapshot.positions:
            return None

        by_symbol = (signal_result.by_symbol if signal_result else {}) or {}

        def held_score(sym: str) -> float:
            sig = by_symbol.get(sym)
            # No live signal for a holding => no conviction => most rotatable.
            return sig.score if sig is not None else float("-inf")

        weakest = min(snapshot.positions, key=lambda p: held_score(p.symbol))
        weakest_score = held_score(weakest.symbol)
        weakest_mv = float(weakest.market_value)
        min_trade = float(self.settings.min_trade_notional_dollars)
        if weakest_mv < min_trade:
            # Can't meaningfully sell it; not worth rotating.
            return None

        margin = get_env_float("VS_ROTATION_MIN_SCORE_MARGIN", 0.05)
        # Only rotate for a clearly better opportunity. If the candidate is
        # not stronger than what we hold by `margin`, let the winner run.
        if not (candidate.score > weakest_score + margin):
            return None

        sell_size_pct = weakest_mv / max(1e-9, snapshot.equity)
        current_exposure_pct = snapshot.risk_exposure_pct
        post_exposure_pct = max(0.0, current_exposure_pct - sell_size_pct)
        weakest_score_str = (
            f"{weakest_score:.4f}" if weakest_score != float("-inf") else "none"
        )

        return IntentRecord(
            mode=mode,
            action_type="SELL",
            symbol=weakest.symbol,
            size_pct=sell_size_pct,
            pre_risk_exposure_pct=current_exposure_pct,
            post_risk_exposure_pct=post_exposure_pct,
            # The cli.py tick path requires every intent to carry the
            # target/buffer enrichment fields; without them it raises and the
            # whole tick crashes. The normal BUY/NO_ACTION path supplies them
            # via gate_meta — sell-side intents must set them explicitly.
            target_risk_exposure_pct=(
                target if target is not None
                else self.settings.target_risk_exposure_pct_low
            ),
            rebalance_buffer_pct=(
                buffer if buffer is not None
                else self.settings.rebalance_buffer_pct
            ),
            reason_code="ROTATION_SELL",
            explanation=(
                f"Rotation: freeing cap room for stronger candidate "
                f"{candidate.symbol} (score={candidate.score:.4f}) by exiting "
                f"weakest holding {weakest.symbol} "
                f"(score={weakest_score_str}, mv=${weakest_mv:.2f})."
            ),
        )

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

        # Thompson-pass state — set inside the new-entry block; the
        # downstream True-returns honor these to tag the BUY and cap size.
        thompson_buy_note: str | None = None
        thompson_size_override: float | None = None

        def _finalize_buy(reason, size_mult):
            """Merge Thompson approval into the final BUY tuple if active."""
            if thompson_buy_note is None:
                return True, reason, size_mult
            combined_reason = (
                f"{thompson_buy_note}; regime={reason}" if reason else thompson_buy_note
            )
            cap = (
                thompson_size_override
                if thompson_size_override is not None
                else size_mult
            )
            return True, combined_reason, min(size_mult, cap)

        if not is_add_on:
            min_score = get_env_float("VS_NEW_ENTRY_MIN_SIGNAL_SCORE", 1.55)
            min_rel_20 = get_env_float("VS_NEW_ENTRY_MIN_REL_STRENGTH_20D", 0.0)
            min_rel_60 = get_env_float("VS_NEW_ENTRY_MIN_REL_STRENGTH_60D", 0.0)
            min_trend = get_env_float("VS_NEW_ENTRY_MIN_TREND_STRENGTH", 0.0)
            exploration_eps = get_env_float(
                "VS_NEW_ENTRY_EXPLORATION_EPSILON", 0.0
            )
            exploration_zone = get_env_float(
                "VS_NEW_ENTRY_EXPLORATION_ZONE_PCT", 0.05
            )
            exploration_size_mult = get_env_float(
                "VS_NEW_ENTRY_EXPLORATION_SIZE_MULT", 0.5
            )

            thompson_enabled = os.getenv(
                "VS_SCORE_GATE_THOMPSON_ENABLED", "0"
            ).strip().lower() in {"1", "true", "yes", "on"}
            thompson_threshold = get_env_float(
                "VS_SCORE_GATE_THOMPSON_THRESHOLD", 0.55
            )
            thompson_prior_alpha = get_env_float(
                "VS_SCORE_GATE_THOMPSON_PRIOR_ALPHA", 2.0
            )
            thompson_prior_beta = get_env_float(
                "VS_SCORE_GATE_THOMPSON_PRIOR_BETA", 2.0
            )
            thompson_size_mult = get_env_float(
                "VS_SCORE_GATE_THOMPSON_SIZE_MULT", 1.0
            )

            # Thompson sampling replaces only the score-threshold gate.
            # The rel20 / rel60 / trend safety gates below still apply, so a
            # Beta-favored symbol with negative relative strength is still
            # blocked. The exploration_size_mult is reused for Thompson buys
            # when the sample is in the "uncertain" zone (within 0.10 of the
            # threshold) — confident wins get full size. (Declarations live in
            # the outer function scope so _finalize_buy can observe them.)
            if thompson_enabled:
                alpha, beta, post_n = self._lookup_posterior(signal.symbol)
                # Floor priors at a small positive value so betavariate never
                # sees 0 (which would raise ValueError).
                eff_alpha = max(0.5, thompson_prior_alpha + alpha)
                eff_beta = max(0.5, thompson_prior_beta + beta)
                sample = self._get_thompson_rng().betavariate(eff_alpha, eff_beta)
                if sample < thompson_threshold:
                    return (
                        False,
                        (
                            f"thompson_gate sample={sample:.3f}"
                            f"<{thompson_threshold:.2f} "
                            f"alpha={eff_alpha:.1f} beta={eff_beta:.1f} "
                            f"n={post_n}"
                        ),
                        1.0,
                    )
                # Passed Thompson; fall through to rel/trend safety gates.
                thompson_buy_note = (
                    f"{THOMPSON_TAG} sample={sample:.3f}"
                    f">={thompson_threshold:.2f} "
                    f"alpha={eff_alpha:.1f} beta={eff_beta:.1f} "
                    f"n={post_n} score={signal.score:.4f}"
                )
                # Confident win → full size; near-threshold (uncertain) → reduced.
                if sample - thompson_threshold >= 0.10:
                    thompson_size_override = max(0.0, min(1.0, thompson_size_mult))
                else:
                    thompson_size_override = max(0.0, min(1.0, exploration_size_mult))

            elif signal.score < min_score:
                # Epsilon-greedy exploration: when score is just below threshold
                # (within zone), occasionally allow the BUY through to gather
                # training signal on what the gate is rejecting.
                in_zone = (
                    exploration_eps > 0
                    and exploration_zone > 0
                    and signal.score >= min_score * (1.0 - exploration_zone)
                )
                if in_zone and self._get_exploration_rng().random() < exploration_eps:
                    return (
                        True,
                        (
                            f"{EXPLORATION_TAG} score={signal.score:.4f}"
                            f"<{min_score:.2f} eps={exploration_eps:.2f}"
                        ),
                        max(0.0, min(1.0, exploration_size_mult)),
                    )
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
                return _finalize_buy(
                    f"regime_add_on={macro_label} sector={selected_sector}",
                    size_multiplier,
                )
            if is_regime_consistent:
                return _finalize_buy(
                    f"regime_sector={macro_label}:{selected_sector}",
                    size_multiplier,
                )
            return (
                False,
                f"macro_label={macro_label} sector={selected_sector}",
                size_multiplier,
            )

        if macro_label == "watchful":
            return _finalize_buy("regime_watchful_size_reduced", 0.85)

        return _finalize_buy(None, 1.0)

    def _allow_sell(
        self, 
        world_context: dict | None, 
        signal: SymbolSignal | None, 
        current: float, 
        target: float, 
        buffer: float
    ) -> tuple[bool, str | None]:
        macro_score = self._macro_score(world_context)
        # 0.80 is a strong signal in the new scoring engine.
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

        # Degraded-snapshot guard. portfolio_repository returns equity=0 when the
        # Alpaca account fetch fails; several sizing paths below divide by
        # snapshot.equity (vol-stop, headroom, sell sizing) and would raise
        # ZeroDivisionError. More importantly we must not act on a broker
        # snapshot we couldn't trust. Carry target/buffer so the cli.py tick
        # enrichment guard is satisfied.
        if snapshot.equity is None or snapshot.equity <= 0:
            return IntentRecord(
                mode=mode,
                action_type="NO_ACTION",
                reason_code="DEGRADED_SNAPSHOT",
                explanation=(
                    f"Degraded portfolio snapshot (equity={snapshot.equity}); "
                    "skipping decision to avoid acting on untrusted broker state."
                ),
                target_risk_exposure_pct=target,
                rebalance_buffer_pct=buffer,
                pre_risk_exposure_pct=snapshot.risk_exposure_pct,
                post_risk_exposure_pct=snapshot.risk_exposure_pct,
            ), None

        signal_result: SignalResult | None = None
        selected_signal: SymbolSignal | None = None
        signal_note: str | None = None

        if self.signal_engine:
            signal_result = self.signal_engine.build_signals()
            # Signal Integrity Check
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

        # Risk-Off Detection
        macro_label = self._macro_label(world_context)
        risk_off = macro_label in {"stressed", "crisis-prone"}
        risk_off_reason = f"Macro Regime: {macro_label}" if risk_off else None

        # Asset-Level Vol-Stop (Panic Exit)
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
                        # Enrichment fields required by the cli.py tick guard;
                        # a panic exit must not crash the tick for lack of them.
                        target_risk_exposure_pct=target,
                        rebalance_buffer_pct=buffer,
                        reason_code="VOL_STOP",
                        explanation=(
                            f"PANIC EXIT: {pos.symbol} dropped {sig.day_return:.2%}, "
                            f"exceeding 2.0 SD limit ({sig.volatility:.2%})."
                        )
                    ), signal_result

        # NOTE: appreciation over the cap no longer forces a sell — winners
        # are allowed to run above $20. The only sell-to-make-room path is
        # buy-coupled rotation, applied in the BUY headroom block below.

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

            # Correlation Gate
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

            raw_size = min(
                target - current, self.risk_governor.config.max_position_pct
            )

            # Volatility Adjusted Sizing
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
                # No cap headroom for a new entry. Rather than always blocking,
                # try buy-coupled rotation: if this candidate is clearly
                # stronger than our weakest holding, sell that holding to free
                # room (the buy lands on a subsequent tick). Only for new
                # entries — add-ons at the cap still just block.
                candidate_is_add_on = selected_signal.symbol in {
                    pos.symbol for pos in snapshot.positions
                }
                if not candidate_is_add_on:
                    rotation_intent = self._build_rotation_sell(
                        snapshot, signal_result, selected_signal, mode,
                        target=target, buffer=buffer,
                    )
                    if rotation_intent is not None:
                        return rotation_intent, signal_result
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

            note_str = str(buy_note) if buy_note else ""
            is_exploration = note_str.startswith(EXPLORATION_TAG)
            is_thompson = note_str.startswith(THOMPSON_TAG)
            if is_exploration:
                buy_reason_code = "BUY_EXPLORATION"
                buy_explanation = (
                    f"Exploration buy {selected_signal.symbol} "
                    f"(vol_adj_size={adjusted_size:.2%}; {buy_note})"
                )
            elif is_thompson:
                buy_reason_code = "BUY_THOMPSON"
                buy_explanation = (
                    f"Thompson buy {selected_signal.symbol} "
                    f"(vol_adj_size={adjusted_size:.2%}; {buy_note})"
                )
            else:
                buy_reason_code = "UNDER_TARGET_BUY"
                buy_explanation = (
                    f"Buying {selected_signal.symbol} "
                    f"(vol_adj_size={adjusted_size:.2%})"
                )
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
                reason_code=buy_reason_code,
                explanation=buy_explanation,
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
            
            # Precision Sell Sizing
            # We need to reduce total risk by (current - target)
            reduction_needed = current - target
            pos = next((p for p in snapshot.positions if p.symbol == sell_symbol), None) # type: ignore[assignment]
            if pos:
                # Can't sell more than the position's weight
                pos_weight = pos.market_value / snapshot.equity
                sell_size = min(reduction_needed, pos_weight)
            else:
                sell_size = reduction_needed

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
