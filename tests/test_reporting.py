"""Tests for intent reporting summaries."""

from valuesteward.core.reporting import build_report
from valuesteward.models import IntentRecord, RiskMode


def test_report_counts_and_percentages() -> None:
    intents = [
        IntentRecord(
            mode=RiskMode.LOW,
            action_type="NO_ACTION",
            explanation="noop",
        ),
        IntentRecord(
            mode=RiskMode.LOW,
            action_type="BUY",
            symbol="SPY",
            size_pct=0.05,
            explanation="buy",
        ),
        IntentRecord(
            mode=RiskMode.LOW,
            action_type="SELL",
            symbol="SPY",
            size_pct=0.05,
            explanation="sell",
        ),
    ]

    report = build_report(intents)
    assert report["total"] == 3
    assert report["no_action_count"] == 1
    assert report["buy_count"] == 1
    assert report["sell_count"] == 1
