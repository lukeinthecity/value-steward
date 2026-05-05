"""Tests for intraday candidate persistence priors."""

import json

from valuesteward.core.intraday_persistence import load_intraday_persistence_map


def test_intraday_persistence_defaults_to_neutral_without_observations(tmp_path) -> None:
    priors = load_intraday_persistence_map(
        ["SPY"],
        observations_path=tmp_path / "intraday-observations.jsonl",
    )

    assert priors["SPY"].quality_score == 0.5
    assert priors["SPY"].seen_count == 0
    assert priors["SPY"].day_count == 0


def test_intraday_persistence_rewards_repeated_recent_candidates(tmp_path) -> None:
    observations_path = tmp_path / "intraday-observations.jsonl"
    rows = [
        {
            "exchange_date": "2026-04-18",
            "top_candidates": [
                {"symbol": "AAA", "timestamp": "2026-04-18T19:30:00Z"},
                {"symbol": "BBB", "timestamp": "2026-04-18T19:40:00Z"},
            ],
        },
        {
            "exchange_date": "2026-04-19",
            "top_candidates": [{"symbol": "AAA", "timestamp": "2026-04-19T19:30:00Z"}],
        },
        {
            "exchange_date": "2026-04-20",
            "top_candidates": [
                {"symbol": "AAA", "timestamp": "2026-04-20T19:30:00Z"},
                {"symbol": "AAA", "timestamp": "2026-04-20T19:40:00Z"},
            ],
        },
    ]
    observations_path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )

    priors = load_intraday_persistence_map(
        ["AAA", "BBB"],
        observations_path=observations_path,
        lookback_days=5,
    )

    assert priors["AAA"].seen_count == 3
    assert priors["AAA"].day_count == 3
    assert priors["AAA"].quality_score > priors["BBB"].quality_score
