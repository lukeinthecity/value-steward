"""Command line interface for Value Steward."""

import click

from valuesteward.config import get_settings
from valuesteward.core.decision_engine import DecisionEngine
from valuesteward.core.execution_engine import ExecutionEngine
from valuesteward.core.memory import MemoryEngine
from valuesteward.core.patterns import PatternLibrary
from valuesteward.core.reporting import build_report
from valuesteward.core.risk_governor import RiskGovernor
from valuesteward.core.signal_engine import SignalEngine
from valuesteward.core.world_recognition import infer_world_tags
from valuesteward.world_context import (
    load_latest_world_context,
    world_context_age_minutes,
)
from valuesteward.data.alpaca_client import AlpacaClient
from valuesteward.data.portfolio_repository import PortfolioRepository
from valuesteward.logging_utils.intent_logger import IntentLogger
from valuesteward.logging_utils.notifications import NotificationService
from valuesteward.policy import apply_policy_to_settings, load_policy


@click.group()
def main() -> None:
    """Value Steward CLI."""


@main.command()
def status() -> None:
    """Print current portfolio status."""

    settings = get_settings()
    repo = PortfolioRepository()
    snapshot = repo.get_current_snapshot()
    print(f"equity: {snapshot.equity:.2f}")
    print(f"cash: {snapshot.cash:.2f}")
    print(f"risk_exposure_pct: {snapshot.risk_exposure_pct:.2f}")
    print(f"mode: {settings.mode}")


@main.command()
def tick() -> None:
    """Run one full decision cycle of the Value Steward."""

    settings = get_settings()
    policy, policy_warnings = load_policy()
    for warning in policy_warnings:
        print(f"[POLICY] Warning: {warning}")
    settings = apply_policy_to_settings(settings, policy)
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
    world_context = load_latest_world_context()
    world_tags = infer_world_tags(snapshot, world_context)
    intent = decision_engine.decide(snapshot, world_tags, world_context=world_context)
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
            "world_context_generated_at": (
                world_context.get("generated_at") if world_context else None
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
    intent_logger.log_intent(intent)
    print("Logged intent to logs/intent_log.jsonl")
    print(f"Memory now contains {len(memory_engine.get_all_intents())} intents.")
    if intent.target_exposure_pct is None or intent.buffer_pct is None:
        raise ValueError("Intent missing target/buffer enrichment fields.")
    print(
        f"Tick summary: action={intent.action_type} symbol={intent.symbol or '-'} "
        f"cur={intent.pre_risk_exposure_pct:.2%} "
        f"tgt={intent.target_exposure_pct:.2%} "
        f"buf={intent.buffer_pct:.2%} "
        f"reason={intent.reason_code or '-'}"
    )

    if intent.action_type in {"BUY", "SELL"}:
        notifications.notify_action(intent)
    else:
        notifications.notify_info("No action taken.")

    execution_engine.execute_intent(intent, snapshot)


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
        if intent.target_exposure_pct is None or intent.buffer_pct is None:
            raise ValueError("Intent missing target/buffer enrichment fields.")
        target = intent.target_exposure_pct
        buffer = intent.buffer_pct
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
def report(limit: int) -> None:
    """Print a behavioral summary of the last N intents."""

    memory_engine = MemoryEngine()
    intents = memory_engine.get_recent_intents(limit=limit)
    report_data = build_report(intents)

    print(f"Value Steward Report (last {report_data['total']} intents)")
    print("-" * 38)
    print(f"Mode: {report_data['mode']}")
    print(f"Core symbol: {report_data['core_symbol']}")
    target_exposure = report_data["target_exposure_pct"]
    buffer_pct = report_data["buffer_pct"]
    if target_exposure is None or buffer_pct is None:
        print("Target exposure: n/a")
        print("Buffer: ±n/a")
    else:
        print(f"Target exposure: {target_exposure:.1%}")
        print(f"Buffer: ±{buffer_pct:.1%}")
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


if __name__ == "__main__":
    main()
