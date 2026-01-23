import fs from "fs";
import path from "path";

const INBOX_PATH = path.join(process.cwd(), "data", "world-inbox.jsonl");
const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");

function loadInbox() {
  if (!fs.existsSync(INBOX_PATH)) return [];
  const raw = fs.readFileSync(INBOX_PATH, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadContext() {
  if (!fs.existsSync(CONTEXT_PATH)) return [];
  const raw = fs.readFileSync(CONTEXT_PATH, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendContext(entry) {
  const line = JSON.stringify(entry);
  fs.appendFileSync(CONTEXT_PATH, line + "\n");
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function validateContext(entry) {
  if (!/\d{4}-\d{2}-\d{2}/.test(entry.date)) return false;
  if (!entry.generated_at) return false;
  if (!entry.tags) return false;
  const requiredTags = [
    "macro_risk",
    "rate_hawkishness",
    "geopolitical_tension",
    "energy_shock_risk",
    "recession_fear",
  ];
  for (const tag of requiredTags) {
    if (!(tag in entry.tags)) return false;
  }
  if (!Array.isArray(entry.sources_used)) return false;
  if (typeof entry.raw_count !== "number") return false;
  if (!Array.isArray(entry.errors)) return false;
  return true;
}

function buildStubContext({ entries, date }) {
  const sourcesUsed = Array.from(
    new Set(entries.map((entry) => entry.source_id).filter(Boolean))
  );

  return {
    date,
    generated_at: new Date().toISOString(),
    summary: null,
    tags: {
      macro_risk: null,
      rate_hawkishness: null,
      geopolitical_tension: null,
      energy_shock_risk: null,
      recession_fear: null,
    },
    sources_used: sourcesUsed,
    raw_count: entries.length,
    notes: "stub world context (LLM not integrated yet)",
    errors: [],
  };
}

function filterRecent(entries, cutoffMs) {
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoffMs;
  });
}

function main() {
  const inbox = loadInbox();
  const context = loadContext();
  const date = todayDate();

  if (context.some((entry) => entry.date === date)) {
    console.log("[world] context already exists for", date);
    return;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = filterRecent(inbox, cutoff);
  const worldContext = buildStubContext({ entries: recent, date });

  if (!validateContext(worldContext)) {
    throw new Error("world context validation failed");
  }

  appendContext(worldContext);
  console.log(
    `[world] context built date=${date} sources=${worldContext.sources_used.length} raw=${worldContext.raw_count}`
  );
}

main();
