"""Command line interface for Value Steward."""

from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
from typing import Any, cast
from uuid import UUID
from zoneinfo import ZoneInfo

import click
import statistics

from valuesteward.config import get_settings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.memory import MemoryEngine
from valuesteward.core.patterns import EpisodeExtractor, PatternLibrary, load_history_entries
from valuesteward.core.reporting import build_report
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.sector_map import SectorMap
from valuesteward.core.signal_engine import SignalEngine
from valuesteward.core.world_recognition import infer_world_tags
from valuesteward.models import IntentRecord
from valuesteward.world_context import (
    load_latest_world_context,
    world_context_age_minutes,
)
from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.data.market_data import MarketDataClient
from valuesteward.data.portfolio_repository import PortfolioRepository
from valuesteward.logging_utils.intent_logger import IntentLogger
from valuesteward.logging_utils.notifications import NotificationService
from valuesteward.policy import apply_policy_to_settings, load_policy
from valuesteward.runtime_integrity import verify_runtime_expectations
from valuesteward.steward_state import (
    get_phase1_start_date,
    is_on_or_after_phase1_start,
    load_steward_state,
)


@click.group()
def main() -> None:
    """Value Steward CLI."""


@main.command()
def status() -> None:
    """Print current portfolio and system status."""

    state = load_steward_state()
    
    repo = PortfolioRepository()
    snapshot = repo.get_current_snapshot()
    
    print(f"Equity: ${snapshot.equity:,.2f}")
    print(f"Cash:   ${snapshot.cash:,.2f}")
    print(f"Risk Exposure: {snapshot.risk_exposure_pct:.2%}")
    print("-" * 20)
    print(f"System Mode: {state.get('current_mode', 'UNKNOWN')}")
    print(f"Trading Enabled: {state.get('trading_enabled', True)}")
    print(f"Force No Trade:  {state.get('force_no_trade', False)}")
    print(f"Executions Today: {state.get('executions_today', 0)}")
    
    baseline = state.get("daily_starting_equity")
    if baseline:
        loss = (snapshot.equity / baseline) - 1.0
        print(f"Daily Baseline:  ${baseline:,.2f} (Loss: {loss:.2%})")


def _iso(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _json_scalar(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, UUID):
        return str(value)
    raw_value = getattr(value, "value", None)
    if isinstance(raw_value, (str, int, float, bool)):
        return raw_value
    return str(value)


def _write_json_atomic(output_path: Path, payload: dict) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(
        f"{output_path.name}.{os.getpid()}.{int(datetime.now(timezone.utc).timestamp() * 1000)}.tmp"
    )
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_path.replace(output_path)


def _write_jsonl_atomic(output_path: Path, records: list[dict]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(
        f"{output_path.name}.{os.getpid()}.{int(datetime.now(timezone.utc).timestamp() * 1000)}.tmp"
    )
    with tmp_path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
    tmp_path.replace(output_path)


def _market_timezone() -> ZoneInfo:
    tz = os.getenv("VS_MARKET_TIMEZONE") or "America/New_York"
    try:
        return ZoneInfo(tz)
    except Exception:
        return ZoneInfo("America/New_York")


def _exchange_date_iso_now() -> str:
    return datetime.now(timezone.utc).astimezone(_market_timezone()).date().isoformat()


def _format_account(account) -> dict:
    return {
        "status": getattr(account, "status", None),
        "equity": float(getattr(account, "equity", 0) or 0),
        "cash": float(getattr(account, "cash", 0) or 0),
        "buying_power": float(getattr(account, "buying_power", 0) or 0),
        "portfolio_value": float(getattr(account, "portfolio_value", 0) or 0),
        # NOTE: pattern_day_trader was removed here — Alpaca deprecated the
        # PDT fields (removal 2026-07-06) when they replaced the PDT rule with
        # the intraday margin framework. We never used it for logic; everything
        # that matters reads buying_power above.
        "multiplier": float(getattr(account, "multiplier", 0) or 0),
        "last_equity": float(getattr(account, "last_equity", 0) or 0),
        "last_maintenance_margin": float(
            getattr(account, "last_maintenance_margin", 0) or 0
        ),
    }


def _format_order(order) -> dict:
    return {
        "id": _json_scalar(getattr(order, "id", None)),
        "symbol": _json_scalar(getattr(order, "symbol", None)),
        "side": _json_scalar(getattr(order, "side", None)),
        "status": _json_scalar(getattr(order, "status", None)),
        "qty": _json_scalar(getattr(order, "qty", None)),
        "notional": _json_scalar(getattr(order, "notional", None)),
        "type": _json_scalar(getattr(order, "type", None)),
        "time_in_force": _json_scalar(getattr(order, "time_in_force", None)),
        "submitted_at": _iso(getattr(order, "submitted_at", None)),
        "filled_at": _iso(getattr(order, "filled_at", None)),
        "filled_avg_price": _json_scalar(getattr(order, "filled_avg_price", None)),
    }


def _format_clock(clock) -> dict:
    return {
        "timestamp": _iso(getattr(clock, "timestamp", None)),
        "is_open": getattr(clock, "is_open", None),
        "next_open": _iso(getattr(clock, "next_open", None)),
        "next_close": _iso(getattr(clock, "next_close", None)),
    }


@main.command("portfolio")
@click.option(
    "--out",
    default="data/portfolio-live.json",
    show_default=True,
    help="Path to write live portfolio JSON.",
)
def portfolio(out: str) -> None:
    """Fetch live portfolio data and write it to disk."""

    settings = get_settings()
    alpaca_client = AlpacaClient(settings=settings)
    repo = PortfolioRepository(alpaca_client=alpaca_client)
    snapshot = repo.get_current_snapshot()

    account = alpaca_client.get_account()
    positions = alpaca_client.get_positions()
    try:
        orders = alpaca_client.get_open_orders()
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] Failed to fetch open orders: {exc}")
        orders = []
    try:
        recent_orders = alpaca_client.get_recent_orders(limit=20)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] Failed to fetch recent orders: {exc}")
        recent_orders = []
    try:
        clock = alpaca_client.get_clock()
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] Failed to fetch market clock: {exc}")
        clock = None

    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "cycle_id": os.getenv("VS_ARTIFACT_CYCLE_ID") or None,
        "account": _format_account(account),
        "snapshot": {
            "timestamp": snapshot.timestamp.isoformat(),
            "cash": snapshot.cash,
            "equity": snapshot.equity,
            "risk_exposure_pct": snapshot.risk_exposure_pct,
            "position_count": len(snapshot.positions),
        },
        "positions": [p.model_dump() for p in positions],
        "open_orders": [_format_order(order) for order in orders],
        "recent_orders": [_format_order(order) for order in recent_orders],
        "last_order": _format_order(recent_orders[0]) if recent_orders else None,
        "clock": _format_clock(clock) if clock else None,
    }

    output_path = Path(out)
    _write_json_atomic(output_path, payload)
    print(json.dumps(payload, indent=2))


@main.command("signal-snapshot")
@click.option(
    "--out",
    default="data/intraday-signal-snapshot.json",
    show_default=True,
    help="Path to write ranked signal snapshot JSON.",
)
@click.option(
    "--limit",
    default=5,
    show_default=True,
    type=int,
    help="Number of top-ranked candidates to write.",
)
def signal_snapshot(out: str, limit: int) -> None:
    """Build a fresh ranked signal snapshot for observation and analysis."""

    settings = get_settings()
    alpaca_client = AlpacaClient(settings=settings)
    signal_engine = SignalEngine(
        alpaca_client=alpaca_client,
        data_client=MarketDataClient(),
        settings=settings,
    )
    signal_result = signal_engine.build_signals()
    sector_map = SectorMap()
    top_signals = signal_result.signals[: max(0, limit)]
    sector_map.resolve([signal.symbol for signal in top_signals])

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "exchange_date": _exchange_date_iso_now(),
        "cycle_id": os.getenv("VS_ARTIFACT_CYCLE_ID") or None,
        "universe_size": signal_result.universe_size,
        "evaluated": signal_result.evaluated,
        "skipped": signal_result.skipped,
        "limit": max(0, limit),
        "candidates": [
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "symbol": signal.symbol,
                "signal_score": signal.score,
                "signal_sector": sector_map.get(signal.symbol),
                "trend_strength": signal.trend_strength,
                "rel_strength_20d": signal.rel_strength_20d,
                "rel_strength_60d": signal.rel_strength_60d,
                "execution_quality_score": signal.execution_quality_score,
                "realized_alpha_prior": signal.realized_alpha_prior,
                "intraday_persistence_score": signal.intraday_persistence_score,
            }
            for signal in top_signals
        ],
    }

    output_path = Path(out)
    _write_json_atomic(output_path, payload)
    print(json.dumps(payload, indent=2))


@main.command("manual-order")
@click.option("--symbol", required=True, help="Symbol to trade (must be held).")
@click.option(
    "--side",
    required=True,
    type=click.Choice(["buy", "sell"], case_sensitive=False),
    help="Order side.",
)
@click.option("--notional", required=True, type=float, help="Notional dollars.")
def manual_order(symbol: str, side: str, notional: float) -> None:
    """Submit a manual override order for an existing position."""

    settings = get_settings()
    policy, policy_warnings = load_policy()
    for warning in policy_warnings:
        print(f"[POLICY] Warning: {warning}")
    settings = apply_policy_to_settings(settings, policy)

    alpaca_client = AlpacaClient(settings=settings)
    portfolio_repo = PortfolioRepository(alpaca_client=alpaca_client)
    snapshot = portfolio_repo.get_current_snapshot()

    held_symbols = {pos.symbol for pos in snapshot.positions}
    symbol = symbol.upper()
    if symbol not in held_symbols:
        raise click.ClickException(
            f"Symbol {symbol} not in portfolio. Manual orders are limited to held symbols."
        )

    trade_gate = policy.get("trade_gate_overrides") or {}
    if trade_gate.get("force_no_trade"):
        reason = trade_gate.get("reason") or "policy_override"
        raise click.ClickException(f"Policy trade gate forced no-trade: {reason}")

    if notional <= 0:
        raise click.ClickException("Notional must be greater than zero.")

    max_notional = settings.max_trade_notional_dollars
    min_notional = settings.min_trade_notional_dollars
    if notional < min_notional:
        raise click.ClickException(
            f"Notional ${notional:.2f} below minimum ${min_notional:.2f}."
        )
    if notional > max_notional:
        raise click.ClickException(
            f"Notional ${notional:.2f} above max ${max_notional:.2f}."
        )

    risk_governor = RiskGovernor(settings=settings)
    execution_engine = ExecutionEngine(
        alpaca_client=alpaca_client,
        risk_governor=risk_governor,
        settings=settings,
        policy=policy,
    )

    from valuesteward.models import TradeAction
    manual_intent = IntentRecord(
        mode=risk_governor.mode,
        action_type="MULTI",
        explanation=f"Manual override: {side.upper()} {symbol} ${notional:.2f}",
        actions=[TradeAction(symbol=symbol, side=side.upper(), notional=notional)]
    )

    execution_engine.execute_intent(manual_intent, snapshot)


@main.command()
def tick() -> None:
    """Run one full decision cycle of the Value Steward."""

    integrity = verify_runtime_expectations()
    print(
        "[RUNTIME] "
        f"git_head={integrity.get('git_head') or 'n/a'} "
        f"dirty={integrity.get('git_dirty') if integrity.get('git_dirty') is not None else 'n/a'}"
    )

    settings = get_settings()
    policy, policy_warnings = load_policy()
    for warning in policy_warnings:
        print(f"[POLICY] Warning: {warning}")

    # Load world context early so regime-conditional signal weights can be
    # picked up by apply_policy_to_settings before the signal engine builds.
    _early_world_context = load_latest_world_context()
    _early_macro_label = None
    if isinstance(_early_world_context, dict):
        macro_view = _early_world_context.get("macro_view") or {}
        if isinstance(macro_view, dict):
            label = macro_view.get("macro_label")
            if isinstance(label, str):
                _early_macro_label = label

    settings = apply_policy_to_settings(
        settings, policy, world_macro_label=_early_macro_label
    )
    print(
        f"Mode={settings.mode} | shadow_mode={settings.shadow_mode} "
        f"| execution_armed={settings.execution_armed}"
    )
    policy_version = policy.get("version", "?")
    schema_version = policy.get("schema_version", "?")
    risk_level = policy.get("risk_level")
    trade_gate = policy.get("trade_gate_overrides") or {}
    force_no_trade = trade_gate.get("force_no_trade")
    target = settings.target_risk_exposure_pct_low
    buffer = settings.rebalance_buffer_pct
    print(
        "[POLICY] "
        f"schema={schema_version} v{policy_version} "
        f"risk_level={risk_level if risk_level is not None else 'n/a'} "
        f"mode={settings.mode} "
        f"target={target:.2%} buffer={buffer:.2%} "
        f"force_no_trade={force_no_trade if force_no_trade is not None else 'n/a'}"
    )
    alpaca_client = AlpacaClient(settings=settings)
    portfolio_repo = PortfolioRepository(alpaca_client=alpaca_client)
    signal_engine = SignalEngine(alpaca_client=alpaca_client)
    memory_engine = MemoryEngine()
    pattern_library = PatternLibrary()
    risk_governor = RiskGovernor(settings=settings)
    decision_engine = DecisionEngine(
        risk_governor=risk_governor,
        pattern_library=pattern_library,
        settings=settings,
        portfolio_repository=portfolio_repo,
        signal_engine=signal_engine,
        policy=policy,
    )
    execution_engine = ExecutionEngine(
        alpaca_client=alpaca_client,
        risk_governor=risk_governor,
        settings=settings,
        policy=policy,
    )
    intent_logger = IntentLogger(memory=memory_engine)
    notifications = NotificationService()

    snapshot = portfolio_repo.get_current_snapshot()
    # Reuse the world context loaded earlier (for regime-conditional weights)
    # to avoid a second file read.
    world_context = _early_world_context
    world_tags = infer_world_tags(snapshot, world_context)
    intent, signal_result = decision_engine.decide(
        snapshot, world_tags, world_context=world_context
    )
    world_age = world_context_age_minutes(world_context)
    intent = intent.model_copy(
        update={
            "policy_schema_version": policy.get("schema_version"),
            "policy_version": policy.get("version"),
            "policy_risk_level": policy.get("risk_level"),
            "policy_mode": settings.mode,
            "policy_target_risk_exposure_pct_low": settings.target_risk_exposure_pct_low,
            "policy_rebalance_buffer_pct": settings.rebalance_buffer_pct,
            "policy_force_no_trade": (
                policy.get("trade_gate_overrides") or {}
            ).get("force_no_trade"),
            "world_macro_label": (
                world_context.get("macro_view", {}).get("macro_label")
                if world_context
                else None
            ),
            "world_macro_score": (
                world_context.get("macro_view", {}).get("macro_score")
                if world_context
                else None
            ),
            "world_regime_label": (
                world_context.get("final_regime", {}).get("final_label")
                if world_context
                else None
            ),
            "world_regime_score": (
                world_context.get("final_regime", {}).get("final_score")
                if world_context
                else None
            ),
            "world_regime_divergence": (
                world_context.get("final_regime", {}).get("divergence")
                if world_context
                else None
            ),
            "world_regime_fusion_reason": (
                world_context.get("final_regime", {}).get("fusion_reason")
                if world_context
                else None
            ),
            "world_scout_score": (
                world_context.get("scout_score") if world_context else None
            ),
            "world_scout_label": (
                world_context.get("scout_label") if world_context else None
            ),
            "world_scout_thesis": (
                world_context.get("scout_thesis") if world_context else None
            ),
            "world_scout_role": "advisory",
            "world_context_generated_at": (
                cast(str, world_context.get("generated_at")).replace("+00:00", "Z")
                if world_context and world_context.get("generated_at")
                else None
            ),
            "world_context_age_minutes": (
                round(world_age, 2) if isinstance(world_age, (int, float)) else None
            ),
            "world_context_sources_used": (
                len(world_context.get("sources_used", [])) if world_context else None
            ),
            "world_context_raw_count": (
                world_context.get("raw_count") if world_context else None
            ),
        }
    )
    if intent.target_risk_exposure_pct is None or intent.rebalance_buffer_pct is None:
        raise ValueError("Intent missing target/buffer enrichment fields.")
    print(
        f"Tick summary: action={intent.action_type} symbol={intent.symbol or '-'} "
        f"cur={intent.pre_risk_exposure_pct:.2%} "
        f"tgt={intent.target_risk_exposure_pct:.2%} "
        f"buf={intent.rebalance_buffer_pct:.2%} "
        f"reason={intent.reason_code or '-'}"
    )

    if intent.action_type in {"BUY", "SELL"}:
        notifications.notify_action(intent)
    else:
        notifications.notify_info("No action taken.")

    # Execute first (this updates intent with expected_price if trade happens)
    execution_engine.execute_intent(intent, snapshot)

    # Then log it
    intent_logger.log_intent(intent)
    
    # --- Professional Hardening: State Update ---
    from valuesteward.steward_state import update_steward_state
    run_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    update_steward_state(
        lambda state: {
            **state,
            "last_run_at": run_at,
        }
    )
    # --------------------------------------------
    
    # --- Professional Hardening: SQLite Sync ---
    try:
        from valuesteward.data.db_manager import DatabaseManager
        db_mgr = DatabaseManager()
        db_mgr.sync_intent(intent.to_json_dict())
        # Sync the full signal ranking
        if signal_result and signal_result.signals:
            db_mgr.sync_signals(
                signal_result.signals, 
                world_context_id=intent.world_context_generated_at
            )
        # Also sync latest world context to ensure FKs work
        if world_context:
            db_mgr.sync_world_context(world_context)
    except Exception as exc:
        print(f"[DB-WARN] SQLite sync failed: {exc}")
    # ------------------------------------------

    print("Logged intent to logs/intent_log.jsonl")
    print(f"Memory now contains {len(memory_engine.get_all_intents())} intents.")


@main.command()
@click.option(
    "--limit",
    "-n",
    default=20,
    show_default=True,
    type=int,
    help="Number of recent intents to show.",
)
@click.option(
    "--filter-action",
    type=click.Choice(["ALL", "BUY", "SELL", "NO_ACTION"], case_sensitive=False),
    default="ALL",
    show_default=True,
    help="Filter by action type.",
)
def history(limit: int, filter_action: str) -> None:
    """Show recent intent history from memory."""

    memory_engine = MemoryEngine()
    intents = memory_engine.get_recent_intents(limit=limit)
    action_filter = filter_action.upper()
    for intent in intents:
        if action_filter != "ALL" and intent.action_type != action_filter:
            continue
        symbol = intent.symbol or "-"
        timestamp = intent.timestamp.isoformat()
        # A read-only history view must not crash on a single legacy/partial
        # row that predates enrichment — fall back to 0.0 for display rather
        # than raising and breaking the whole listing.
        target = (
            intent.target_risk_exposure_pct
            if intent.target_risk_exposure_pct is not None
            else 0.0
        )
        buffer = (
            intent.rebalance_buffer_pct
            if intent.rebalance_buffer_pct is not None
            else 0.0
        )
        reason = intent.reason_code or "-"
        print(
            f"{timestamp}  {intent.mode.value}  {intent.action_type}  "
            f"{symbol}  cur={intent.pre_risk_exposure_pct:.2f}  "
            f"tgt={target:.2f}  buf={buffer:.2f}  reason={reason}"
        )
        print(f"    {intent.explanation}")


@main.command()
@click.option(
    "--limit",
    "-n",
    default=100,
    show_default=True,
    type=int,
    help="Number of recent intents to include.",
)
@click.option(
    "--send-email",
    is_flag=True,
    help="Send the report via email.",
)
def report(limit: int, send_email: bool) -> None:
    """Print a behavioral summary of the last N intents."""

    memory_engine = MemoryEngine()
    intents = memory_engine.get_recent_intents(limit=limit)
    report_data = build_report(intents)

    print(f"Value Steward Report (last {report_data['total']} intents)")
    print("-" * 38)
    print(f"Mode: {report_data['mode']}")
    print(f"Core symbol: {report_data['core_symbol']}")
    target_exposure = report_data.get("target_exposure_pct")
    buffer_pct = report_data.get("buffer_pct")
    if target_exposure is None or buffer_pct is None:
        print("Target exposure: n/a")
        print("Buffer: ±n/a")
    else:
        print(f"Target exposure: {target_exposure:.1%}")
        print(f"Buffer: ±{buffer_pct:.1%}")
    
    if send_email:
        from valuesteward.logging_utils.notifications import NotificationService
        notifications = NotificationService()
        notifications.notify_steward_insights(intents)
        print("\n[INFO] Steward Insights email sent.")
    print()
    print(f"Total intents: {report_data['total']}")
    print(
        f"  NO_ACTION: {report_data['no_action_count']:3d} "
        f"({report_data['no_action_pct']:.1f}%)"
    )
    print(
        f"  BUY      : {report_data['buy_count']:3d} "
        f"({report_data['buy_pct']:.1f}%)"
    )
    print(
        f"  SELL     : {report_data['sell_count']:3d} "
        f"({report_data['sell_pct']:.1f}%)"
    )
    print()
    if report_data["avg_pre_trade_exposure"] is None:
        print("Average pre-trade exposure on BUY/SELL: n/a (no BUY/SELL intents)")
    else:
        print(
            "Average pre-trade exposure on BUY/SELL: "
            f"{report_data['avg_pre_trade_exposure']:.1%}"
        )
    print(
        "Most recent exposure:  "
        f"cur={report_data['latest_pre_risk']:.1%}  "
        f"post={report_data['latest_post_risk']:.1%}"
    )
    print(f"Most recent reason:    {report_data['latest_reason']}")


def _parse_horizons(value: str) -> list[int]:
    raw = value or ""
    horizons: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            num = int(part)
        except ValueError:
            continue
        if num > 0:
            horizons.append(num)
    return sorted(set(horizons))


def _extract_bar_date(bar) -> datetime | None:
    ts = getattr(bar, "timestamp", None) or getattr(bar, "t", None)
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts
    try:
        return datetime.fromisoformat(str(ts))
    except ValueError:
        return None


def _build_price_series(bars: list) -> tuple[list[date], dict[date, float]]:
    by_date: dict[date, float] = {}
    for bar in bars:
        dt = _extract_bar_date(bar)
        if dt is None:
            continue
        close = getattr(bar, "close", None)
        if close is None:
            close = getattr(bar, "c", None)
        if close is None:
            continue
        by_date[dt.date()] = float(close)
    dates = sorted(by_date.keys())
    return dates, by_date


def _resolve_symbol(intent) -> str | None:
    return (
        (intent.signal_symbol or "").strip().upper()
        or (intent.symbol or "").strip().upper()
        or (intent.core_symbol or "").strip().upper()
        or None
    )


@main.command("scorecard")
@click.option(
    "--out",
    default="data/signal-scorecard.jsonl",
    show_default=True,
    help="Path to write scorecard entries.",
)
@click.option(
    "--limit",
    default=200,
    show_default=True,
    type=int,
    help="Number of recent intents to score.",
)
@click.option(
    "--horizons",
    default="1,5,20",
    show_default=True,
    help="Comma-separated forward return horizons (trading days).",
)
@click.option(
    "--benchmark",
    default="",
    show_default=True,
    help="Benchmark symbol (defaults to VS_SIGNAL_BENCHMARK or SPY).",
)
def scorecard(out: str, limit: int, horizons: str, benchmark: str) -> None:
    """Build a signal scorecard of intent outcomes vs future returns."""

    memory = MemoryEngine()
    intents = memory.get_recent_intents(limit=limit)
    if not intents:
        print("No intents found.")
        return

    horizon_list = _parse_horizons(horizons)
    if not horizon_list:
        raise click.ClickException("No valid horizons provided.")
    max_horizon = max(horizon_list)

    benchmark_symbol = benchmark.strip().upper()
    if not benchmark_symbol:
        benchmark_symbol = (os.getenv("VS_SIGNAL_BENCHMARK", "SPY") or "SPY").strip().upper()

    steward_state = load_steward_state()
    phase1_start_date = get_phase1_start_date(steward_state)

    symbols = {
        symbol
        for intent in intents
        if (symbol := _resolve_symbol(intent)) is not None
        and is_on_or_after_phase1_start(intent.timestamp, steward_state)
    }
    symbols.add(benchmark_symbol)

    filtered_intents = [
        intent
        for intent in intents
        if is_on_or_after_phase1_start(intent.timestamp, steward_state)
    ]
    if not filtered_intents:
        print(
            "No intents found within the active Phase 1 window."
            if phase1_start_date
            else "No intents found."
        )
        return

    earliest = min(intent.timestamp.date() for intent in filtered_intents)
    today = datetime.now(timezone.utc).date()
    lookback_days = (today - earliest).days + max_horizon + 5
    lookback_days = max(lookback_days, max_horizon + 10)

    data_client = MarketDataClient(get_settings())
    series_by_symbol: dict[str, tuple[list[date], dict[date, float]]] = {}

    symbol_list = sorted(symbols)
    chunk_size = 200
    for i in range(0, len(symbol_list), chunk_size):
        chunk = symbol_list[i : i + chunk_size]
        bars_by_symbol = data_client.get_daily_bars(chunk, lookback_days)
        for symbol, bars in bars_by_symbol.items():
            dates, closes = _build_price_series(list(bars))
            series_by_symbol[symbol] = (dates, closes)

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    existing_records: dict[str, dict[str, Any]] = {}
    unkeyed_records: list[dict[str, Any]] = []
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                payload = json.loads(line)
                intent_id = payload.get("intent_id")
                if intent_id:
                    existing_records[str(intent_id)] = payload
                else:
                    unkeyed_records.append(payload)
            except json.JSONDecodeError:
                continue

    added_records = 0
    refreshed_records = 0
    for intent in filtered_intents:
        symbol = _resolve_symbol(intent)
        entry_date = intent.timestamp.date()

        def compute_returns(
            symbol_name: str | None,
        ) -> tuple[date | None, float | None, dict[str, float | None]]:
            if not symbol_name:
                return None, None, {}
            series = series_by_symbol.get(symbol_name)
            if not series:
                return None, None, {}
            dates, closes = series
            if not dates:
                return None, None, {}
            idx = None
            for i, dt in enumerate(dates):
                if dt >= entry_date:
                    idx = i
                    break
            if idx is None:
                return None, None, {}
            entry_dt = dates[idx]
            entry_close = closes.get(entry_dt)
            returns: dict = {}
            for horizon in horizon_list:
                target_idx = idx + horizon
                if target_idx >= len(dates):
                    returns[str(horizon)] = None
                    continue
                target_dt = dates[target_idx]
                target_close = closes.get(target_dt)
                if entry_close is None or target_close is None:
                    returns[str(horizon)] = None
                    continue
                returns[str(horizon)] = (target_close / entry_close) - 1.0
            return entry_dt, entry_close, returns

        entry_dt, entry_close, symbol_returns = compute_returns(symbol)
        _, _, benchmark_returns = compute_returns(benchmark_symbol)

        horizons_payload = {}
        for horizon in horizon_list:
            key = str(horizon)
            sym_ret = symbol_returns.get(key) if symbol_returns else None
            bench_ret = benchmark_returns.get(key) if benchmark_returns else None
            cash_ret = 0.0
            direction = None
            if intent.action_type == "BUY":
                direction = 1
            elif intent.action_type == "SELL":
                direction = -1
            elif intent.action_type == "NO_ACTION":
                # Counterfactual: BUY_BLOCKED is "would have bought but a gate
                # stopped us"; sign as +1 so signed_return / excess_vs_benchmark
                # capture the missed opportunity. SELL_* symmetric.
                # Other NO_ACTION reasons stay at 0 (genuinely no signal taken).
                reason = (intent.reason_code or "").upper()
                if reason.startswith("BUY_"):
                    direction = 1
                elif reason.startswith("SELL_"):
                    direction = -1
                else:
                    direction = 0
            signed = sym_ret * direction if sym_ret is not None and direction is not None else None
            excess_vs_benchmark = None
            if signed is not None and bench_ret is not None:
                excess_vs_benchmark = signed - bench_ret
            excess_vs_cash = signed if signed is not None else None
            correct = None
            if sym_ret is not None:
                if intent.action_type == "BUY":
                    correct = sym_ret > 0
                elif intent.action_type == "SELL":
                    correct = sym_ret < 0
                elif intent.action_type == "NO_ACTION":
                    reason = (intent.reason_code or "").upper()
                    if reason.startswith("BUY_"):
                        correct = sym_ret > 0
                    elif reason.startswith("SELL_"):
                        correct = sym_ret < 0
            horizons_payload[key] = {
                "return": sym_ret,
                "benchmark_return": bench_ret,
                "cash_return": cash_ret,
                "excess_vs_benchmark": excess_vs_benchmark,
                "excess_vs_cash": excess_vs_cash,
                "signed_return": signed,
                "directional_correct": correct,
            }

        record = {
            "intent_id": intent.id,
            "timestamp": intent.timestamp.isoformat(),
            "action_type": intent.action_type,
            "reason_code": intent.reason_code,
            "symbol": symbol,
            "benchmark": benchmark_symbol,
            "entry_date": entry_dt.isoformat() if entry_dt else None,
            "entry_close": entry_close,
            "expected_price": intent.expected_price,
            "signal_score": intent.signal_score,
            "signal_score_raw": intent.signal_score_raw,
            "signal_score_smoothed": intent.signal_score_smoothed,
            "execution_quality_score": intent.execution_quality_score,
            "signal_fill_rate": intent.signal_fill_rate,
            "signal_expire_rate": intent.signal_expire_rate,
            "signal_submission_rate": intent.signal_submission_rate,
            "signal_repeat_attempt_penalty": intent.signal_repeat_attempt_penalty,
            "signal_realized_alpha_prior": intent.signal_realized_alpha_prior,
            "signal_alpha_prior_avg_excess_benchmark": (
                intent.signal_alpha_prior_avg_excess_benchmark
            ),
            "signal_alpha_prior_sample_count": (
                intent.signal_alpha_prior_sample_count
            ),
            "signal_intraday_persistence_score": (
                intent.signal_intraday_persistence_score
            ),
            "signal_intraday_persistence_seen_count": (
                intent.signal_intraday_persistence_seen_count
            ),
            "signal_intraday_persistence_day_count": (
                intent.signal_intraday_persistence_day_count
            ),
            "signal_momentum_rank": intent.signal_momentum_rank,
            "signal_vol_rank": intent.signal_vol_rank,
            "signal_drawdown_rank": intent.signal_drawdown_rank,
            "signal_rel_strength_20d": intent.signal_rel_strength_20d,
            "signal_rel_strength_60d": intent.signal_rel_strength_60d,
            "signal_trend_strength": intent.signal_trend_strength,
            "signal_mom_5d": intent.signal_mom_5d,
            "signal_mom_20d": intent.signal_mom_20d,
            "signal_mom_60d": intent.signal_mom_60d,
            "signal_volatility": intent.signal_volatility,
            "signal_drawdown": intent.signal_drawdown,
            "policy_schema_version": intent.policy_schema_version,
            "policy_version": intent.policy_version,
            "world_macro_label": intent.world_macro_label,
            "world_macro_score": intent.world_macro_score,
            "horizons": horizons_payload,
        }
        if intent.id in existing_records:
            refreshed_records += 1
        else:
            added_records += 1
        existing_records[intent.id] = record

    persisted_records = [
        *unkeyed_records,
        *sorted(
            existing_records.values(),
            key=lambda payload: payload.get("timestamp") or "",
        ),
    ]
    if persisted_records:
        _write_jsonl_atomic(out_path, persisted_records)

    if added_records or refreshed_records:
        print(
            "Scorecard entries refreshed: "
            f"added={added_records} updated={refreshed_records}"
        )
    else:
        print("No scorecard entries refreshed.")

    all_records = [
        payload
        for payload in persisted_records
        if is_on_or_after_phase1_start(
            payload.get("entry_date") or payload.get("timestamp"),
            steward_state,
        )
    ]

    def fmt_pct(value: float | None) -> str:
        return f"{value:.2%}" if isinstance(value, (int, float)) else "n/a"

    print("\nScorecard summary")
    summary_payload: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "phase1_start_date": phase1_start_date.isoformat() if phase1_start_date else None,
        "total_records": len(all_records),
        "horizons": {},
    }
    horizon_summary: dict[str, Any] = {}
    summary_payload["horizons"] = horizon_summary
    for horizon in horizon_list:
        key = str(horizon)
        returns = []
        excess_benchmark = []
        excess_cash = []
        signed_returns = []
        buy_correct = []
        sell_correct = []
        beat_cash = []
        beat_benchmark = []
        no_action_beats_bench = []
        no_action_missed = []
        for record in all_records:
            horizons_raw = record.get("horizons")
            horizons_map = (
                cast(dict[str, Any], horizons_raw)
                if isinstance(horizons_raw, dict)
                else {}
            )
            data_raw = horizons_map.get(key, {})
            data = cast(dict[str, Any], data_raw) if isinstance(data_raw, dict) else {}
            ret = data.get("return")
            ex_bench = data.get("excess_vs_benchmark")
            ex_cash = data.get("excess_vs_cash")
            sign = data.get("signed_return")
            bench_ret = data.get("benchmark_return")
            if isinstance(ret, (int, float)):
                returns.append(ret)
            if isinstance(ex_bench, (int, float)):
                excess_benchmark.append(ex_bench)
            if isinstance(ex_cash, (int, float)):
                excess_cash.append(ex_cash)
            if isinstance(sign, (int, float)):
                signed_returns.append(sign)
                beat_cash.append(sign > 0)
                if isinstance(bench_ret, (int, float)):
                    beat_benchmark.append(sign > bench_ret)
            if record.get("action_type") == "NO_ACTION" and isinstance(
                bench_ret, (int, float)
            ):
                no_action_beats_bench.append(bench_ret < 0)
                no_action_missed.append(bench_ret > 0)
            if record.get("action_type") == "BUY" and data.get("directional_correct") is not None:
                buy_correct.append(data.get("directional_correct"))
            if record.get("action_type") == "SELL" and data.get("directional_correct") is not None:
                sell_correct.append(data.get("directional_correct"))

        avg_ret = statistics.mean(returns) if returns else None
        avg_excess_benchmark = (
            statistics.mean(excess_benchmark) if excess_benchmark else None
        )
        avg_excess_cash = statistics.mean(excess_cash) if excess_cash else None
        avg_signed = statistics.mean(signed_returns) if signed_returns else None
        buy_hit = (
            sum(1 for item in buy_correct if item) / len(buy_correct)
            if buy_correct
            else None
        )
        sell_hit = (
            sum(1 for item in sell_correct if item) / len(sell_correct)
            if sell_correct
            else None
        )
        beat_cash_rate = (
            sum(1 for item in beat_cash if item) / len(beat_cash)
            if beat_cash
            else None
        )
        beat_benchmark_rate = (
            sum(1 for item in beat_benchmark if item) / len(beat_benchmark)
            if beat_benchmark
            else None
        )
        no_action_beats_rate = (
            sum(1 for item in no_action_beats_bench if item)
            / len(no_action_beats_bench)
            if no_action_beats_bench
            else None
        )
        no_action_missed_rate = (
            sum(1 for item in no_action_missed if item) / len(no_action_missed)
            if no_action_missed
            else None
        )
        horizon_summary[key] = {
            "samples": len(returns),
            "avg_return": avg_ret,
            "avg_signed_return": avg_signed,
            "avg_excess_benchmark": avg_excess_benchmark,
            "avg_excess_cash": avg_excess_cash,
            "buy_hit_rate": buy_hit,
            "sell_hit_rate": sell_hit,
            "beat_cash_rate": beat_cash_rate,
            "beat_benchmark_rate": beat_benchmark_rate,
            "no_action_samples": len(no_action_beats_bench),
            "no_action_beats_benchmark_rate": no_action_beats_rate,
            "no_action_missed_rate": no_action_missed_rate,
        }
        print(
            f"- {horizon}d: samples={len(returns)} "
            f"avg={fmt_pct(avg_ret)} signed={fmt_pct(avg_signed)} "
            f"excess_vs_bench={fmt_pct(avg_excess_benchmark)} "
            f"excess_vs_cash={fmt_pct(avg_excess_cash)}"
        )
        if buy_hit is not None or sell_hit is not None:
            buy_text = f"{buy_hit:.1%}" if buy_hit is not None else "n/a"
            sell_text = f"{sell_hit:.1%}" if sell_hit is not None else "n/a"
            print(f"  buy_hit={buy_text} sell_hit={sell_text}")
        else:
            print("  buy_hit=n/a sell_hit=n/a")
            if beat_cash_rate is not None or beat_benchmark_rate is not None:
                cash_text = f"{beat_cash_rate:.1%}" if beat_cash_rate is not None else "n/a"
                bench_text = (
                    f"{beat_benchmark_rate:.1%}"
                    if beat_benchmark_rate is not None
                    else "n/a"
                )
                print(f"  beat_cash={cash_text} beat_benchmark={bench_text}")
        if no_action_beats_rate is not None or no_action_missed_rate is not None:
            avoid_text = (
                f"{no_action_beats_rate:.1%}"
                if no_action_beats_rate is not None
                else "n/a"
            )
            miss_text = (
                f"{no_action_missed_rate:.1%}"
                if no_action_missed_rate is not None
                else "n/a"
            )
            print(f"  no_action_avoid={avoid_text} no_action_missed={miss_text}")

    summary_path = Path("data/scorecard-summary.json")
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary_payload, indent=2), encoding="utf-8")
    summary_log = Path("data/scorecard-summary.jsonl")
    with summary_log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(summary_payload) + "\n")


@main.command("patterns")
@click.option(
    "--limit",
    default=500,
    show_default=True,
    type=int,
    help="Maximum number of recent intents to include when building episodes.",
)
@click.option(
    "--min-samples",
    default=3,
    show_default=True,
    type=int,
    help="Minimum episodes per regime fingerprint to form a pattern.",
)
@click.option(
    "--history-path",
    default="data/history.jsonl",
    show_default=True,
    help="Path to the JS tick history file (used for PnL estimation).",
)
@click.option(
    "--patterns-path",
    default="data/patterns.jsonl",
    show_default=True,
    help="Path to write/update the pattern library.",
)
def patterns(
    limit: int,
    min_samples: int,
    history_path: str,
    patterns_path: str,
) -> None:
    """Build or update the PatternLibrary from recent episode history.

    Data flow::

        intent_log.jsonl  +  data/history.jsonl
                |
        EpisodeExtractor.build_episodes()   (PnL from history)
                |
        PatternLibrary.update_from_episodes()
                |
        data/patterns.jsonl                (read by DecisionEngine on next tick)

    Run this command regularly (e.g. nightly or after each trading session)
    so the DecisionEngine always has fresh pattern priors.
    """
    memory = MemoryEngine()
    intents = memory.get_recent_intents(limit=limit)
    if not intents:
        print("No intents found in memory. Run 'tick' first.")
        return

    print(f"Loaded {len(intents)} intents from memory.")

    history_entries = load_history_entries(history_path)
    print(f"Loaded {len(history_entries)} history entries from {history_path}.")

    extractor = EpisodeExtractor(intents=intents, history_entries=history_entries)
    episodes = extractor.build_episodes()
    print(f"Built {len(episodes)} episodes.")

    trade_episodes = [ep for ep in episodes if ep.has_buy or ep.has_sell]
    scored_episodes = [ep for ep in trade_episodes if ep.realized_pnl is not None]
    print(
        f"  Trade episodes (BUY or SELL): {len(trade_episodes)}\n"
        f"  With PnL data: {len(scored_episodes)}"
    )

    if not scored_episodes:
        print(
            "\nNo scored episodes yet. This is expected early on -- the library needs "
            "at least one BUY or SELL intent followed by history data to compute PnL. "
            "Keep running 'tick'; patterns will form automatically once trade data accumulates."
        )
    else:
        # Show episode summary before updating library.
        from collections import Counter
        fingerprint_counts = Counter(
            "|".join(ep.regime_tags) if ep.regime_tags else "DEFAULT"
            for ep in scored_episodes
        )
        print("\nRegime fingerprints in scored episodes:")
        for fp, count in fingerprint_counts.most_common():
            avg_pnl = sum(
                ep.realized_pnl for ep in scored_episodes
                if ("|".join(ep.regime_tags) if ep.regime_tags else "DEFAULT") == fp
                and ep.realized_pnl is not None
            ) / count
            print(f"  {fp:<50s}  n={count:3d}  avg_pnl={avg_pnl:+.4f}")

    library = PatternLibrary(path=patterns_path, min_samples=min_samples)
    print(f"\nPattern library loaded: {library.pattern_count()} existing patterns.")

    updated = library.update_from_episodes(episodes)
    if updated:
        print(f"Updated/created {len(updated)} pattern(s):")
        for card in sorted(updated, key=lambda c: c.avg_return, reverse=True):
            print(
                f"  [{card.status:7s}] {card.pattern_id}  "
                f"n={card.sample_size:3d}  "
                f"avg_return={card.avg_return:+.4f}  "
                f"max_drawdown={card.max_drawdown:.4f}  "
                f"tags={card.tag_fingerprint}"
            )
    else:
        print("No patterns updated (not enough scored episodes per regime yet).")

    print(
        f"\nPattern library summary: "
        f"{library.pattern_count()} total, {library.active_count()} active."
    )
    active = library.list_patterns()
    if active:
        print("\nActive patterns (by avg_return desc):")
        for card in sorted(active, key=lambda c: c.avg_return, reverse=True):
            print(
                f"  {card.pattern_id}  "
                f"n={card.sample_size:3d}  "
                f"avg={card.avg_return:+.4f}  "
                f"dd={card.max_drawdown:.4f}  "
                f"tags={card.tag_fingerprint}"
            )


@main.command("weekly-report")
@click.option(
    "--output", "-o", default="data/weekly-tearsheet.html", help="Output path for HTML report."
)
def weekly_report(output: str) -> None:
    """Generate a professional QuantStats tear sheet."""
    import pandas as pd
    import quantstats as qs
    
    history_path = Path("data/history.jsonl")
    if not history_path.exists():
        print("No history data found. Run a few ticks first.")
        return

    # Load history and extract equity time-series
    records = []
    with open(history_path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                records.append(json.loads(line))
            except Exception:
                continue # nosec
    if not records:
        print("History file is empty.")
        return

    df = pd.DataFrame(records)
    df['timestamp'] = pd.to_datetime(df['ranAt'])
    df.set_index('timestamp', inplace=True)
    
    # QuantStats expects a Series of daily returns
    # We first get daily equity close
    equity = df['equity'].resample('D').last().dropna()
    returns = equity.pct_change().dropna()
    
    if len(returns) < 2:
        print(
            "Not enough daily data to generate a meaningful QuantStats report yet "
            "(need at least 2 trading days)."
        )
        return

    print(f"Generating professional tear sheet to {output}...")
    qs.reports.html(returns, benchmark="SPY", output=output, title="Value Steward Performance")
    print("Report complete.")


@main.command()
def orders() -> None:
    """List all open orders from Alpaca."""
    from valuesteward.data.alpaca_client import AlpacaClient
    client = AlpacaClient()
    open_orders = client.get_open_orders()
    
    if not open_orders:
        print("No open orders.")
        return

    print(f"{'ID':<36} | {'Symbol':<6} | {'Side':<4} | {'Qty':<8} | {'Type':<6} | {'Price':<8}")
    print("-" * 80)
    for o in open_orders:
        limit = getattr(o, "limit_price", "MKT")
        qty = str(o.qty) if o.qty else "0"
        side = str(o.side)
        ord_type = str(o.type)
        print(f"{str(o.id):<36} | {o.symbol:<6} | {side:<4} | {qty:<8} | {ord_type:<6} | {limit}")


if __name__ == "__main__":
    main()
