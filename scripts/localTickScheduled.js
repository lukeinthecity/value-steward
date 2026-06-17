// Load .env first — cron runs with a minimal environment, so scheduler-level
// vars like VS_SCHEDULE_LOG_SKIPS / VS_EXECUTION_SLOT_MINUTES_BEFORE_CLOSE
// would otherwise be unset and silently use defaults.
import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import {
  isTradingDay,
  isWithinMinutesBeforeCloseSlots,
  minutesUntilClose,
} from "../core/timeUtils.js";

export function parseExecutionSlots(
  value = process.env.VS_EXECUTION_SLOT_MINUTES_BEFORE_CLOSE,
  fallback = [30, 20, 10, 5]
) {
  if (!value) return fallback;
  const parsed = String(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part >= 0);
  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => b - a) : fallback;
}

function shouldLogSkip() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.VS_SCHEDULE_LOG_SKIPS ?? "false").toLowerCase()
  );
}

export function shouldRunScheduledLocalTick({
  now = new Date(),
  force = false,
  slots = parseExecutionSlots(),
} = {}) {
  if (force) {
    return { run: true, reason: "forced", minutesUntilClose: minutesUntilClose(now) };
  }
  if (!isTradingDay(now)) {
    return { run: false, reason: "non_trading_day", minutesUntilClose: null };
  }
  const minutes = minutesUntilClose(now);
  if (!isWithinMinutesBeforeCloseSlots(slots, now)) {
    return { run: false, reason: "not_execution_slot", minutesUntilClose: minutes };
  }
  return { run: true, reason: "execution_slot", minutesUntilClose: minutes };
}

function runCommand(label, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      resolve({ label, ok: code === 0, code });
    });
    child.on("error", (err) => {
      console.error(`[tick:schedule] ${label} failed:`, err?.message ?? err);
      resolve({ label, ok: false, code: 1 });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--force");
  const decision = shouldRunScheduledLocalTick({
    now: new Date(),
    force,
  });

  if (!decision.run) {
    if (shouldLogSkip()) {
      console.log(
        `[tick:schedule] Skipping (${decision.reason}) minutesUntilClose=${
          decision.minutesUntilClose ?? "n/a"
        }.`
      );
    }
    process.exit(0);
  }

  const result = await runCommand("local:tick", "npm", ["run", "local:tick"]);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[tick:schedule] failed:", err?.message ?? err);
    process.exit(1);
  });
}
