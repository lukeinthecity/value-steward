import test from "node:test";
import assert from "node:assert/strict";

import { buildObservation } from "../scripts/intradayObservation.js";
import {
  parseObservationTimes,
  shouldRunScheduledIntradayObservation,
} from "../scripts/intradayObservationScheduled.js";

test("parseObservationTimes uses configured valid HH:MM values", () => {
  assert.deepEqual(parseObservationTimes("10:00,11:30,13:30,15:00"), [
    "10:00",
    "11:30",
    "13:30",
    "15:00",
  ]);
});

test("scheduled intraday observation runs only on configured slots", () => {
  const run = shouldRunScheduledIntradayObservation({
    now: new Date("2026-04-06T14:00:00Z"), // 10:00 ET
    times: ["10:00", "11:30"],
    latest: null,
  });
  const skip = shouldRunScheduledIntradayObservation({
    now: new Date("2026-04-06T14:05:00Z"), // 10:05 ET
    times: ["10:00", "11:30"],
    latest: null,
  });

  assert.equal(run.run, true);
  assert.equal(run.reason, "observation_slot");
  assert.equal(skip.run, false);
  assert.equal(skip.reason, "not_observation_slot");
});

test("scheduled intraday observation dedupes same exchange time", () => {
  const decision = shouldRunScheduledIntradayObservation({
    now: new Date("2026-04-06T17:30:00Z"), // 13:30 ET
    times: ["13:30"],
    latest: {
      exchange_date: "2026-04-06",
      exchange_time: "13:30",
    },
  });

  assert.equal(decision.run, false);
  assert.equal(decision.reason, "already_recorded");
});

test("buildObservation uses fresh ranked signal snapshot candidates", () => {
  const observation = buildObservation({
    portfolio: {
      account: {
        equity: 100000,
        cash: 99980,
        buying_power: 199960,
      },
      snapshot: {
        position_count: 1,
      },
      positions: [
        {
          symbol: "ELCV",
          market_value: 19.81,
          quantity: 1,
        },
      ],
    },
    latestTick: {
      result: {
        grossExposure: 19.81,
      },
    },
    worldContext: {
      generated_at: "2026-04-29T19:00:00Z",
      macro_view: {
        macro_label: "calm",
        macro_score: 0.17,
      },
      final_regime: {
        final_label: "watchful",
        final_score: 0.38,
        divergence: true,
      },
    },
    signalSnapshot: {
      generated_at: "2026-04-29T17:30:00Z",
      candidates: [
        {
          timestamp: "2026-04-29T17:30:00Z",
          symbol: "AAA",
          signal_score: 1.8,
          signal_sector: "UTILITIES",
          execution_quality_score: 0.7,
          intraday_persistence_score: 0.6,
          realized_alpha_prior: 0.55,
        },
        {
          timestamp: "2026-04-29T17:30:00Z",
          symbol: "BBB",
          signal_score: 1.7,
          signal_sector: "ENERGY",
          execution_quality_score: 0.65,
          intraday_persistence_score: 0.58,
          realized_alpha_prior: 0.53,
        },
      ],
    },
    now: new Date("2026-04-29T17:30:00Z"),
  });

  assert.equal(observation.top_candidates.length, 2);
  assert.equal(observation.top_candidates[0].symbol, "AAA");
  assert.equal(observation.top_candidates[0].action_type, "CANDIDATE");
  assert.equal(observation.top_candidates[0].reason_code, "RANKED_SIGNAL");
  assert.equal(observation.top_candidates[0].signal_sector, "UTILITIES");
});
