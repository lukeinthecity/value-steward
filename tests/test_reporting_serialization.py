from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from uuid import uuid4

from valuesteward.cli import _format_order


class DummySide(Enum):
    BUY = "buy"


class DummyOrder:
    def __init__(self) -> None:
        self.id = uuid4()
        self.symbol = "WMB"
        self.side = DummySide.BUY
        self.status = "filled"
        self.qty = Decimal("1.25")
        self.notional = Decimal("12.50")
        self.type = "market"
        self.time_in_force = "day"
        self.submitted_at = datetime(2026, 3, 20, 19, 30, tzinfo=timezone.utc)
        self.filled_at = datetime(2026, 3, 20, 19, 31, tzinfo=timezone.utc)
        self.filled_avg_price = Decimal("10.00")


def test_format_order_returns_json_serializable_scalars() -> None:
    order = DummyOrder()

    payload = _format_order(order)

    assert isinstance(payload["id"], str)
    assert payload["side"] == "buy"
    assert payload["qty"] == "1.25"
    assert payload["notional"] == "12.50"
    assert payload["filled_avg_price"] == "10.00"
