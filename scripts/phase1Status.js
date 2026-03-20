import fs from "fs";
import path from "path";

import { filterPhase1Records, getPhase1StartDate } from "../core/phase1Window.js";
import { loadStateSync } from "../core/stewardState.js";

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return records;
}

function fmtPct(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtMaybe(value) {
  if (value === null || value === undefined) return "n/a";
  return String(value);
}

const scorecardPath = path.join(process.cwd(), "data", "signal-scorecard.jsonl");
const summaryPath = path.join(process.cwd(), "data", "scorecard-summary.json");

const state = loadStateSync();
const phase1StartDate = getPhase1StartDate({ state });
const scorecardRecords = filterPhase1Records(readJsonl(scorecardPath), { state });
const uniqueDays = new Set(
  scorecardRecords
    .map((record) => record.entry_date)
    .filter((date) => typeof date === "string" && date.length > 0)
);

let summary = null;
if (fs.existsSync(summaryPath)) {
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch {
    summary = null;
  }
}
if (phase1StartDate && summary?.phase1_start_date !== phase1StartDate) {
  summary = null;
}

console.log("[phase1] Progress");
console.log(`- phase1_start_date=${phase1StartDate ?? "n/a"}`);
console.log(`- scorecard_records=${scorecardRecords.length}`);
console.log(`- trading_days=${uniqueDays.size} / 60`);
if (summary?.generated_at) {
  console.log(`- summary_generated_at=${summary.generated_at}`);
}

if (!summary?.horizons || Object.keys(summary.horizons).length === 0) {
  console.log("- summary: missing (run: python -m valuesteward.cli scorecard)");
  process.exit(0);
}

console.log("- horizons:");
for (const [horizon, data] of Object.entries(summary.horizons)) {
  console.log(
    `  ${horizon}d samples=${fmtMaybe(data.samples)} avg_excess_benchmark=${fmtPct(
      data.avg_excess_benchmark
    )} avg_signed_return=${fmtPct(data.avg_signed_return)} no_action_avoid=${fmtPct(
      data.no_action_beats_benchmark_rate
    )} no_action_missed=${fmtPct(data.no_action_missed_rate)}`
  );
}
