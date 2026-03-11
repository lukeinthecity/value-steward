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

async function main() {
  const stopSpinner = startSpinner("typecheck python", { total: 1 });
  const pythonCmd = resolvePythonCommand();

  const child = spawn(pythonCmd, ["-m", "mypy", "src"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    stopSpinner.update(1);
    stopSpinner(code === 0 ? "complete" : "failed");
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[typecheck] python failed:", err?.message ?? err);
  process.exit(1);
});
