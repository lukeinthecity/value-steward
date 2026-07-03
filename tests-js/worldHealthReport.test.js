import test from "node:test";
import assert from "node:assert/strict";

import {
  getFreshnessTimestampForSource,
  summarizeInbox,
  updateHealthState,
} from "../world/healthReport.js";

test("forward-looking feeds use ingestion time for freshness", () => {
  const source = {
    id: "economic-calendar",
    tags: ["macro", "economic-calendar", "forward"],
  };
  const data = {
    last_ts: "2026-04-04T10:05:01.602Z",
    last_published: "2026-04-04T16:00:00.000Z",
  };

  const freshnessTs = getFreshnessTimestampForSource(source, data);

  assert.equal(freshnessTs, "2026-04-04T10:05:01.602Z");
});

test("summarizeInbox does not emit negative ages for forward-looking feeds", () => {
  const now = Date.now;
  Date.now = () => Date.parse("2026-04-04T10:05:01.602Z");

  try {
    const rows = summarizeInbox(
      [
        {
          source_id: "economic-calendar",
          ts: "2026-04-04T10:05:01.602Z",
          published: "2026-04-04T16:00:00.000Z",
        },
      ],
      [
        {
          id: "economic-calendar",
          label: "Forex Factory (Economic Calendar)",
          tags: ["macro", "economic-calendar", "forward"],
          enabled: true,
          stale_hours: 24,
        },
      ],
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].age_hours, 0);
    assert.equal(rows[0].last_activity, "2026-04-04T10:05:01.602Z");
    assert.equal(rows[0].last_published, "2026-04-04T16:00:00.000Z");
    assert.equal(rows[0].last_ts, "2026-04-04T10:05:01.602Z");
  } finally {
    Date.now = now;
  }
});

test("updateHealthState persists normalized last_seen for forward-looking feeds", () => {
  const now = Date.now;
  Date.now = () => Date.parse("2026-04-04T10:05:01.602Z");

  try {
    const rows = summarizeInbox(
      [
        {
          source_id: "economic-calendar",
          ts: "2026-04-04T10:05:01.602Z",
          published: "2026-04-04T16:00:00.000Z",
        },
      ],
      [
        {
          id: "economic-calendar",
          label: "Forex Factory (Economic Calendar)",
          tags: ["macro", "economic-calendar", "forward"],
          enabled: true,
          stale_hours: 24,
        },
      ],
    );

    const state = updateHealthState(rows, { last_checked: null, sources: {} });

    assert.equal(
      state.sources["economic-calendar"].last_seen,
      "2026-04-04T10:05:01.602Z",
    );
    assert.equal(
      state.sources["economic-calendar"].last_published,
      "2026-04-04T16:00:00.000Z",
    );
  } finally {
    Date.now = now;
  }
});
