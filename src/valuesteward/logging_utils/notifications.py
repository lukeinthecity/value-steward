"""Notification utilities for Value Steward."""

from valuesteward.models import IntentRecord


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
        import subprocess # nosec
        try:
            # The testEmail.js script is our existing bridge for manual/EOD emails
            subprocess.run(["node", "scripts/testEmail.js"], capture_output=True, text=True) # nosec
            print("[INFO] Steward Insights email trigger dispatched.")
        except Exception as e:
            print(f"[ERROR] Failed to trigger email notification: {e}")
