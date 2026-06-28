"""Tests for the shared market-timezone resolver."""

from zoneinfo import ZoneInfo

from valuesteward.market_holidays import get_market_timezone


def test_defaults_to_new_york(monkeypatch):
    monkeypatch.delenv("VS_EXECUTION_TIMEZONE", raising=False)
    monkeypatch.delenv("VS_MARKET_TIMEZONE", raising=False)
    assert get_market_timezone() == ZoneInfo("America/New_York")


def test_market_timezone_env_honored(monkeypatch):
    monkeypatch.delenv("VS_EXECUTION_TIMEZONE", raising=False)
    monkeypatch.setenv("VS_MARKET_TIMEZONE", "Europe/London")
    assert get_market_timezone() == ZoneInfo("Europe/London")


def test_execution_timezone_takes_precedence(monkeypatch):
    monkeypatch.setenv("VS_EXECUTION_TIMEZONE", "Asia/Tokyo")
    monkeypatch.setenv("VS_MARKET_TIMEZONE", "Europe/London")
    assert get_market_timezone() == ZoneInfo("Asia/Tokyo")


def test_invalid_timezone_falls_back_to_new_york(monkeypatch):
    monkeypatch.delenv("VS_EXECUTION_TIMEZONE", raising=False)
    monkeypatch.setenv("VS_MARKET_TIMEZONE", "Not/ARealZone")
    assert get_market_timezone() == ZoneInfo("America/New_York")
