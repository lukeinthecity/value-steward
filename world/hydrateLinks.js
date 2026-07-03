// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

import { appendJsonlLineSync } from "../core/runtimeArtifacts.js";
import { startSpinner } from "./spinner.js";

const INBOX_PATH = path.join(process.cwd(), "data", "world-inbox.jsonl");
const HYDRATED_PATH = path.join(process.cwd(), "data", "world-hydrated.jsonl");

const WORLD_HYDRATE_MAX = Number(process.env.WORLD_HYDRATE_MAX ?? 20);
const WORLD_HYDRATE_SLEEP_MS = Number(
  process.env.WORLD_HYDRATE_SLEEP_MS ?? 1500,
);
const WORLD_HYDRATE_TIMEOUT_MS = Number(
  process.env.WORLD_HYDRATE_TIMEOUT_MS ?? 15000,
);
const WORLD_HYDRATE_MAX_CHARS = Number(
  process.env.WORLD_HYDRATE_MAX_CHARS ?? 15000,
);

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendJsonl(filePath, entry) {
  appendJsonlLineSync(filePath, entry);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildKey(entry) {
  if (entry.link) return `${entry.source_id}|${entry.link}`;
  return `${entry.source_id}|${entry.title}|${entry.published}`;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function fallbackExtract(document) {
  const selectors = ["article", "main", "body"];
  const clone = document.cloneNode(true);
  const remove = clone.querySelectorAll(
    "script,style,nav,header,footer,aside,form,svg,canvas",
  );
  remove.forEach((node) => node.remove());

  for (const selector of selectors) {
    const node = clone.querySelector(selector);
    if (node) {
      return normalizeWhitespace(node.textContent || "");
    }
  }
  return normalizeWhitespace(clone.body?.textContent || "");
}

function buildInlineHydration(entry, baseRecord) {
  const rawText = entry.content_text ?? entry.summary ?? null;
  if (!rawText) return null;
  const truncated = rawText.slice(0, WORLD_HYDRATE_MAX_CHARS);
  const hash = crypto.createHash("sha256").update(truncated).digest("hex");
  return {
    ...baseRecord,
    ok: true,
    status: "inline",
    content_type: "text/plain",
    extractor: "inline",
    content_text: truncated,
    content_chars: truncated.length,
    content_hash: hash,
    error: null,
  };
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WORLD_HYDRATE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function hydrateEntry(entry) {
  const ts = new Date().toISOString();
  const baseRecord = {
    ts,
    source_id: entry.source_id,
    title: entry.title ?? "",
    link: entry.link ?? null,
    published: entry.published ?? null,
    ok: false,
    status: null,
    content_type: null,
    canonical_url: null,
    extractor: null,
    title_extracted: null,
    content_text: null,
    content_chars: 0,
    content_hash: null,
    error: null,
  };

  if (!entry.link) {
    const inline = buildInlineHydration(entry, baseRecord);
    if (inline) return inline;
    return { ...baseRecord, error: "no_link" };
  }

  let res;
  try {
    res = await fetchWithTimeout(entry.link);
  } catch (err) {
    return { ...baseRecord, error: "timeout" };
  }

  const contentType = res.headers.get("content-type") || "";
  const status = res.status;

  if (!res.ok) {
    return {
      ...baseRecord,
      status,
      content_type: contentType,
      error: `http_${status}`,
    };
  }

  if (!contentType.includes("text/html")) {
    return {
      ...baseRecord,
      status,
      content_type: contentType,
      error: "non_html",
    };
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return {
      ...baseRecord,
      status,
      content_type: contentType,
      error: "read_failed",
    };
  }

  let extracted = null;
  let extractor = null;
  let titleExtracted = null;

  try {
    const dom = new JSDOM(html, { url: res.url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article?.textContent) {
      extracted = normalizeWhitespace(article.textContent);
      extractor = "readability";
      titleExtracted = article.title || null;
    }

    if (!extracted) {
      extracted = fallbackExtract(dom.window.document);
      extractor = "fallback";
    }
  } catch (err) {
    return {
      ...baseRecord,
      status,
      content_type: contentType,
      error: "parse_failed",
    };
  }

  if (!extracted || extracted.length < 200) {
    return {
      ...baseRecord,
      status,
      content_type: contentType,
      canonical_url: res.url,
      extractor,
      title_extracted: titleExtracted,
      error: "content_too_short",
    };
  }

  const truncated = extracted.slice(0, WORLD_HYDRATE_MAX_CHARS);
  const hash = crypto.createHash("sha256").update(truncated).digest("hex");

  return {
    ...baseRecord,
    ok: true,
    status,
    content_type: contentType,
    canonical_url: res.url,
    extractor,
    title_extracted: titleExtracted,
    content_text: truncated,
    content_chars: truncated.length,
    content_hash: hash,
    error: null,
  };
}

async function main() {
  const inbox = loadJsonl(INBOX_PATH);
  const hydrated = loadJsonl(HYDRATED_PATH);
  const hydratedKeys = new Set(hydrated.map(buildKey));

  const candidates = inbox.filter(
    (entry) => !hydratedKeys.has(buildKey(entry)),
  );
  const toProcess = candidates.slice(0, WORLD_HYDRATE_MAX);
  const stopSpinner = startSpinner("hydrate links", {
    total: toProcess.length,
  });

  let attempted = 0;
  let okCount = 0;
  let failCount = 0;

  for (const entry of toProcess) {
    attempted += 1;
    const record = await hydrateEntry(entry);
    appendJsonl(HYDRATED_PATH, record);
    if (record.ok) {
      okCount += 1;
    } else {
      failCount += 1;
    }
    stopSpinner.update(attempted);
    await sleep(WORLD_HYDRATE_SLEEP_MS);
  }

  stopSpinner(
    `attempted=${attempted} ok=${okCount} failed=${failCount} inbox=${inbox.length}`,
  );
  console.log(
    `[world] hydrate attempted=${attempted} ok=${okCount} failed=${failCount} inbox=${inbox.length}`,
  );
}

// Only run when executed directly (cron/CLI), never on import.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[world] hydrate failed:", err?.message ?? err);
    process.exit(1);
  });
}
