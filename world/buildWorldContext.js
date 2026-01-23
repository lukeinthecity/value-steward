import fs from "fs";
import path from "path";

import { makeMacroDigest } from "./makeMacroDigest.js";
import { filterRecent, validateContext } from "./contextUtils.js";

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

function todayDate() {
  return new Date().toISOString().slice(0, 10);
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
    const { context, digest } = await makeMacroDigest({
      stubContext,
      hydratedEntries: hydrated,
    });

    if (!validateContext(context)) {
      console.error("[world] context validation failed; falling back to stub");
      const fallback = {
        ...stubContext,
        notes: "stub world context (LLM validation failed)",
      };
      appendContext(fallback);
      console.log(
        `[world] context built date=${date} sources=${fallback.sources_used.length} raw=${fallback.raw_count} digest=stub`
      );
      return;
    }

    appendContext(context);
    console.log(
      `[world] context built date=${date} sources=${context.sources_used.length} raw=${context.raw_count} digest=${digest}`
    );
  } catch (err) {
    console.error("[world] macro digest error:", err?.message ?? err);
    const fallback = {
      ...stubContext,
      notes: "stub world context (LLM call failed)",
    };
    appendContext(fallback);
    console.log(
      `[world] context built date=${date} sources=${fallback.sources_used.length} raw=${fallback.raw_count} digest=stub`
    );
  }
}

main();
