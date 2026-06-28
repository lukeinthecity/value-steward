"""Tests for the shared numeric coercion helper."""

from valuesteward.num_utils import safe_float


def test_valid_values_parse():
    assert safe_float("1.5") == 1.5
    assert safe_float(3) == 3.0
    assert safe_float(2.0) == 2.0


def test_default_none_on_bad_input():
    assert safe_float(None) is None
    assert safe_float("abc") is None
    assert safe_float([]) is None


def test_explicit_default_returned_on_bad_input():
    assert safe_float(None, 0.0) == 0.0
    assert safe_float("abc", -1.0) == -1.0


def test_nan_returns_default():
    # float("nan") parses fine but is NaN, so it must fall back to the default.
    assert safe_float(float("nan")) is None
    assert safe_float(float("nan"), 0.0) == 0.0
    assert safe_float("nan") is None
