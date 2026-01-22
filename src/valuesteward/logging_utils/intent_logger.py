"""Intent logging for auditability."""

from __future__ import annotations

from valuesteward.core.memory import MemoryEngine
from valuesteward.models import IntentRecord


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

        print(
            f"[INTENT] {timestamp} mode={intent.mode} action={intent.action_type} "
            f"symbol={intent.symbol} risk={intent.pre_risk_exposure_pct:.2f}"
            f"->{intent.post_risk_exposure_pct:.2f}{extras}"
        )
