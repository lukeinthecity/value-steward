"""Intent logging for auditability."""

from __future__ import annotations

import logging
from valuesteward.core.memory import MemoryEngine
from valuesteward.models import IntentRecord

logger = logging.getLogger(__name__)

class IntentLogger:
    """Log IntentRecords to stdout and persistent memory.

    This is the core audit trail for the agent. No action should happen
    without an IntentRecord being logged.
    """

    def __init__(self, memory: MemoryEngine) -> None:
        self.memory = memory

    def log_intent(self, intent: IntentRecord) -> None:
        """Log an intent in a concise, human-readable format and JSONL."""

        self.memory.append(intent)

        timestamp = intent.timestamp.isoformat()
        target = intent.target_risk_exposure_pct
        buffer = intent.rebalance_buffer_pct
        extras = ""
        if target is not None and buffer is not None:
            extras = f" target={target:.2f} buffer={buffer:.2f}"
        policy_meta = ""
        if (
            intent.policy_schema_version is not None
            or intent.policy_version is not None
            or intent.policy_risk_level is not None
            or intent.policy_mode is not None
        ):
            schema = (
                intent.policy_schema_version
                if intent.policy_schema_version is not None
                else "-"
            )
            version = intent.policy_version if intent.policy_version is not None else "-"
            risk = (
                intent.policy_risk_level
                if intent.policy_risk_level is not None
                else "-"
            )
            mode = intent.policy_mode if intent.policy_mode is not None else "-"
            policy_meta = (
                f" policy_schema={schema} policy_v={version} "
                f"policy_risk={risk} policy_mode={mode}"
            )
        gate = ""
        if intent.policy_force_no_trade is not None:
            gate = f" policy_force_no_trade={intent.policy_force_no_trade}"
        gate_fields = []
        if intent.gate_reason:
            gate_fields.append(f"reason={intent.gate_reason}")
        if intent.gate_world_context_fresh is not None:
            gate_fields.append(f"context_ok={intent.gate_world_context_fresh}")
        if intent.gate_signal_required is not None:
            gate_fields.append(f"signal_required={intent.gate_signal_required}")
        if intent.gate_signal_present is not None:
            gate_fields.append(f"signal_present={intent.gate_signal_present}")
        if intent.gate_signal_fresh is not None:
            gate_fields.append(f"signal_fresh={intent.gate_signal_fresh}")
        if intent.gate_macro_buy_allowed is not None:
            gate_fields.append(f"macro_buy={intent.gate_macro_buy_allowed}")
        if intent.gate_macro_sell_allowed is not None:
            gate_fields.append(f"macro_sell={intent.gate_macro_sell_allowed}")
        if intent.gate_risk_governor_allowed is not None:
            gate_fields.append(f"risk_governor={intent.gate_risk_governor_allowed}")
        if gate_fields:
            gate = f"{gate} gates=({','.join(gate_fields)})"
        macro = ""
        if intent.world_macro_label is not None or intent.world_macro_score is not None:
            score = (
                f"{intent.world_macro_score:.2f}"
                if intent.world_macro_score is not None
                else "n/a"
            )
            scout_score = (
                f"{intent.world_scout_score:.2f}"
                if intent.world_scout_score is not None
                else "n/a"
            )
            macro = (
                f" world_macro={intent.world_macro_label or '-'} score={score} "
                f"scout={intent.world_scout_label or '-'} scout_score={scout_score}"
            )
            if intent.world_scout_thesis:
                macro = f"{macro} scout_thesis='{intent.world_scout_thesis}'"

        risk_off = ""
        if intent.risk_off is not None:
            risk_off = f" risk_off={intent.risk_off}"
            if intent.risk_off_reason:
                risk_off += f" reason={intent.risk_off_reason}"

        signal = ""
        if intent.signal_symbol is not None or intent.signal_score is not None:
            score = (
                f"{intent.signal_score:.4f}"
                if intent.signal_score is not None
                else "n/a"
            )
            if intent.signal_score_raw is not None:
                raw_score = f"{intent.signal_score_raw:.4f}"
                if raw_score != score:
                    score = f"{score} raw={raw_score}"
            day_ret = (
                f"{intent.signal_day_return:.2%}"
                if intent.signal_day_return is not None
                else "n/a"
            )
            sector = intent.signal_sector or "-"
            signal = (
                f" signal={intent.signal_symbol or '-'} sector={sector} "
                f"score={score} day_return={day_ret}"
            )

        plan = ""
        if intent.actions:
            total = sum(action.notional for action in intent.actions)
            plan = f" plan_actions={len(intent.actions)} plan_notional=${total:.2f}"

        logger.info(
            f"[INTENT] {timestamp} mode={intent.mode} action={intent.action_type} "
            f"symbol={intent.symbol} risk={intent.pre_risk_exposure_pct:.2f}"
            f"->{intent.post_risk_exposure_pct:.2f}{extras}{policy_meta}{gate}{macro}{risk_off}{signal}{plan}"
        )
