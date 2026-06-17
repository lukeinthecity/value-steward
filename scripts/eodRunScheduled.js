// Load .env first — cron runs with a minimal environment, so scheduler-level
// vars like VS_SCHEDULE_LOG_SKIPS would otherwise be unset.
import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import {
  getExchangeDateString,
  isTradingDay,
  isWithinPostCloseWindow,
} from "../core/timeUtils.js";
import { loadStateSync } from "../core/stewardState.js";

function shouldLogSkip() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.VS_SCHEDULE_LOG_SKIPS ?? "false").toLowerCase()
  );
}

export function shouldRunScheduledEod({
  now = new Date(),
  force = false,
  lastEodDate = null,
  postCloseStart = Number(
    process.env.VS_EOD_WINDOW_MINUTES_AFTER_CLOSE_START ?? 15
  ),
  postCloseEnd = Number(process.env.VS_EOD_WINDOW_MINUTES_AFTER_CLOSE_END ?? 90),
} = {}) {
  const today = getExchangeDateString(now);
  if (force) {
    return { run: true, reason: "forced", exchangeDate: today };
  }
  if (!isTradingDay(now)) {
    return { run: false, reason: "non_trading_day", exchangeDate: today };
  }
  if (lastEodDate === today) {
    return { run: false, reason: "already_sent", exchangeDate: today };
  }
  if (!isWithinPostCloseWindow(postCloseStart, postCloseEnd, now)) {
    return {
      run: false,
      reason: "outside_post_close_window",
      exchangeDate: today,
    };
  }
  return { run: true, reason: "window_open", exchangeDate: today };
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
      console.error(`[eod:schedule] ${label} failed:`, err?.message ?? err);
      resolve({ label, ok: false, code: 1 });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--force");
  const state = loadStateSync();
  const decision = shouldRunScheduledEod({
    now: new Date(),
    force,
    lastEodDate: state.last_eod_email_date ?? null,
  });

  if (!decision.run) {
    if (shouldLogSkip()) {
      console.log(`[eod:schedule] Skipping (${decision.reason}).`);
    }
    process.exit(0);
  }

  const result = await runCommand("eod:run", "npm", ["run", "eod:run"]);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[eod:schedule] failed:", err?.message ?? err);
    process.exit(1);
  });
}
