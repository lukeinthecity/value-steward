import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const LOG_PATH = path.join(process.cwd(), "logs", "intent_log.jsonl");
const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fmt(value, fallback = "n/a") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function fmtScore(value) {
  if (value === null || value === undefined || Number.isNaN(value))
    return "n/a";
  return Number(value).toFixed(2);
}

function loadLatestWorldContext() {
  const entries = readJsonl(CONTEXT_PATH);
  if (!entries.length) return null;
  return entries
    .filter((entry) => entry.generated_at)
    .sort((a, b) => Date.parse(a.generated_at) - Date.parse(b.generated_at))
    .at(-1);
}

function summarize(intents) {
  const counters = {
    total: intents.length,
    world_context_stale: 0,
    buy_blocked: 0,
    sell_blocked: 0,
    risk_off: 0,
    macro_buy_blocked: 0,
    macro_sell_blocked: 0,
  };

  for (const intent of intents) {
    if (intent.reason_code === "WORLD_CONTEXT_STALE")
      counters.world_context_stale += 1;
    if (intent.reason_code === "BUY_BLOCKED") counters.buy_blocked += 1;
    if (intent.reason_code === "SELL_BLOCKED") counters.sell_blocked += 1;
    if (intent.risk_off === true) counters.risk_off += 1;
    if (intent.gate_macro_buy_allowed === false)
      counters.macro_buy_blocked += 1;
    if (intent.gate_macro_sell_allowed === false)
      counters.macro_sell_blocked += 1;
  }

  return counters;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const limitArg = Array.from(args)
    .find((arg) => arg.startsWith("--limit="))
    ?.split("=")[1];
  const limit = limitArg ? Number(limitArg) : 20;

  const intents = readJsonl(LOG_PATH);
  if (!intents.length) {
    console.log("[world:influence] No intent log entries found.");
    return;
  }

  const latest = loadLatestWorldContext();
  if (latest) {
    console.log("[world:influence] Latest world context");
    console.log(
      `- date=${fmt(latest.date)} slot=${fmt(latest.slot)} generated_at=${fmt(
        latest.generated_at,
      )} sources_used=${Array.isArray(latest.sources_used) ? latest.sources_used.length : "n/a"} raw_count=${fmt(
        latest.raw_count,
      )}`,
    );
  } else {
    console.log("[world:influence] No world context entries found.");
  }

  const slice = intents.slice(-limit);
  const stats = summarize(slice);

  console.log("\n[world:influence] Recent intents");
  console.log(
    `- total=${stats.total} world_context_stale=${stats.world_context_stale} ` +
      `macro_buy_blocked=${stats.macro_buy_blocked} macro_sell_blocked=${stats.macro_sell_blocked} ` +
      `risk_off=${stats.risk_off}`,
  );

  for (const intent of slice) {
    const gateReason = intent.gate_reason ?? intent.reason_code ?? "n/a";
    const macro = `${fmt(intent.world_macro_label)}:${fmtScore(
      intent.world_macro_score,
    )}`;
    console.log(
      `- ${fmt(intent.timestamp)} action=${fmt(intent.action_type)} ` +
        `reason=${gateReason} macro=${macro} ` +
        `world_ok=${fmt(intent.gate_world_context_fresh)} ` +
        `buy_ok=${fmt(intent.gate_macro_buy_allowed)} sell_ok=${fmt(
          intent.gate_macro_sell_allowed,
        )} risk_off=${fmt(intent.risk_off)}`,
    );
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main();
}
