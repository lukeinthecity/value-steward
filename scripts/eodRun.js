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

function resolvePythonCommand() {
  const explicit = (process.env.VS_PYTHON || "").trim();
  if (explicit) return explicit;
  const venvPath = path.join(process.cwd(), ".venv", "bin", "python3");
  if (fs.existsSync(venvPath)) return venvPath;
  return "python3";
}

function runCommand(label, cmd, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...env, PYTHONPATH: "./src" },
      stdio: "inherit",
    });
    child.on("close", (code) => {
      resolve({ label, ok: code === 0, code });
    });
    child.on("error", (err) => {
      console.error(`[eod] ${label} failed:`, err?.message ?? err);
      resolve({ label, ok: false, code: 1 });
    });
  });
}

async function main() {
  // Trust the scheduler/cron for timing.
  const pythonCmd = resolvePythonCommand();
  const worldContext = await loadLatestWorldContext().catch(() => null);
  const cycleId =
    worldContext?.cycle_id ??
    buildArtifactCycleId({
      exchangeDate: getExchangeDateString(new Date()),
      worldContextGeneratedAt: worldContext?.generated_at ?? null,
      worldContextSlot: worldContext?.slot ?? null,
    });
  const steps = [
    {
      label: "final:portfolio:sync",
      cmd: "npm",
      args: ["run", "portfolio:refresh"],
      env: {
        ...process.env,
        VS_ARTIFACT_CYCLE_ID: cycleId ?? "",
      },
    },
    {
      label: "intent:reconcile",
      cmd: "node",
      args: ["scripts/intentReconcile.js"],
    },
    {
      label: "execution:quality",
      cmd: "node",
      args: ["scripts/executionQualityReport.js"],
    },
    {
      label: "scorecard:refresh",
      cmd: pythonCmd,
      args: ["-m", "valuesteward.cli", "scorecard"],
    },
    {
      label: "train:policy:scorecard",
      cmd: "node",
      args: ["scripts/trainPolicy.js", "--scorecard-only"],
    },
    {
      label: "patterns:refresh",
      cmd: pythonCmd,
      args: ["-m", "valuesteward.cli", "patterns"],
    },
    {
      label: "steward:insights:email",
      cmd: "node",
      args: ["scripts/eodEmail.js"],
    },
  ];

  const stopSpinner = startSpinner("eod runbook", { total: steps.length });
  let exitCode = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const result = await runCommand(step.label, step.cmd, step.args, step.env);
    stopSpinner.update(i + 1);
    if (!result.ok) {
      // Continue through failures so a broken early step never suppresses the
      // EOD email (the last step). Surface a non-zero exit at the end so a
      // genuine failure still trips the health alert.
      console.error(`[eod] step failed: ${step.label} (code=${result.code ?? 1})`);
      exitCode = result.code ?? 1;
    }
  }
  stopSpinner(exitCode === 0 ? "complete" : "completed with errors");
  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((err) => {
  console.error("[eod] runbook failed:", err?.message ?? err);
  process.exit(1);
});
