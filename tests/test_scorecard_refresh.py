"""Scorecard refresh behavior tests."""

from datetime import date, datetime, timedelta, timezone
import json
import math
from types import SimpleNamespace

import valuesteward.cli as cli
from valuesteward.models import IntentRecord, RiskMode


class DummyMemoryEngine:
    """Return a fixed set of intents."""

    def __init__(self, intents):
        self._intents = intents

    def get_recent_intents(self, limit: int = 200):
        return self._intents[:limit]


class DummyMarketDataClient:
    """Return deterministic daily bars for the requested symbols."""

    def __init__(self, _settings) -> None:
        self._base_date = date(2026, 3, 31)

    def get_daily_bars(self, symbols, lookback_days):
        del lookback_days
        bars = {}
        for symbol in symbols:
            if symbol == "KCHV":
                closes = [100.0, 103.0]
            else:
                closes = [200.0, 202.0]
            bars[symbol] = [
                SimpleNamespace(
                    timestamp=datetime.combine(
                        self._base_date + timedelta(days=index),
                        datetime.min.time(),
                        tzinfo=timezone.utc,
                    ),
                    close=close,
                )
                for index, close in enumerate(closes)
            ]
        return bars


def test_scorecard_refresh_updates_existing_horizons(tmp_path, monkeypatch) -> None:
    intent_timestamp = datetime(2026, 3, 31, 19, 50, tzinfo=timezone.utc)
    intent = IntentRecord(
        id="intent-1",
        timestamp=intent_timestamp,
        mode=RiskMode.LOW,
        action_type="BUY",
        symbol="KCHV",
        signal_symbol="KCHV",
        explanation="buy test",
    )
    out_path = tmp_path / "signal-scorecard.jsonl"
    out_path.write_text(
        json.dumps(
            {
                "intent_id": "intent-1",
                "timestamp": intent_timestamp.isoformat(),
                "action_type": "BUY",
                "reason_code": None,
                "symbol": "KCHV",
                "benchmark": "SPY",
                "entry_date": "2026-03-31",
                "entry_close": 100.0,
                "expected_price": None,
                "signal_score": None,
                "signal_score_raw": None,
                "signal_score_smoothed": None,
                "world_macro_label": None,
                "world_macro_score": None,
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

    monkeypatch.setattr(
        cli,
        "MemoryEngine",
        lambda: DummyMemoryEngine([intent]),
    )
    monkeypatch.setattr(cli, "MarketDataClient", DummyMarketDataClient)
    monkeypatch.setattr(cli, "load_steward_state", lambda: {})
    monkeypatch.setattr(cli, "get_phase1_start_date", lambda state: None)
    monkeypatch.setattr(
        cli,
        "is_on_or_after_phase1_start",
        lambda timestamp, state: True,
    )

    cli.scorecard.callback(out=str(out_path), limit=10, horizons="1", benchmark="SPY")

    rows = [
        json.loads(line)
        for line in out_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(rows) == 1
    assert rows[0]["intent_id"] == "intent-1"
    assert math.isclose(rows[0]["horizons"]["1"]["return"], 0.03, rel_tol=1e-9)
    assert math.isclose(
        rows[0]["horizons"]["1"]["benchmark_return"], 0.01, rel_tol=1e-9
    )
