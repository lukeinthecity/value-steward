// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { startSpinner } from "../world/spinner.js";

function resolvePythonCommand() {
  const explicit = (process.env.VS_PYTHON || "").trim();
  if (explicit) return explicit;
  const venvPath = path.join(process.cwd(), ".venv", "bin", "python");
  if (fs.existsSync(venvPath)) return venvPath;
  return "python3";
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
      console.error(`[phase1] ${label} failed:`, err?.message ?? err);
      resolve({ label, ok: false, code: 1 });
    });
  });
}

async function main() {
  const pythonCmd = resolvePythonCommand();
  const steps = [
    { label: "world:run", cmd: "npm", args: ["run", "world:run"] },
    {
      label: "learning:local:tick",
      cmd: "npm",
      args: ["run", "local:tick"],
    },
    {
      label: "execution:python:tick",
      cmd: pythonCmd,
      args: ["-m", "valuesteward.cli", "tick"],
    },
    {
      label: "scorecard:refresh",
      cmd: pythonCmd,
      args: ["-m", "valuesteward.cli", "scorecard"],
    },
    {
      label: "python:report",
      cmd: pythonCmd,
      args: ["-m", "valuesteward.cli", "report"],
    },
  ];

  const stopSpinner = startSpinner("phase1 runbook", { total: steps.length });
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const result = await runCommand(step.label, step.cmd, step.args);
    stopSpinner.update(i + 1);
    if (!result.ok) {
      stopSpinner("failed");
      process.exit(result.code ?? 1);
    }
  }
  stopSpinner("complete");
}

main().catch((err) => {
  console.error("[phase1] runbook failed:", err?.message ?? err);
  process.exit(1);
});
