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
