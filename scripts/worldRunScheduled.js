// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import {
  getExchangeDateString,
  isWithinPreCloseWindow,
  isWithinPreOpenWindow,
} from "../core/timeUtils.js";

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function shouldForce(args) {
  return args.includes("--force");
}

function getSlot({ windowOpen, windowClose, now }) {
  if (isWithinPreOpenWindow(windowOpen, now)) {
    return "pre_open";
  }
  if (isWithinPreCloseWindow(windowClose, now)) {
    return "pre_close";
  }
  return null;
}

export function shouldRunScheduledWorld({
  now = new Date(),
  force = false,
  latest = null,
  windowOpen = 30,
  windowClose = 30,
} = {}) {
  const slot = getSlot({ windowOpen, windowClose, now });
  const exchangeDate = getExchangeDateString(now);

  if (force) {
    return {
      run: true,
      reason: "forced",
      slot: slot ?? "forced",
      exchangeDate,
    };
  }

  if (!slot) {
    return {
      run: false,
      reason: "outside_window",
      slot: null,
      exchangeDate,
    };
  }

  if (
    latest?.date === exchangeDate &&
    latest?.slot === slot &&
    latest?.generated_at
  ) {
    return {
      run: false,
      reason: "already_generated",
      slot,
      exchangeDate,
    };
  }

  return {
    run: true,
    reason: "window_open",
    slot,
    exchangeDate,
  };
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
      console.error(`[world:schedule] ${label} failed:`, err?.message ?? err);
      resolve({ label, ok: false, code: 1 });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = argv;
  const now = new Date();
  const windowOpen = parseNumber(
    process.env.VS_WORLD_WINDOW_MINUTES_BEFORE_OPEN,
    30,
  );
  const windowClose = parseNumber(
    process.env.VS_WORLD_WINDOW_MINUTES_BEFORE_CLOSE,
    30,
  );
  const force = shouldForce(args);
  const latest = await loadLatestWorldContext().catch(() => null);
  const decision = shouldRunScheduledWorld({
    now,
    force,
    latest,
    windowOpen,
    windowClose,
  });

  if (!decision.run) {
    if (decision.reason === "already_generated") {
      console.log(
        `[world:schedule] Latest context already generated for ${decision.exchangeDate} (${decision.slot}); skipping.`,
      );
    } else {
      console.log("[world:schedule] Not in pre-open/close window; skipping.");
    }
    process.exit(0);
  }

  console.log(`[world:schedule] Running world:run for ${decision.slot}...`);
  const result = await runCommand("world:run", "npm", ["run", "world:run"]);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[world:schedule] failed:", err?.message ?? err);
    process.exit(1);
  });
}
