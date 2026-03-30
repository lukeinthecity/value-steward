"""Regression coverage for scorecard refresh updates."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from valuesteward.cli import main
from valuesteward.models import IntentRecord, RiskMode


class FakeMemoryEngine:
    def __init__(self) -> None:
        self._intents = [
            IntentRecord(
                id="intent-1",
                timestamp=datetime(2026, 3, 16, 19, 55, tzinfo=timezone.utc),
                mode=RiskMode.LOW,
                action_type="BUY",
                symbol="SPY",
                explanation="test buy",
            )
        ]

    def get_recent_intents(self, limit: int = 50):
        return self._intents[:limit]


class FakeMarketDataClient:
    def __init__(self, settings) -> None:
        self.settings = settings

    def get_daily_bars(self, symbols, lookback_days):
        closes = {
            "SPY": [100.0, 102.0, 104.0],
        }
        bars_by_symbol = {}
        for symbol in symbols:
            prices = closes.get(symbol, closes["SPY"])
            bars_by_symbol[symbol] = [
                SimpleNamespace(
                    timestamp=datetime(2026, 3, 16 + offset, 20, 0, tzinfo=timezone.utc),
                    close=price,
                )
                for offset, price in enumerate(prices)
            ]
        return bars_by_symbol


def test_scorecard_refresh_updates_existing_horizons(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    state_path = tmp_path / "steward-state.json"
    state_lock_path = tmp_path / "steward-state.json.lock"
    scorecard_path = tmp_path / "signal-scorecard.jsonl"

    state_path.write_text(
        json.dumps({"phase1_start_date": "2026-03-16"}),
        encoding="utf-8",
    )
    scorecard_path.write_text(
        json.dumps(
            {
                "intent_id": "intent-1",
                "timestamp": "2026-03-16T19:55:00+00:00",
                "action_type": "BUY",
                "symbol": "SPY",
                "benchmark": "SPY",
                "entry_date": "2026-03-16",
                "entry_close": 100.0,
                "horizons": {
                    "1": {
                        "return": None,
                        "benchmark_return": None,
                        "cash_return": 0.0,
                        "excess_vs_benchmark": None,
                        "excess_vs_cash": None,
                        "signed_return": None,
                        "directional_correct": None,
                    }
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr("valuesteward.steward_state.STATE_PATH", state_path)
    monkeypatch.setattr("valuesteward.steward_state.STATE_LOCK_PATH", state_lock_path)
    monkeypatch.setattr("valuesteward.cli.MemoryEngine", FakeMemoryEngine)
    monkeypatch.setattr("valuesteward.cli.MarketDataClient", FakeMarketDataClient)
    monkeypatch.setattr("valuesteward.cli.get_settings", lambda: SimpleNamespace())

    result = CliRunner().invoke(
        main,
        [
            "scorecard",
            "--out",
            str(scorecard_path),
            "--limit",
            "10",
            "--horizons",
            "1",
            "--benchmark",
            "SPY",
        ],
    )

    assert result.exit_code == 0
    assert "updated: 1" in result.output

    record = json.loads(scorecard_path.read_text(encoding="utf-8").strip())
    assert record["entry_close"] == 100.0
    assert record["horizons"]["1"]["return"] == pytest.approx(0.02)
    assert record["horizons"]["1"]["benchmark_return"] == pytest.approx(0.02)
    assert record["horizons"]["1"]["excess_vs_benchmark"] == pytest.approx(0.0)
    assert record["horizons"]["1"]["signed_return"] == pytest.approx(0.02)
    assert record["horizons"]["1"]["directional_correct"] is True
