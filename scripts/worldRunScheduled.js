import { spawn } from "child_process";

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

async function main() {
  const args = process.argv.slice(2);
  const now = new Date();
  const windowOpen = parseNumber(
    process.env.VS_WORLD_WINDOW_MINUTES_BEFORE_OPEN,
    30
  );
  const windowClose = parseNumber(
    process.env.VS_WORLD_WINDOW_MINUTES_BEFORE_CLOSE,
    30
  );
  const slot = getSlot({ windowOpen, windowClose, now });

  if (!slot) {
    console.log("[world:schedule] Not in pre-open/close window; skipping.");
    process.exit(0);
  }

  const exchangeDate = getExchangeDateString(now);
  const latest = await loadLatestWorldContext().catch(() => null);
  const force = shouldForce(args);

  if (
    !force &&
    latest?.date === exchangeDate &&
    latest?.slot === slot &&
    latest?.generated_at
  ) {
    console.log(
      `[world:schedule] Latest context already generated for ${exchangeDate} (${slot}); skipping.`
    );
    process.exit(0);
  }

  console.log(`[world:schedule] Running world:run for ${slot}...`);
  const result = await runCommand("world:run", "npm", ["run", "world:run"]);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }
}

main().catch((err) => {
  console.error("[world:schedule] failed:", err?.message ?? err);
  process.exit(1);
});
