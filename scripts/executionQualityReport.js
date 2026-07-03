// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { runExecutionQualityReport } from "../core/executionQualityReport.js";

async function main() {
  const snapshot = runExecutionQualityReport();
  const rate =
    snapshot.fill_rate === null
      ? "n/a"
      : `${(snapshot.fill_rate * 100).toFixed(0)}%`;
  console.log(
    `[execution:quality] window=${snapshot.window_days}d ` +
      `attempts=${snapshot.attempts} fills=${snapshot.fills} (${rate})`,
  );
  for (const bucket of snapshot.by_score_bucket) {
    console.log(
      `[execution:quality]   ${bucket.bucket}: ${bucket.fills}/${bucket.attempts} filled`,
    );
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[execution:quality] failed:", err?.message ?? err);
    process.exit(1);
  });
}
