"""Session-wide test setup: force hermetic Alpaca credentials.

Several tests construct engines whose internals build a real Alpaca client.
With genuine keys present in ``.env`` those clients make live API calls —
slow (~3 min suite), non-deterministic, and against the CLAUDE.md standard
of "no real Alpaca calls" in tests. Forcing dummy credentials here, before
pytest collects any test module, means:

  * pydantic-settings ranks OS env vars above the ``.env`` file, so the dummy
    keys win over real ones and every such call fails fast instead of doing
    real network work; and
  * the suite runs even with no ``.env`` present (the otherwise-required
    ALPACA_* fields are satisfied).

Tests that genuinely need to exercise the client inject a fake instead.
"""

import os

from valuesteward.config import get_settings

os.environ["ALPACA_API_KEY_ID"] = "test-key"  # nosec B105
os.environ["ALPACA_SECRET_KEY"] = "test-secret"  # nosec B105

# conftest loads before any test module, so the settings cache is normally
# cold here; clear it defensively in case an earlier import warmed it.
get_settings.cache_clear()
