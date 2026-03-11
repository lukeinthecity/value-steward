import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import { getExchangeDateString } from "../core/timeUtils.js";

const EOD_STATE_PATH = path.join(process.cwd(), "data", "eod-state.json");

function readState() {
  if (!fs.existsSync(EOD_STATE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(EOD_STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(payload) {
  fs.mkdirSync(path.dirname(EOD_STATE_PATH), { recursive: true });
  fs.writeFileSync(EOD_STATE_PATH, JSON.stringify(payload, null, 2));
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
      console.error(`[eod:schedule] ${label} failed:`, err?.message ?? err);
      resolve({ label, ok: false, code: 1 });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  const today = getExchangeDateString(new Date());
  const existing = readState();
  if (!force && existing?.last_eod_date === today) {
    console.log(`[eod:schedule] EOD already ran for ${today}; skipping.`);
    process.exit(0);
  }

  const result = await runCommand("eod:run", "npm", ["run", "eod:run"]);
  if (!result.ok) {
    process.exit(result.code ?? 1);
  }

  writeState({
    last_eod_date: today,
    last_run_at: new Date().toISOString(),
  });
}

main().catch((err) => {
  console.error("[eod:schedule] failed:", err?.message ?? err);
  process.exit(1);
});
