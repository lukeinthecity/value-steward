"""Notification utilities for Value Steward."""

import shutil
from pathlib import Path

from valuesteward.models import IntentRecord

_REPO_ROOT = Path(__file__).resolve().parents[3]


class NotificationService:
    """Send informational, action, and alert notifications.

    TODO: email integration
    TODO: SMS / push integration
    """

    def notify_info(self, message: str) -> None:
        """Send an informational notification."""

        print(f"[INFO] {message}")

    def notify_action(self, intent: IntentRecord) -> None:
        """Notify about an actionable intent."""

        symbol = intent.symbol or "-"
        size_pct = (
            f"{intent.size_pct:.2%}" if intent.size_pct is not None else "n/a"
        )
        mode = intent.mode.value
        print(
            f"[ACTION] Proposed {intent.action_type} {symbol} "
            f"size_pct={size_pct} in {mode} mode."
        )

    def notify_alert(self, message: str) -> None:
        """Send an alert notification."""

        print(f"[ALERT] {message}")

    def notify_steward_insights(self, intents: list[IntentRecord]) -> None:
        """Trigger the Node.js EOD email notification."""
        import subprocess  # nosec
        node_bin = shutil.which("node") or "node"
        script_path = _REPO_ROOT / "scripts" / "testEmail.js"
        try:
            # testEmail.js is the existing bridge for manual/EOD emails. Resolve
            # node and the script absolutely so cron (minimal PATH, arbitrary
            # cwd) can't silently break the trigger.
            subprocess.run(  # nosec
                [node_bin, str(script_path)],
                capture_output=True,
                text=True,
                cwd=str(_REPO_ROOT),
            )
            print("[INFO] Steward Insights email trigger dispatched.")
        except Exception as e:
            print(f"[ERROR] Failed to trigger email notification: {e}")
