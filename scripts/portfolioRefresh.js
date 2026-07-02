// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { buildArtifactCycleId } from "../core/runtimeArtifacts.js";
import { getExchangeDateString } from "../core/timeUtils.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import { startSpinner } from "../world/spinner.js";
import { fileURLToPath } from "url";

function resolvePythonCommand() {
  const explicit = (process.env.VS_PYTHON || "").trim();
  if (explicit) return explicit;
  const venvPath = path.join(process.cwd(), ".venv", "bin", "python");
  if (fs.existsSync(venvPath)) return venvPath;
  return "python3";
}

async function main() {
  const stopSpinner = startSpinner("portfolio refresh", { total: 1 });
  const pythonCmd = resolvePythonCommand();
  const worldContext = await loadLatestWorldContext().catch(() => null);
  const cycleId =
    worldContext?.cycle_id ??
    buildArtifactCycleId({
      exchangeDate: getExchangeDateString(new Date()),
      worldContextGeneratedAt: worldContext?.generated_at ?? null,
      worldContextSlot: worldContext?.slot ?? null,
    });

  const child = spawn(
    pythonCmd,
    ["-m", "valuesteward.cli", "portfolio", "--out", "data/portfolio-live.json"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VS_ARTIFACT_CYCLE_ID: cycleId ?? "",
      },
      stdio: "inherit",
    }
  );

  child.on("close", (code) => {
    stopSpinner.update(1);
    stopSpinner(code === 0 ? "complete" : "failed");
    process.exit(code ?? 0);
  });
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[portfolio] refresh failed:", err?.message ?? err);
    process.exit(1);
  });
}
