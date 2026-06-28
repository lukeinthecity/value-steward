"""Tests for the shared env-parsing helpers (single source of truth)."""

from valuesteward.env_utils import get_env_float, get_env_int


def test_get_env_int_valid(monkeypatch):
    monkeypatch.setenv("VS_TEST_INT", "42")
    assert get_env_int("VS_TEST_INT", 0) == 42


def test_get_env_int_unset_blank_invalid_return_default(monkeypatch):
    monkeypatch.delenv("VS_TEST_INT", raising=False)
    assert get_env_int("VS_TEST_INT", 7) == 7
    monkeypatch.setenv("VS_TEST_INT", "   ")
    assert get_env_int("VS_TEST_INT", 7) == 7
    monkeypatch.setenv("VS_TEST_INT", "not-an-int")
    assert get_env_int("VS_TEST_INT", 7) == 7


def test_get_env_float_valid(monkeypatch):
    monkeypatch.setenv("VS_TEST_FLOAT", "1.25")
    assert get_env_float("VS_TEST_FLOAT", 0.0) == 1.25


def test_get_env_float_unset_blank_invalid_return_default(monkeypatch):
    monkeypatch.delenv("VS_TEST_FLOAT", raising=False)
    assert get_env_float("VS_TEST_FLOAT", 0.5) == 0.5
    monkeypatch.setenv("VS_TEST_FLOAT", "")
    assert get_env_float("VS_TEST_FLOAT", 0.5) == 0.5
    monkeypatch.setenv("VS_TEST_FLOAT", "abc")
    assert get_env_float("VS_TEST_FLOAT", 0.5) == 0.5
