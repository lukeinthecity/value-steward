// world/buildWorldContext.js

import fs from "fs";
import path from "path";

import { makeMacroDigest } from "./makeMacroDigest.js";
import {
  filterRecent,
  validateContext,
  classifyMacroFromTags,
  summarizeMacroLine,
  toWorldDateString,
} from "./contextUtils.js";
import { scoreWorldTags } from "./ruleBasedTags.js";
import { computeSmoothedTags, SMOOTHING_DEFAULTS } from "./tagSmoothing.js";

const INBOX_PATH = path.join(process.cwd(), "data", "world-inbox.jsonl");
const HYDRATED_PATH = path.join(process.cwd(), "data", "world-hydrated.jsonl");
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

function loadHydrated() {
  if (!fs.existsSync(HYDRATED_PATH)) return [];
  const raw = fs.readFileSync(HYDRATED_PATH, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendContext(entry) {
  const line = JSON.stringify(entry);
  fs.appendFileSync(CONTEXT_PATH, line + "\n");
}

/**
 * Return YYYY-MM-DD in the configured "world" time zone.
 * This uses toWorldDateString so the calendar day matches the
 * trading locale (system TZ or WORLD_TIMEZONE override).
 */
function todayDate() {
  return toWorldDateString(new Date());
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

async function main() {
  const inbox = loadInbox();
  const hydrated = loadHydrated();
  const context = loadContext();
  const date = todayDate();

  if (context.some((entry) => entry.date === date)) {
    console.log("[world] context already exists for", date);
    return;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = filterRecent(inbox, cutoff);
  const hydratedRecent = filterRecent(hydrated, cutoff);
  const hydratedOk = hydratedRecent.filter((entry) => entry.ok === true);
  const hydratedFailed = hydratedRecent.filter((entry) => entry.ok === false);
  const stubContext = buildStubContext({ entries: recent, date });

  stubContext.hydration = {
    inbox_recent: recent.length,
    hydrated_recent_ok: hydratedOk.length,
    hydrated_recent_failed: hydratedFailed.length,
  };

  const corpusPreview = hydratedOk
    .filter((entry) => entry.content_text)
    .slice(0, 10)
    .map((entry) => ({
      source_id: entry.source_id,
      title: entry.title ?? null,
      link: entry.link ?? null,
      published: entry.published ?? null,
      extractor: entry.extractor ?? null,
      excerpt: entry.content_text.slice(0, 600),
    }));

  if (corpusPreview.length) {
    stubContext.corpus_preview = corpusPreview;
  }

  try {
    const { context: builtContext, digest } = await makeMacroDigest({
      stubContext,
      hydratedEntries: hydrated,
    });

    const { tags, debugNote } = scoreWorldTags({ hydratedEntries: hydrated });
    const baseNote = "rule-based world context (no LLM yet)";
    const tagsValid =
      tags &&
      Object.values(tags).every(
        (val) => val === null || (val >= 0 && val <= 1)
      );

    let contextToUse = builtContext;

    if (tagsValid) {
      const tagKeys = Object.keys(tags);
      const smoothedTags = computeSmoothedTags({
        history: context,
        latestRawTags: tags,
        tagKeys,
        ...SMOOTHING_DEFAULTS,
      });
      contextToUse.tags_raw = tags;
      contextToUse.tags = smoothedTags;
      contextToUse.notes = contextToUse.notes
        ? `${contextToUse.notes} | ${baseNote}: ${debugNote}`
        : `${baseNote}: ${debugNote}`;
    } else {
      contextToUse.notes = contextToUse.notes
        ? `${contextToUse.notes} | rule-v1 failed, tags left null`
        : "rule-v1 failed, tags left null";
    }

    if (!validateContext(contextToUse)) {
      console.error("[world] context validation failed; falling back to stub");
      const fallback = {
        ...stubContext,
        notes: "stub world context (LLM validation failed)",
      };
      appendContext(fallback);
      const logDate = fallback.date ?? date;
      console.log(
        `[world] context built date=${logDate} sources=${fallback.sources_used.length} raw=${fallback.raw_count} digest=stub`
      );
      return;
    }

    appendContext(contextToUse);

    const tagSummary = Object.entries(contextToUse.tags || {})
      .map(([key, value]) =>
        value === null ? `${key}=null` : `${key}=${value.toFixed(2)}`
      )
      .join(",");
    const tagsNote = tagSummary ? ` tags=${tagSummary}` : " tags=all null";

    const logDate = contextToUse.date ?? date;

    console.log(
      `[world] context built date=${logDate} sources=${contextToUse.sources_used.length} raw=${contextToUse.raw_count} digest=${digest}${tagsNote}`
    );
  } catch (err) {
    console.error("[world] macro digest error:", err?.message ?? err);
    const fallback = {
      ...stubContext,
      notes: "stub world context (LLM call failed)",
    };
    appendContext(fallback);
    const logDate = fallback.date ?? date;
    console.log(
      `[world] context built date=${logDate} sources=${fallback.sources_used.length} raw=${fallback.raw_count} digest=stub`
    );
  }
}

main();
