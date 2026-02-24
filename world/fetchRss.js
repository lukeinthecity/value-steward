import fs from "fs";
import path from "path";
import Parser from "rss-parser";

import { startSpinner } from "./spinner.js";

const FEEDS_PATH = path.join(process.cwd(), "world", "feeds.json");
const INBOX_PATH = path.join(process.cwd(), "data", "world-inbox.jsonl");
const RETAIN_DAYS = 7;
const WORLD_RSS_TIMEOUT_MS = Number(process.env.WORLD_RSS_TIMEOUT_MS ?? 15000);

function loadFeeds() {
  const raw = fs.readFileSync(FEEDS_PATH, "utf8");
  return JSON.parse(raw);
}

function loadInbox() {
  if (!fs.existsSync(INBOX_PATH)) return [];
  const raw = fs.readFileSync(INBOX_PATH, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function saveInbox(entries) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  fs.writeFileSync(INBOX_PATH, lines.join("\n") + (lines.length ? "\n" : ""));
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

function pruneOld(entries) {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoff;
  });
}

async function main() {
  const stopSpinner = startSpinner("fetch rss");
  const feeds = loadFeeds();
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
  const parser = new Parser({
    headers: {
      "User-Agent": userAgent,
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  const existing = loadInbox();
  const existingKeys = new Set(existing.map(buildKey));

  let added = 0;
  for (const source of feeds.sources ?? []) {
    if (!source.enabled) continue;
    console.log(`[world] fetch ${source.id}...`);
    try {
      const feed = await Promise.race([
        parser.parseURL(source.rss_url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), WORLD_RSS_TIMEOUT_MS)
        ),
      ]);
      for (const item of feed.items ?? []) {
        if (isPaywalled({ sourceId: source.id, item })) continue;
        const normalized = normalizeItem({ sourceId: source.id, item });
        const key = buildKey(normalized);
        if (existingKeys.has(key)) continue;
        existing.push(normalized);
        existingKeys.add(key);
        added += 1;
      }
    } catch (err) {
      console.error(`[world] fetch failed for ${source.id}:`, err?.message ?? err);
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

main().catch((err) => {
  console.error("[world] fetch failed:", err?.message ?? err);
  process.exit(1);
});
