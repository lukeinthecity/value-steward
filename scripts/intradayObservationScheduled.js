// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import {
  getExchangeDateString,
  getExchangeTimeParts,
  isTradingDay,
} from "../core/timeUtils.js";
import { readLatestJsonl } from "../core/runtimeArtifacts.js";

export function parseObservationTimes(
  value = process.env.VS_INTRADAY_OBSERVATION_TIMES,
  fallback = ["10:00", "11:30", "13:30", "15:00"],
) {
  if (!value) return fallback;
  const times = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^\d{1,2}:\d{2}$/.test(part));
  return times.length ? Array.from(new Set(times)) : fallback;
}

function toTimeKey(now = new Date()) {
  const parts = getExchangeTimeParts(now);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function shouldRunScheduledIntradayObservation({
  now = new Date(),
  force = false,
  latest = null,
  times = parseObservationTimes(),
} = {}) {
  const exchangeDate = getExchangeDateString(now);
  const timeKey = toTimeKey(now);

  if (force) {
    return { run: true, reason: "forced", exchangeDate, timeKey };
  }
  if (!isTradingDay(now)) {
    return { run: false, reason: "non_trading_day", exchangeDate, timeKey };
  }
  if (!times.includes(timeKey)) {
    return {
      run: false,
      reason: "not_observation_slot",
      exchangeDate,
      timeKey,
    };
  }
  if (
    latest?.exchange_date === exchangeDate &&
    latest?.exchange_time === timeKey
  ) {
    return { run: false, reason: "already_recorded", exchangeDate, timeKey };
  }
  return { run: true, reason: "observation_slot", exchangeDate, timeKey };
}

function runCommand(label, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve({ label, ok: code === 0, code }));
    child.on("error", (err) => {
      console.error(
        `[intraday:schedule] ${label} failed:`,
        err?.message ?? err,
      );
      resolve({ label, ok: false, code: 1 });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--force");
  const latest = readLatestJsonl(
    path.join(process.cwd(), "data", "intraday-observations.jsonl"),
  );
  const decision = shouldRunScheduledIntradayObservation({
    now: new Date(),
    force,
    latest,
  });

  if (!decision.run) {
    process.exit(0);
  }

  const result = await runCommand("intraday:observe", "npm", [
    "run",
    "intraday:observe",
  ]);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[intraday:schedule] failed:", err?.message ?? err);
    process.exit(1);
  });
}
