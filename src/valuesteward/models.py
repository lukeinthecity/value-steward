"""Domain models for the Value Steward system."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import uuid4

from pydantic import BaseModel, Field


class RiskMode(str, Enum):
    """Supported risk modes."""

    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class Position(BaseModel):
    """A single portfolio position."""

    symbol: str
    quantity: float
    market_value: float
    asset_class: str


class PortfolioSnapshot(BaseModel):
    """Snapshot of current portfolio state."""

    timestamp: datetime
    cash: float
    equity: float
    positions: List[Position]
    risk_exposure_pct: float


class TradeAction(BaseModel):
    """A single execution action within a multi-step plan."""

    symbol: str
    side: str
    notional: float
    size_pct: Optional[float] = None
    reason: Optional[str] = None


class IntentRecord(BaseModel):
    """A logged intent for auditability and future learning."""

    id: str = Field(default_factory=lambda: str(uuid4()))
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    mode: RiskMode
    action_type: str
    symbol: Optional[str] = None
    size_pct: Optional[float] = None
    pre_risk_exposure_pct: float = 0.0
    post_risk_exposure_pct: float = 0.0
    target_risk_exposure_pct: Optional[float] = None
    rebalance_buffer_pct: Optional[float] = None
    core_symbol: Optional[str] = None
    target_exposure_pct: Optional[float] = None
    buffer_pct: Optional[float] = None
    reason_code: Optional[str] = None
    world_tags: List[str] = Field(default_factory=list)
    patterns_consulted: List[str] = Field(default_factory=list)
    explanation: str
    policy_schema_version: Optional[int] = None
    policy_version: Optional[int] = None
    policy_risk_level: Optional[float] = None
    policy_mode: Optional[str] = None
    policy_target_risk_exposure_pct_low: Optional[float] = None
    policy_rebalance_buffer_pct: Optional[float] = None
    policy_force_no_trade: Optional[bool] = None
    world_macro_label: Optional[str] = None
    world_macro_score: Optional[float] = None
    world_context_generated_at: Optional[str] = None
    world_context_age_minutes: Optional[float] = None
    world_context_sources_used: Optional[int] = None
    world_context_raw_count: Optional[int] = None
    signal_symbol: Optional[str] = None
    signal_score: Optional[float] = None
    signal_score_raw: Optional[float] = None
    signal_score_smoothed: Optional[float] = None
    signal_trend_strength: Optional[float] = None
    signal_volatility: Optional[float] = None
    signal_drawdown: Optional[float] = None
    signal_day_return: Optional[float] = None
    signal_mom_5d: Optional[float] = None
    signal_mom_20d: Optional[float] = None
    signal_mom_60d: Optional[float] = None
    signal_rel_strength_20d: Optional[float] = None
    signal_rel_strength_60d: Optional[float] = None
    signal_momentum_rank: Optional[float] = None
    signal_vol_rank: Optional[float] = None
    signal_drawdown_rank: Optional[float] = None
    signal_sector: Optional[str] = None
    signal_universe_size: Optional[int] = None
    risk_off: Optional[bool] = None
    risk_off_reason: Optional[str] = None
    actions: List[TradeAction] = Field(default_factory=list)

    def to_json_dict(self) -> dict:
        """Return a JSON-serializable dict for logging."""

        data = self.model_dump()
        data["timestamp"] = self.timestamp.isoformat()
        data["mode"] = self.mode.value
        return data
