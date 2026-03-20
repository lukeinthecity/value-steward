import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { startSpinner } from "../world/spinner.js";

function resolvePythonCommand() {
  const explicit = (process.env.VS_PYTHON || "").trim();
  if (explicit) return explicit;
  const venvPath = path.join(process.cwd(), ".venv", "bin", "python3");
  if (fs.existsSync(venvPath)) return venvPath;
  return "python3";
}

function runCommand(label, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: "./src" },
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
  const steps = [
    { label: "final:portfolio:sync", cmd: "npm", args: ["run", "portfolio:refresh"] },
    {
      label: "scorecard:refresh",
      cmd: pythonCmd,
      args: ["-m", "valuesteward.cli", "scorecard"],
    },
    {
      label: "steward:insights:email",
      cmd: "node",
      args: ["scripts/eodEmail.js"],
    },
  ];

  const stopSpinner = startSpinner("eod runbook", { total: steps.length });
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const result = await runCommand(step.label, step.cmd, step.args);
    stopSpinner.update(i + 1);
    if (!result.ok) {
      console.error(`[eod] step failed: ${step.label}`);
      // Continue through failure for email if possible, or exit
      // We exit to ensure we fix the root cause.
      stopSpinner("failed");
      process.exit(result.code ?? 1);
    }
  }
  stopSpinner("complete");
}

main().catch((err) => {
  console.error("[eod] runbook failed:", err?.message ?? err);
  process.exit(1);
});
