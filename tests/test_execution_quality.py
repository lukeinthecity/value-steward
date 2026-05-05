"""Tests for execution-quality scoring."""

import json

from valuesteward.core.execution_quality import load_execution_quality_map


def test_execution_quality_defaults_to_neutral_without_local_evidence(tmp_path) -> None:
    stats = load_execution_quality_map(
        ["SPY"],
        portfolio_path=str(tmp_path / "portfolio-live.json"),
        intent_log_path=str(tmp_path / "intent_log.jsonl"),
    )

    assert stats["SPY"].quality_score == 0.5
    assert stats["SPY"].submission_rate == 0.5
    assert stats["SPY"].fill_rate == 0.5
    assert stats["SPY"].expire_rate == 0.0


def test_execution_quality_penalizes_repeated_failed_attempts(tmp_path) -> None:
    portfolio_path = tmp_path / "portfolio-live.json"
    intent_log_path = tmp_path / "intent_log.jsonl"
    portfolio_path.write_text(
        json.dumps(
            {
                "recent_orders": [
                    {
                        "symbol": "TDTT",
                        "status": "expired",
                        "submitted_at": "2026-04-01T19:50:00Z",
                        "filled_at": None,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    intent_log_path.write_text(
        "\n".join(
            json.dumps(
                {
                    "timestamp": ts,
                    "action_type": "BUY",
                    "symbol": "TDTT",
                }
            )
            for ts in (
                "2026-04-01T19:30:00Z",
                "2026-04-01T19:40:00Z",
                "2026-04-01T19:50:00Z",
            )
        )
        + "\n",
        encoding="utf-8",
    )

    stats = load_execution_quality_map(
        ["TDTT"],
        portfolio_path=str(portfolio_path),
        intent_log_path=str(intent_log_path),
        lookback_days=365,
    )

    assert stats["TDTT"].submitted_orders == 1
    assert stats["TDTT"].buy_intents == 3
    assert stats["TDTT"].expire_rate == 1.0
    assert stats["TDTT"].repeat_attempt_penalty > 0
    assert stats["TDTT"].quality_score < 0.5
