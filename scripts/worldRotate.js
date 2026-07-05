// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { runWorldArtifactRotation } from "../core/worldArtifactRotation.js";

async function main() {
  for (const result of runWorldArtifactRotation()) {
    const archived = result.archive ? ` → ${result.archive}` : "";
    console.log(
      `[world:rotate] ${result.file}: kept=${result.kept} trimmed=${result.trimmed}${archived}`
    );
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[world:rotate] failed:", err?.message ?? err);
    process.exit(1);
  });
}
