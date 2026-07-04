// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { executePhaseReset, planPhaseReset } from "../core/phaseReset.js";

function parseArgs(argv) {
  const args = { execute: false, label: null, startDate: null, caps: {} };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--execute") args.execute = true;
    else if (argv[i] === "--label") args.label = argv[++i];
    else if (argv[i] === "--start-date") args.startDate = argv[++i];
    else if (argv[i] === "--cap") args.caps.cap = Number(argv[++i]);
    else if (argv[i] === "--max-trade") args.caps.maxTrade = Number(argv[++i]);
    else if (argv[i] === "--min-trade") args.caps.minTrade = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.label || !args.startDate) {
    console.error(
      "Usage: node scripts/phaseReset.js --label run3 --start-date 2026-07-06 " +
        "[--cap 2000] [--max-trade 500] [--min-trade 100] [--execute]",
    );
    process.exit(1);
  }

  if (!args.execute) {
    const plan = planPhaseReset({
      runLabel: args.label,
      startDate: args.startDate,
      capOverrides: args.caps,
    });
    console.log(
      `[phase:reset] DRY RUN for ${plan.run_label} (Day 1 = ${plan.start_date})`,
    );
    for (const move of plan.archives) {
      console.log(`[phase:reset]   would archive ${move.from} -> ${move.to}`);
    }
    console.log(
      `[phase:reset]   would reset learned policy blocks: ${plan.policy_reset}`,
    );
    if (Object.keys(plan.cap_overrides).length) {
      console.log(
        `[phase:reset]   would set caps: ${JSON.stringify(plan.cap_overrides)}`,
      );
    }
    console.log(
      `[phase:reset]   would patch state: ${JSON.stringify(plan.state_patch)}`,
    );
    console.log("[phase:reset] re-run with --execute to perform the reset");
    return;
  }

  const result = executePhaseReset({
    runLabel: args.label,
    startDate: args.startDate,
    capOverrides: args.caps,
  });
  console.log(
    `[phase:reset] ${result.reason_code}: archived ${result.archived.length} artifacts, ` +
      `policy_reset=${result.policy_reset}, Day 1 = ${result.start_date}`,
  );
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[phase:reset] failed:", err?.message ?? err);
    process.exit(1);
  });
}
