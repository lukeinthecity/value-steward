// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { runIntentReconciliation } from "../core/intentReconciliation.js";

async function main() {
  const result = runIntentReconciliation();
  console.log(
    `[intent:reconcile] appended=${result.appended} ` +
      `today: ${result.fills_today}/${result.attempts_today} filled ` +
      `(${result.outcomes_path})`,
  );
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[intent:reconcile] failed:", err?.message ?? err);
    process.exit(1);
  });
}
