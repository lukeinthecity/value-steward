// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import {
  getGateCalibrationPath,
  runGateCalibration,
} from "../core/gateCalibration.js";

async function main() {
  const result = runGateCalibration();
  console.log(
    `[gate:calibration] ${result.gates.length} gates over ` +
      `${result.total_blocked} blocked rows → ${getGateCalibrationPath()}`,
  );
  for (const gate of result.gates) {
    console.log(
      `[gate:calibration]   ${gate.gate}: n=${gate.count} ` +
        `mean=${gate.mean_excess === null ? "n/a" : (gate.mean_excess * 100).toFixed(2) + "%"} ` +
        `t=${gate.t_stat === null ? "n/a" : gate.t_stat.toFixed(2)}` +
        `${gate.insufficient ? " (insufficient)" : ""}`,
    );
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[gate:calibration] failed:", err?.message ?? err);
    process.exit(1);
  });
}
