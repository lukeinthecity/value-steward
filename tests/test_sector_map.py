"""Tests for sector metadata classification."""

import json
from types import SimpleNamespace

from valuesteward.core.sector_map import SectorMap


def test_sector_map_classifies_sp500_buffer_etf_as_index(tmp_path) -> None:
    sector_map = SectorMap(
        path=str(tmp_path / "sector-map.json"),
        cache_path=str(tmp_path / "sector-cache.json"),
    )
    asset = SimpleNamespace(
        symbol="UAPR",
        name="Innovator U.S. Equity Ultra Buffer ETF - April",
        asset_class="us_equity",
        exchange="ARCA",
    )

    assert sector_map._classify_from_asset(asset) == "INDEX"


def test_sector_map_classifies_blank_check_company_as_financials(tmp_path) -> None:
    sector_map = SectorMap(
        path=str(tmp_path / "sector-map.json"),
        cache_path=str(tmp_path / "sector-cache.json"),
    )
    asset = SimpleNamespace(
        symbol="DAAQ",
        name="Digital Asset Acquisition Corp",
        asset_class="us_equity",
        exchange="NASDAQ",
    )

    assert sector_map._classify_from_asset(asset) == "FINANCIALS"


def test_sector_map_falls_back_to_etf_other_for_unclassified_etf(tmp_path) -> None:
    sector_map = SectorMap(
        path=str(tmp_path / "sector-map.json"),
        cache_path=str(tmp_path / "sector-cache.json"),
    )
    asset = SimpleNamespace(
        symbol="MISC",
        name="Some Thematic ETF",
        asset_class="us_equity",
        exchange="ARCA",
    )

    assert sector_map._classify_from_asset(asset) == "ETF_OTHER"


def test_sector_map_classifies_bankshares_and_power_names(tmp_path) -> None:
    sector_map = SectorMap(
        path=str(tmp_path / "sector-map.json"),
        cache_path=str(tmp_path / "sector-cache.json"),
    )
    bank_asset = SimpleNamespace(
        symbol="CZWI",
        name="Citizens Community Bancorp Inc",
        asset_class="us_equity",
        exchange="NASDAQ",
    )
    utility_asset = SimpleNamespace(
        symbol="PPL",
        name="PPL Electric Utilities Corporation",
        asset_class="us_equity",
        exchange="NYSE",
    )

    assert sector_map._classify_from_asset(bank_asset) == "FINANCIALS"
    assert sector_map._classify_from_asset(utility_asset) == "UTILITIES"


def test_sector_map_base_mapping_wins_over_unknown_cache(tmp_path) -> None:
    base_path = tmp_path / "sector-map.json"
    cache_path = tmp_path / "sector-cache.json"
    base_path.write_text(json.dumps({"PPL": "UTILITIES"}), encoding="utf-8")
    cache_path.write_text(
        json.dumps({"sectors": {"PPL": "UNKNOWN"}}),
        encoding="utf-8",
    )

    sector_map = SectorMap(path=str(base_path), cache_path=str(cache_path))

    assert sector_map.get("PPL") == "UTILITIES"
