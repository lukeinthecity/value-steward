import { spawn } from "child_process";
import path from "path";

import { startSpinner } from "../world/spinner.js";
import { fileURLToPath } from "url";

async function main() {
  const stopSpinner = startSpinner("desktop app", { total: 1 });
  stopSpinner.update(1);
  stopSpinner("launch");

  const desktopDir = path.join(process.cwd(), "desktop");
  const child = spawn("npm", ["start"], {
    cwd: desktopDir,
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[desktop] Failed to launch:", err?.message ?? err);
    process.exit(1);
  });
}
