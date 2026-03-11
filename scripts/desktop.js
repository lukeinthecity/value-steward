import { spawn } from "child_process";
import path from "path";

import { startSpinner } from "../world/spinner.js";

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

main().catch((err) => {
  console.error("[desktop] Failed to launch:", err?.message ?? err);
  process.exit(1);
});
