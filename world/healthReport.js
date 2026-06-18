// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { startSpinner } from "./spinner.js";
import { readJson, writeJsonAtomic } from "../core/runtimeArtifacts.js";

const FEEDS_PATH = path.join(process.cwd(), "world", "feeds.json");
const INBOX_PATH = path.join(process.cwd(), "data", "world-inbox.jsonl");
const HYDRATED_PATH = path.join(process.cwd(), "data", "world-hydrated.jsonl");
const CONTEXT_PATH = path.join(process.cwd(), "data", "world-context.jsonl");
const STATE_PATH = path.join(process.cwd(), "data", "world-health.json");
const STALE_HOURS = Number(process.env.WORLD_FEED_STALE_HOURS ?? 72);
const STALE_MAX = Number(process.env.WORLD_FEED_STALE_MAX ?? 3);
const DYNAMIC_STALE =
  String(process.env.WORLD_FEED_DYNAMIC_STALE ?? "true").toLowerCase() ===
  "true";
const DYNAMIC_WINDOW = Number(process.env.WORLD_FEED_DYNAMIC_WINDOW ?? 12);
const DYNAMIC_MULTIPLIER = Number(
  process.env.WORLD_FEED_DYNAMIC_MULTIPLIER ?? 3
);
const DYNAMIC_MIN_HOURS = Number(process.env.WORLD_FEED_DYNAMIC_MIN_HOURS ?? 6);
const DYNAMIC_MAX_HOURS = Number(
  process.env.WORLD_FEED_DYNAMIC_MAX_HOURS ?? 720
);
const AUTO_DISABLE =
  String(process.env.WORLD_FEED_AUTO_DISABLE ?? "true").toLowerCase() === "true";

const execAsync = promisify(exec);

function loadJson(filePath) {
  // Guarded: a corrupt feeds.json/state file returns null (handled by callers)
  // instead of throwing and aborting the whole health run.
  return readJson(filePath);
}

function loadJsonl(filePath) {
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

function sortByTimestamp(a, b, key) {
  const at = Date.parse(a?.[key] ?? 0);
  const bt = Date.parse(b?.[key] ?? 0);
  return at - bt;
}

function getAgeHours(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, (Date.now() - ts) / (1000 * 60 * 60));
}

export function getFreshnessTimestampForSource(source, data) {
  const tags = Array.isArray(source?.tags) ? source.tags : [];
  const isForwardLooking = tags.includes("forward");
  if (isForwardLooking) {
    return data?.last_ts ?? data?.last_published ?? null;
  }
  const publishedTs = data?.last_published ?? null;
  if (publishedTs) {
    const publishedMs = Date.parse(publishedTs);
    if (!Number.isNaN(publishedMs) && publishedMs <= Date.now()) {
      return publishedTs;
    }
  }
  return data?.last_ts ?? publishedTs ?? null;
}

export function summarizeInbox(entries, sources) {
  const bySource = new Map();
  for (const entry of entries) {
    const sourceId = entry.source_id ?? "unknown";
    const current = bySource.get(sourceId) || {
      count: 0,
      last_ts: null,
      last_published: null,
      published_list: [],
    };
    current.count += 1;
    if (!current.last_ts || Date.parse(entry.ts) > Date.parse(current.last_ts)) {
      current.last_ts = entry.ts ?? current.last_ts;
    }
    if (
      entry.published &&
      (!current.last_published ||
        Date.parse(entry.published) > Date.parse(current.last_published))
    ) {
      current.last_published = entry.published;
    }
    const published = entry.published ?? entry.ts ?? null;
    if (published) {
      current.published_list.push(published);
    }
    bySource.set(sourceId, current);
  }

  const rows = [];
  for (const source of sources) {
    const data = bySource.get(source.id);
    const lastActivity = getFreshnessTimestampForSource(source, data);
    const ageHours = getAgeHours(lastActivity);
    const thresholdHours =
      typeof source.stale_hours === "number" ? source.stale_hours : STALE_HOURS;
    const dynamicThreshold = DYNAMIC_STALE
      ? computeDynamicThreshold(data?.published_list ?? [])
      : null;
    let effectiveThreshold = thresholdHours;
    if (typeof dynamicThreshold === "number") {
      const dynamicClamped = clamp(
        dynamicThreshold,
        DYNAMIC_MIN_HOURS,
        DYNAMIC_MAX_HOURS
      );
      effectiveThreshold = Math.max(thresholdHours, dynamicClamped);
    }
    const stale =
      source.enabled !== false &&
      (ageHours === null ? true : ageHours > effectiveThreshold);
    rows.push({
      id: source.id,
      label: source.label,
      enabled: source.enabled !== false,
      count: data?.count ?? 0,
      last_activity: lastActivity,
      last_ts: data?.last_ts ?? null,
      last_published: data?.last_published ?? null,
      age_hours: ageHours,
      stale,
      threshold_hours: effectiveThreshold,
      threshold_dynamic: dynamicThreshold,
    });
  }

  return rows;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function computeDynamicThreshold(publishedList) {
  if (!publishedList || publishedList.length < 4) return null;
  const timestamps = publishedList
    .map((value) => Date.parse(value))
    .filter((ts) => !Number.isNaN(ts))
    .sort((a, b) => a - b);
  if (timestamps.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const gapHours = (timestamps[i] - timestamps[i - 1]) / (1000 * 60 * 60);
    if (gapHours > 0) gaps.push(gapHours);
  }
  if (gaps.length < 2) return null;
  const recent = gaps.slice(-DYNAMIC_WINDOW);
  recent.sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  const median =
    recent.length % 2 === 0
      ? (recent[mid - 1] + recent[mid]) / 2
      : recent[mid];
  if (!Number.isFinite(median)) return null;
  return median * DYNAMIC_MULTIPLIER;
}

function summarizeHydration(entries) {
  const total = entries.length;
  const ok = entries.filter((entry) => entry.ok === true).length;
  const failed = entries.filter((entry) => entry.ok === false).length;
  const last = entries.slice().sort((a, b) => sortByTimestamp(a, b, "ts")).at(-1);
  return {
    total,
    ok,
    failed,
    last_ts: last?.ts ?? null,
  };
}

function summarizeContext(entries) {
  if (!entries.length) return null;
  const sorted = entries
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
      return sortByTimestamp(a, b, "generated_at");
    });
  const latest = sorted.at(-1);
  const bySlot = new Map();
  for (const entry of sorted) {
    const key = entry.slot ?? "unknown";
    const existing = bySlot.get(key);
    if (!existing || Date.parse(entry.generated_at) > Date.parse(existing.generated_at)) {
      bySlot.set(key, entry);
    }
  }
  return {
    latest,
    bySlot,
  };
}

function formatDate(value) {
  if (!value) return "n/a";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toISOString();
}

function formatAge(value) {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toFixed(1);
}

function shouldColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function color(text, code) {
  if (!shouldColor()) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function red(text) {
  return color(text, "31");
}

function yellow(text) {
  return color(text, "33");
}

function green(text) {
  return color(text, "32");
}

function bold(text) {
  return color(text, "1");
}

async function runWorldPipeline() {
  console.log("[world:health] Running world:run to refresh feeds...");
  const timeoutMs = Number(process.env.WORLD_RUN_TIMEOUT_MS ?? 120000);
  const stopSpinner = startSpinner("world:run", { total: 1 });
  try {
    await execAsync("npm run world:run", {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    stopSpinner.update(1);
    stopSpinner("complete");
  } catch (err) {
    stopSpinner.update(1);
    stopSpinner("failed");
    throw err;
  }
}

function loadState() {
  const feeds = loadJson(FEEDS_PATH);
  const inbox = loadJsonl(INBOX_PATH);
  const hydrated = loadJsonl(HYDRATED_PATH);
  const context = loadJsonl(CONTEXT_PATH);
  const health =
    loadJson(STATE_PATH) ?? { last_checked: null, sources: {} };
  return { feeds, inbox, hydrated, context, health };
}

function saveHealthState(state) {
  // Atomic write so an interrupted run can't corrupt the health state file.
  writeJsonAtomic(STATE_PATH, state);
}

export function updateHealthState(summary, health) {
  const next = health ?? { last_checked: null, sources: {} };
  next.sources = next.sources ?? {};
  const now = new Date().toISOString();

  const summaryIds = new Set(summary.map((row) => row.id));
  for (const key of Object.keys(next.sources)) {
    if (!summaryIds.has(key)) {
      delete next.sources[key];
    }
  }

  for (const row of summary) {
    const entry = next.sources[row.id] || {
      stale_streak: 0,
      last_checked: null,
      last_seen: null,
      last_published: null,
      last_age_hours: null,
    };
    entry.stale_streak = row.stale ? (entry.stale_streak ?? 0) + 1 : 0;
    entry.last_checked = now;
    entry.last_seen = row.last_activity ?? null;
    entry.last_published = row.last_published ?? null;
    entry.last_age_hours = row.age_hours ?? null;
    next.sources[row.id] = entry;
  }

  next.last_checked = now;
  return next;
}

function autoDisableFeeds(feeds, summary, health) {
  if (!AUTO_DISABLE) {
    return { feeds, changed: false, disabled: [] };
  }
  const disabled = [];
  let changed = false;
  const sources = feeds.sources ?? [];
  const byId = new Map(summary.map((row) => [row.id, row]));
  for (const source of sources) {
    if (source.enabled === false) continue;
    const row = byId.get(source.id);
    if (!row || !row.stale) continue;
    const streak = health.sources?.[source.id]?.stale_streak ?? 0;
    const maxStale =
      typeof source.stale_max === "number" ? source.stale_max : STALE_MAX;
    if (streak >= maxStale) {
      source.enabled = false;
      source.disabled_reason = "auto_stale";
      source.disabled_at = new Date().toISOString();
      disabled.push(source.id);
      changed = true;
    }
  }
  if (changed) {
    feeds.updatedAt = new Date().toISOString();
    // Atomic write: feeds.json is the source of truth fetchRss reads every
    // run; a torn write here would crash ingestion on the next fetch.
    writeJsonAtomic(FEEDS_PATH, feeds);
  }
  return { feeds, changed, disabled };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const refresh = args.has("--refresh");
  const refreshIfStale = args.has("--refresh-if-stale");

  let { feeds, inbox, hydrated, context, health } = loadState();

  if (!feeds) {
    console.log("[world:health] Missing feeds.json");
    process.exit(1);
  }

  let inboxSummary = summarizeInbox(inbox, feeds.sources ?? []);
  let staleSources = inboxSummary.filter((row) => row.stale);

  if (refresh || (refreshIfStale && staleSources.length > 0)) {
    await runWorldPipeline();
    ({ feeds, inbox, hydrated, context, health } = loadState());
    inboxSummary = summarizeInbox(inbox, feeds.sources ?? []);
    staleSources = inboxSummary.filter((row) => row.stale);
  }

  const reportSpinner = startSpinner("world health", { total: 1 });
  health = updateHealthState(inboxSummary, health);
  const disableResult = autoDisableFeeds(feeds, inboxSummary, health);
  if (disableResult.changed) {
    inboxSummary = summarizeInbox(inbox, disableResult.feeds.sources ?? []);
    staleSources = inboxSummary.filter((row) => row.stale);
    console.log(
      `[world:health] auto-disabled feeds: ${disableResult.disabled.join(", ")}`
    );
  }
  saveHealthState(health);
  reportSpinner.update(1);
  reportSpinner("report ready");

  console.log("[world:health] Feed health report");
  console.log(`- feeds: ${feeds.sources?.length ?? 0}`);
  console.log(`- inbox entries: ${inbox.length}`);
  console.log(`- hydrated entries: ${hydrated.length}`);
  console.log(`- context entries: ${context.length}`);
  console.log(`- stale threshold: ${STALE_HOURS}h`);
  console.log(`- stale max: ${STALE_MAX}`);
  console.log(`- auto-disable: ${AUTO_DISABLE}`);
  console.log(`- stale sources: ${staleSources.length}`);
  console.log("");

  console.log("[world:health] Inbox by source");
  inboxSummary.forEach((row) => {
    const state = health.sources?.[row.id];
    const streak = state?.stale_streak ?? 0;
    const status = row.stale
      ? red(bold("STALE"))
      : row.enabled
        ? green("OK")
        : yellow("DISABLED");
    console.log(
      `- ${row.id} (${row.label}): ${status} count=${row.count} last_ts=${formatDate(
        row.last_ts
      )} last_published=${formatDate(row.last_published)} age_h=${formatAge(
        row.age_hours
      )} threshold_h=${formatAge(row.threshold_hours)} streak=${streak} enabled=${row.enabled}`
    );
  });

  console.log("");
  const hydration = summarizeHydration(hydrated);
  console.log("[world:health] Hydration");
  console.log(
    `- total=${hydration.total} ok=${hydration.ok} failed=${hydration.failed} last_ts=${formatDate(
      hydration.last_ts
    )}`
  );

  console.log("");
  const contextSummary = summarizeContext(context);
  if (!contextSummary) {
    console.log("[world:health] No world context entries yet.");
    return;
  }
  console.log("[world:health] Latest context");
  console.log(
    `- date=${contextSummary.latest?.date ?? "n/a"} slot=${
      contextSummary.latest?.slot ?? "n/a"
    } generated_at=${formatDate(contextSummary.latest?.generated_at)}`
  );
  console.log(
    `- sources_used=${contextSummary.latest?.sources_used?.length ?? 0} raw_count=${
      contextSummary.latest?.raw_count ?? 0
    }`
  );

  console.log("");
  console.log("[world:health] Latest context by slot");
  for (const [slot, entry] of contextSummary.bySlot.entries()) {
    console.log(
      `- ${slot}: date=${entry.date ?? "n/a"} generated_at=${formatDate(
        entry.generated_at
      )} sources_used=${entry.sources_used?.length ?? 0} raw_count=${
        entry.raw_count ?? 0
      }`
    );
  }
}

// Only run when executed directly (cron/CLI), never on import. Importing this
// module for tests must not run a real health report against the live data
// tree (which would rewrite world-health.json and could auto-disable feeds).
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[world:health] Error:", err?.message ?? err);
    process.exit(1);
  });
}
