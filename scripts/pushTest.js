import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { sendPush } from "../core/pushNotifications.js";
import { startSpinner } from "../world/spinner.js";

async function main() {
  const stop = startSpinner("push test", { total: 1 });
  const res = await sendPush({
    label: "test",
    title: "Value Steward · push test",
    message: `Test push at ${new Date().toISOString()} — if you see this, ntfy is wired up.`,
    tags: ["white_check_mark"],
  });
  stop.update(1);

  if (res.skipped) {
    stop("skipped");
    console.log(
      "[push] Skipped — set VS_NTFY_TOPIC in .env and subscribe to that topic in the ntfy app.",
    );
    return;
  }
  if (res.ok) {
    stop("sent");
    console.log("[push] Test push sent — check your phone.");
    return;
  }
  stop("failed");
  console.error(`[push] Test push failed: ${res.error}`);
  process.exit(1);
}

// Only run when executed directly (cron/CLI), never on import.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[push] Test push failed:", err?.message ?? err);
    process.exit(1);
  });
}
