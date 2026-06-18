// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import Parser from "rss-parser";

import { readJson, readJsonl, writeJsonlAtomic } from "../core/runtimeArtifacts.js";
import { startSpinner } from "./spinner.js";

const FEEDS_PATH = path.join(process.cwd(), "world", "feeds.json");
const INBOX_PATH = path.join(process.cwd(), "data", "world-inbox.jsonl");
const RETAIN_DAYS = 7;
const WORLD_RSS_TIMEOUT_MS = Number(process.env.WORLD_RSS_TIMEOUT_MS ?? 15000);

function parseCalendarDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function buildCalendarSummary({ title, impact, forecast, previous, actual }) {
  const parts = [];
  if (impact) parts.push(`impact=${impact}`);
  if (forecast) parts.push(`forecast=${forecast}`);
  if (previous) parts.push(`previous=${previous}`);
  if (actual) parts.push(`actual=${actual}`);
  if (!parts.length) return title || null;
  return `${title} (${parts.join(", ")})`;
}

function loadFeeds() {
  // Guarded read: a missing or corrupt feeds.json must not crash the whole
  // fetch (which would silently halt all world ingestion). Degrade to an
  // empty source list with a loud log instead.
  const feeds = readJson(FEEDS_PATH);
  if (!feeds || typeof feeds !== "object") {
    console.error(
      `[world] feeds.json missing or unreadable at ${FEEDS_PATH}; no sources fetched this run.`
    );
    return { sources: [] };
  }
  return feeds;
}

function loadInbox() {
  // Guarded per-line read: one corrupt/truncated line (e.g. an interrupted
  // write) must not crash the fetch — readJsonl skips bad lines.
  return readJsonl(INBOX_PATH);
}

function saveInbox(entries) {
  // Atomic write (tmp -> rename) so a kill mid-write can't leave a truncated
  // inbox that the next run would choke on.
  writeJsonlAtomic(INBOX_PATH, entries);
}

function buildKey(entry) {
  if (entry.link) return `${entry.source_id}|${entry.link}`;
  return `${entry.source_id}|${entry.title}|${entry.published}`;
}

function isPaywalled({ sourceId, item }) {
  if (!sourceId) return false;
  const source = sourceId.toLowerCase();
  if (!source.includes("yahoo")) return false;

  const title = item.title ?? "";
  const link = item.link ?? "";
  const titleLower = title.toLowerCase();
  const linkLower = link.toLowerCase();
  const premiumPattern = /\[\s*\$\$\s*\]/;

  return (
    premiumPattern.test(title) ||
    titleLower.includes("premium") ||
    linkLower.includes("/premium") ||
    linkLower.includes("premium")
  );
}

function normalizeItem({ sourceId, item }) {
  return {
    ts: new Date().toISOString(),
    source_id: sourceId,
    title: item.title ?? "",
    link: item.link ?? null,
    published: item.isoDate ?? item.pubDate ?? null,
    summary: item.contentSnippet ?? item.content ?? null,
    content_text: null,
  };
}

function normalizeCalendarItem({ sourceId, item }) {
  const rawTitle = item.title ?? item.event ?? "";
  const country = item.country ?? item.currency ?? "";
  const title = [country, rawTitle].filter(Boolean).join(" ").trim();
  const published = parseCalendarDate(
    item.date ?? item.datetime ?? item.time ?? item.timestamp
  );
  const summary = buildCalendarSummary({
    title: title || rawTitle || "calendar event",
    impact: item.impact ?? item.importance ?? null,
    forecast: item.forecast ?? null,
    previous: item.previous ?? null,
    actual: item.actual ?? null,
  });

  return {
    ts: new Date().toISOString(),
    source_id: sourceId,
    title: title || rawTitle || "calendar event",
    link: null,
    published,
    summary,
    content_text: summary,
  };
}

function pruneOld(entries) {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoff;
  });
}

async function fetchTextWithTimeout(url, { timeoutMs, headers }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers,
    });
    if (!res.ok) {
      throw new Error(`http_${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const feeds = loadFeeds();
  const enabledSources = (feeds.sources ?? []).filter((source) => source.enabled);
  const stopSpinner = startSpinner("fetch rss", { total: enabledSources.length });
  const userAgent =
    process.env.WORLD_RSS_USER_AGENT?.trim() ||
    "ValueSteward/1.0 (contact: local)";
  const usesDefaultAgent = userAgent.includes("contact: local");
  const hasSecFeed = (feeds.sources ?? []).some(
    (source) => source.enabled && String(source.id || "").startsWith("sec")
  );
  if (usesDefaultAgent && hasSecFeed) {
    console.warn(
      "[world] SEC feeds may return 403 without a real contact in WORLD_RSS_USER_AGENT."
    );
  }
  const parser = new Parser();
  const existing = loadInbox();
  const existingKeys = new Set(existing.map(buildKey));

  let added = 0;
  let processed = 0;
  for (const source of feeds.sources ?? []) {
    if (!source.enabled) continue;
    console.log(`[world] fetch ${source.id}...`);
    try {
      if (source.format === "calendar_json") {
        const res = await fetch(source.rss_url, {
          headers: {
            "User-Agent": userAgent,
            Accept: "application/json, */*",
          },
        });
        if (!res.ok) throw new Error(`http_${res.status}`);
        const data = await res.json();
        const items = Array.isArray(data)
          ? data
          : Array.isArray(data?.events)
            ? data.events
            : Array.isArray(data?.items)
              ? data.items
              : [];
        for (const item of items) {
          const normalized = normalizeCalendarItem({
            sourceId: source.id,
            item,
          });
          const key = buildKey(normalized);
          if (existingKeys.has(key)) continue;
          existing.push(normalized);
          existingKeys.add(key);
          added += 1;
        }
      } else {
        const rawText = await fetchTextWithTimeout(source.rss_url, {
          timeoutMs: WORLD_RSS_TIMEOUT_MS,
          headers: {
            "User-Agent": userAgent,
            Accept: "application/rss+xml, application/xml, text/xml, */*",
          },
        });
        
        // Elite Quant: Clean raw XML before parsing to handle BOM or leading whitespace
        const cleanedText = rawText.trim();
        const feed = await parser.parseString(cleanedText);
        
        for (const item of feed.items ?? []) {
          if (isPaywalled({ sourceId: source.id, item })) continue;
          const normalized = normalizeItem({ sourceId: source.id, item });
          const key = buildKey(normalized);
          if (existingKeys.has(key)) continue;
          existing.push(normalized);
          existingKeys.add(key);
          added += 1;
        }
      }
    } catch (err) {
      console.error(`[world] fetch failed for ${source.id}:`, err?.message ?? err);
    } finally {
      processed += 1;
      stopSpinner.update(processed);
    }
  }

  const pruned = pruneOld(existing);
  saveInbox(pruned);

  stopSpinner(
    `sources=${feeds.sources?.length ?? 0} added=${added} kept=${pruned.length}`
  );
  console.log(
    `[world] fetched sources=${feeds.sources?.length ?? 0} added=${added} kept=${pruned.length}`
  );
}

// Only run when executed directly (cron/CLI), never on import. Importing this
// module for tests must not kick off a real fetch against the live data tree.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[world] fetch failed:", err?.message ?? err);
    process.exit(1);
  });
}
