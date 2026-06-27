"""Tests for the crash-safe early-close time parser.

`_is_market_open_now` previously parsed the holiday file's early-close time with
`ec.get("close_time", "13:00").split(":")` + `int(...)`, which raises on any
malformed value (no colon, non-numeric, extra fields) and would crash the
market-open check mid-tick. It now routes through `_parse_hhmm`, which falls
back to a default on bad input. These cover that hardening.
"""

from valuesteward.core.execution_engine import _parse_hhmm


def test_valid_times_parse():
    assert _parse_hhmm("13:00", 16, 0) == (13, 0)
    assert _parse_hhmm("9:30", 16, 0) == (9, 30)
    assert _parse_hhmm(" 13:00 ", 16, 0) == (13, 0)  # surrounding whitespace


def test_none_and_empty_return_default():
    assert _parse_hhmm(None, 16, 0) == (16, 0)
    assert _parse_hhmm("", 16, 0) == (16, 0)


def test_malformed_returns_default_instead_of_crashing():
    # Each of these would raise under the old split(":")/int() parse.
    assert _parse_hhmm("13", 13, 0) == (13, 0)  # no colon
    assert _parse_hhmm("aa:bb", 13, 0) == (13, 0)  # non-numeric
    assert _parse_hhmm("25:00", 13, 0) == (13, 0)  # hour out of range
    assert _parse_hhmm("13:99", 13, 0) == (13, 0)  # minute out of range
    assert _parse_hhmm("13:00:00", 13, 0) == (13, 0)  # extra field
