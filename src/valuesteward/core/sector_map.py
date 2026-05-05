"""Sector mapping utilities for diversification."""

from __future__ import annotations

import json
import os
import subprocess  # nosec B404
import shlex
from pathlib import Path
from typing import Any, Dict, Iterable


_KEYWORD_SECTORS: tuple[tuple[tuple[str, ...], str], ...] = (
    (
        (
            "treasury",
            "t-bill",
            "t bill",
            "bond",
            "fixed income",
            "ultra short",
            "ultrashort",
            "income",
            "yield",
        ),
        "BONDS",
    ),
    (("gold",), "GOLD"),
    (("silver",), "SILVER"),
    (("utility", "utilities", "electric", "power"), "UTILITIES"),
    (("health", "healthcare", "medical", "biotech", "pharma", "pharmaceutical"), "HEALTHCARE"),
    (("consumer staples", "staples", "food", "beverage"), "CONSUMER_STAPLES"),
    (("energy", "oil", "gas", "petroleum", "pipeline"), "ENERGY"),
    (
        (
            "financial",
            "bank",
            "bankshares",
            "bancorp",
            "insurance",
            "capital",
            "acquisition corp",
            "shell company",
        ),
        "FINANCIALS",
    ),
    (("industrial", "aerospace", "defense"), "INDUSTRIALS"),
    (("real estate", "reit"), "REAL_ESTATE"),
    (("material", "materials", "mining", "steel", "copper"), "MATERIALS"),
    (("technology", "software", "cloud", "semiconductor", "ai "), "TECH"),
    (("communication", "telecom", "media"), "COMMUNICATIONS"),
    (("consumer discretionary", "retail", "e-commerce", "travel"), "CONSUMER_DISCRETIONARY"),
    (
        (
            "s&p 500",
            "nasdaq",
            "russell",
            "dow",
            "equity",
            "buffer",
            "defined outcome",
            "index",
        ),
        "INDEX",
    ),
)


class SectorMap:
    """Load and auto-expand a symbol -> sector map."""

    def __init__(self, path: str | None = None, cache_path: str | None = None) -> None:
        path_value = path or os.getenv("VS_SECTOR_MAP_PATH") or "config/sector-map.json"
        cache_value = (
            cache_path or os.getenv("VS_SECTOR_CACHE_PATH") or "data/sector-cache.json"
        )
        self.path = Path(path_value)
        self.cache_path = Path(cache_value)
        self._base = self._load(self.path)
        self._cache = self._load(self.cache_path)
        self._merged = self._compose_merged()

    def _load(self, path: Path) -> Dict[str, str]:
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if isinstance(payload, dict) and "sectors" in payload and isinstance(
            payload["sectors"], dict
        ):
            return {str(k).upper(): str(v) for k, v in payload["sectors"].items()}
        if isinstance(payload, dict):
            return {str(k).upper(): str(v) for k, v in payload.items()}
        return {}

    def _save_cache(self) -> None:
        if not self.cache_path.parent.exists():
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"sectors": dict(sorted(self._cache.items()))}
        self.cache_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _compose_merged(self) -> Dict[str, str]:
        merged = dict(self._base)
        for symbol, sector in self._cache.items():
            if sector == "UNKNOWN" and symbol in merged:
                continue
            merged[symbol] = sector
        return merged

    def _load_lookup_file(self) -> Dict[str, str]:
        lookup_path = os.getenv("VS_SECTOR_LOOKUP_FILE")
        if not lookup_path:
            return {}
        path = Path(lookup_path)
        return self._load(path)

    def _load_lookup_cmd(self, symbols: Iterable[str]) -> Dict[str, str]:
        cmd = os.getenv("VS_SECTOR_LOOKUP_CMD")
        if not cmd:
            return {}
        try:
            payload = json.dumps({"symbols": list(symbols)})
            cmd_parts = shlex.split(cmd)
            if not cmd_parts:
                return {}
            # Command is explicitly configured via env by the operator.
            result = subprocess.run(  # nosec B603
                cmd_parts,
                input=payload,
                text=True,
                check=True,
                capture_output=True,
            )
            data = json.loads(result.stdout.strip() or "{}")
            if isinstance(data, dict) and "sectors" in data and isinstance(
                data["sectors"], dict
            ):
                return {str(k).upper(): str(v) for k, v in data["sectors"].items()}
            if isinstance(data, dict):
                return {str(k).upper(): str(v) for k, v in data.items()}
        except Exception:
            return {}
        return {}

    def _classify_from_asset(self, asset: Any) -> str | None:
        symbol = str(getattr(asset, "symbol", "") or "").upper()
        name = str(getattr(asset, "name", "") or "").strip().lower()
        asset_class = str(getattr(asset, "asset_class", "") or "").strip().lower()
        exchange = str(getattr(asset, "exchange", "") or "").strip().lower()

        if symbol in {"SPY", "QQQ", "DIA", "IWM"}:
            return "INDEX"
        if not name:
            return None
        if asset_class == "crypto":
            return "CRYPTO"
        if "treasury" in name or "bond" in name:
            return "BONDS"
        if "gold" in name:
            return "GOLD"
        if "silver" in name:
            return "SILVER"
        if "bankshares" in name or "bancorp" in name:
            return "FINANCIALS"
        if "electric" in name or "power" in name:
            return "UTILITIES"
        if "acquisition corp" in name or "blank check" in name:
            return "FINANCIALS"
        if "etf" in name and any(
            marker in name
            for marker in (
                "s&p 500",
                "nasdaq",
                "russell",
                "dow",
                "equity",
                "buffer",
                "defined outcome",
                "ultra buffer",
            )
        ):
            return "INDEX"
        for keywords, sector in _KEYWORD_SECTORS:
            if any(keyword in name for keyword in keywords):
                return sector
        if (
            exchange in {"arca", "bats", "nysearca", "cboe"}
            and any(marker in name for marker in ("etf", "fund", "trust"))
        ):
            return "ETF_OTHER"
        if any(marker in name for marker in ("etf", "fund", "trust")):
            return "ETF_OTHER"
        return None

    def _load_lookup_alpaca(self, symbols: Iterable[str]) -> Dict[str, str]:
        if os.getenv("VS_SECTOR_ALPACA_LOOKUP", "true").strip().lower() not in {
            "1",
            "true",
            "yes",
            "y",
        }:
            return {}
        try:
            from valuesteward.config import get_settings
            from valuesteward.data.alpaca_client import AlpacaClient

            client = AlpacaClient(settings=get_settings())
            requested = {str(symbol).upper() for symbol in symbols if symbol}
            updates: Dict[str, str] = {}
            for asset in client.get_all_assets():
                symbol = str(getattr(asset, "symbol", "") or "").upper()
                if symbol not in requested:
                    continue
                sector = self._classify_from_asset(asset)
                if sector:
                    updates[symbol] = sector
            return updates
        except Exception:
            return {}

    def resolve(self, symbols: Iterable[str]) -> None:
        auto_expand = os.getenv("VS_SECTOR_AUTO_EXPAND", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
        }
        if not auto_expand:
            return
        unknowns = [sym for sym in symbols if self.get(sym) == "UNKNOWN"]
        if not unknowns:
            return

        updates: Dict[str, str] = {}
        updates.update(self._load_lookup_file())
        if unknowns:
            updates.update(self._load_lookup_cmd(unknowns))
        if unknowns:
            unresolved = [sym for sym in unknowns if sym.upper() not in updates]
            updates.update(self._load_lookup_alpaca(unresolved))

        changed = False
        for symbol in unknowns:
            sector = updates.get(symbol.upper())
            if sector:
                if self._cache.get(symbol.upper()) != sector:
                    self._cache[symbol.upper()] = sector
                    changed = True
            else:
                if self._cache.get(symbol.upper()) != "UNKNOWN":
                    self._cache[symbol.upper()] = "UNKNOWN"
                    changed = True

        if changed:
            self._save_cache()
            self._merged = self._compose_merged()

    def get(self, symbol: str) -> str:
        if not symbol:
            return "UNKNOWN"
        return self._merged.get(symbol.upper(), "UNKNOWN")
