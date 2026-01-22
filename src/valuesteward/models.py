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

    def to_json_dict(self) -> dict:
        """Return a JSON-serializable dict for logging."""

        data = self.model_dump()
        data["timestamp"] = self.timestamp.isoformat()
        data["mode"] = self.mode.value
        return data
