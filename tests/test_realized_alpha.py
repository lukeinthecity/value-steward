"""Tests for realized-alpha priors derived from scorecard history."""

import json

from valuesteward.core.realized_alpha import load_realized_alpha_prior_map


def test_realized_alpha_prior_defaults_to_neutral_without_scorecard(tmp_path) -> None:
    priors = load_realized_alpha_prior_map(
        ["SPY"],
        scorecard_path=tmp_path / "signal-scorecard.jsonl",
    )

    assert priors["SPY"].quality_score == 0.5
    assert priors["SPY"].avg_excess_benchmark == 0.0
    assert priors["SPY"].sample_count == 0


def test_realized_alpha_prior_rewards_positive_benchmark_excess(tmp_path) -> None:
    scorecard_path = tmp_path / "signal-scorecard.jsonl"
    scorecard_path.write_text(
        "\n".join(
            json.dumps(
                {
                    "action_type": "BUY",
                    "symbol": "AAA",
                    "horizons": {
                        "1": {"excess_vs_benchmark": 0.02},
                        "5": {"excess_vs_benchmark": 0.03},
                    },
                }
            )
            for _ in range(2)
        )
        + "\n",
        encoding="utf-8",
    )

    priors = load_realized_alpha_prior_map(
        ["AAA"],
        scorecard_path=scorecard_path,
    )

    assert priors["AAA"].sample_count == 4
    assert priors["AAA"].avg_excess_benchmark > 0
    assert priors["AAA"].quality_score > 0.5


def test_realized_alpha_prior_penalizes_negative_benchmark_excess(tmp_path) -> None:
    scorecard_path = tmp_path / "signal-scorecard.jsonl"
    scorecard_path.write_text(
        json.dumps(
            {
                "action_type": "BUY",
                "symbol": "BBB",
                "horizons": {
                    "1": {"excess_vs_benchmark": -0.03},
                    "5": {"excess_vs_benchmark": -0.04},
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    priors = load_realized_alpha_prior_map(
        ["BBB"],
        scorecard_path=scorecard_path,
    )

    assert priors["BBB"].sample_count == 2
    assert priors["BBB"].avg_excess_benchmark < 0
    assert priors["BBB"].quality_score < 0.5
