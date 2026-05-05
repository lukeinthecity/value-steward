// world/buildWorldContext.js

import fs from "fs";
import path from "path";

import { makeMacroDigest } from "./makeMacroDigest.js";
import {
  filterRecent,
  validateContext,
  classifyMacroFromTags,
  fuseMacroRegime,
  toWorldDateString,
  getWorldTimeZone,
} from "./contextUtils.js";
import { buildArtifactCycleId } from "../core/runtimeArtifacts.js";
import { scoreWorldTags } from "./ruleBasedTags.js";
import { observeWorld } from "./shadowObserver.js";
import { computeSmoothedTags, SMOOTHING_DEFAULTS } from "./tagSmoothing.js";
import {
  fetchMassiveMacroContext,
  summarizeMassiveMacroContext,
} from "./massiveMacro.js";
import { startSpinner } from "./spinner.js";

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

function getWorldSlot(now = new Date()) {
  const tz = getWorldTimeZone();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const hour = Number(map.hour);
  if (Number.isNaN(hour)) return "unknown";
  if (hour < 12) return "pre_open";
  if (hour >= 15) return "pre_close";
  return "midday";
}

function buildBaseContext({ entries, date }) {
  const sourcesUsed = Array.from(
    new Set(entries.map((entry) => entry.source_id).filter(Boolean))
  );

  return {
    date,
    slot: getWorldSlot(),
    generated_at: new Date().toISOString(),
    cycle_id: null,
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
    notes: "rule-based world context (scripted)",
    errors: [],
  };
}

function cleanSummaryText(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/\s+/g, " ").trim();
  return cleaned.length ? cleaned : null;
}

function buildRuleSummary({ hydratedEntries, macroView }) {
  const entries = Array.isArray(hydratedEntries) ? hydratedEntries : [];
  const titles = entries
    .map(
      (entry) =>
        cleanSummaryText(entry.title) ||
        cleanSummaryText(entry.title_extracted) ||
        cleanSummaryText(entry.summary)
    )
    .filter(Boolean);

  const unique = Array.from(new Set(titles));
  if (!unique.length) return null;

  const top = unique.slice(0, 3);
  const hasMacroSignals = (macroView?.inputs_used ?? []).length > 0;
  const macroLabel = hasMacroSignals ? macroView?.macro_label ?? "n/a" : "n/a";
  const summary = `macro=${macroLabel} | headlines: ${top.join(" | ")}`;

  if (summary.length <= 400) return summary;
  return summary.slice(0, 397) + "...";
}

async function main() {
  const stopSpinner = startSpinner("build world context", { total: 1 });
  const inbox = loadInbox();
  const hydrated = loadHydrated();
  const context = loadContext();
  const date = todayDate();
  const slot = getWorldSlot();

  if (context.some((entry) => entry.date === date && entry.slot === slot)) {
    console.log("[world] context already exists for", date, "slot", slot, "- continuing to build higher-resolution entry.");
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = filterRecent(inbox, cutoff);
  const hydratedRecent = filterRecent(hydrated, cutoff);
  const hydratedOk = hydratedRecent.filter((entry) => entry.ok === true);
  const hydratedFailed = hydratedRecent.filter((entry) => entry.ok === false);
  const baseContext = buildBaseContext({ entries: recent, date });
  baseContext.slot = slot;

  baseContext.hydration = {
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
    baseContext.corpus_preview = corpusPreview;
  }

  const massiveMacro = await fetchMassiveMacroContext();
  baseContext.massive_macro = massiveMacro;
  baseContext.massive_macro_summary =
    summarizeMassiveMacroContext(massiveMacro);

  try {
    const { context: builtContext, digest } = await makeMacroDigest({
      baseContext,
      hydratedEntries: hydrated,
    });

    const { tags, debugNote } = scoreWorldTags({
      hydratedEntries: hydratedOk,
    });
    const baseNote = "rule-based world context (scripted)";
    const tagsValid =
      tags &&
      Object.values(tags).every(
        (val) => val === null || (val >= 0 && val <= 1)
      );

    let contextToUse = {
      ...baseContext,
      ...(builtContext ?? {}),
      tags: builtContext?.tags ?? baseContext.tags,
      summary: builtContext?.summary ?? baseContext.summary,
      massive_macro:
        builtContext?.massive_macro ?? baseContext.massive_macro ?? null,
      massive_macro_summary:
        builtContext?.massive_macro_summary ??
        baseContext.massive_macro_summary ??
        null,
    };

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
      contextToUse.tags = contextToUse.tags ?? baseContext.tags;
      contextToUse.notes = contextToUse.notes
        ? `${contextToUse.notes} | rule-v1 failed, tags left null`
        : "rule-v1 failed, tags left null";
    }

    const macroView = classifyMacroFromTags(contextToUse.tags);
    contextToUse.macro_view = macroView;
    if (!contextToUse.summary) {
      contextToUse.summary = buildRuleSummary({
        hydratedEntries: hydratedOk,
        macroView,
      });
    }

    // --- Phase 1.6: Shadow Observer (Scout) ---
    const scoutResult = await observeWorld({ baseContext: contextToUse });
    contextToUse = { ...contextToUse, ...scoutResult };
    // ------------------------------------------

    contextToUse.final_regime = fuseMacroRegime({
      macroView: contextToUse.macro_view,
      scoutLabel: contextToUse.scout_label,
      scoutScore: contextToUse.scout_score,
    });
    contextToUse.cycle_id = buildArtifactCycleId({
      exchangeDate: contextToUse.date ?? date,
      worldContextGeneratedAt: contextToUse.generated_at,
      worldContextSlot: slot,
    });

    if (!validateContext(contextToUse)) {
      console.error(
        "[world] context validation failed; using rule-based base context"
      );
      const fallback = {
        ...baseContext,
        scout_score: contextToUse.scout_score,
        scout_label: contextToUse.scout_label,
        scout_thesis: contextToUse.scout_thesis,
        final_regime: contextToUse.final_regime,
        massive_macro: contextToUse.massive_macro ?? baseContext.massive_macro,
        massive_macro_summary:
          contextToUse.massive_macro_summary ??
          baseContext.massive_macro_summary,
        notes: `rule-based world context (validation fallback) | scout: ${contextToUse.scout_label}`,
      };
      fallback.slot = slot;
      fallback.cycle_id = buildArtifactCycleId({
        exchangeDate: fallback.date ?? date,
        worldContextGeneratedAt: fallback.generated_at,
        worldContextSlot: slot,
      });
      if (!validateContext(fallback)) {
        console.error("[world] base context failed validation; aborting write");
        stopSpinner.update(1);
        stopSpinner("validation failed");
        return;
      }
      appendContext(fallback);
      const logDate = fallback.date ?? date;
      console.log(
        `[world] context built date=${logDate} sources=${fallback.sources_used.length} raw=${fallback.raw_count} digest=rule`
      );
      stopSpinner.update(1);
      stopSpinner(`saved ${logDate} ${slot}`);
      return;
    }

    contextToUse.slot = slot;
    appendContext(contextToUse);

    const tagSummary = Object.entries(contextToUse.tags || {})
      .map(([key, value]) =>
        value === null ? `${key}=null` : `${key}=${value.toFixed(2)}`
      )
      .join(",");
    const tagsNote = tagSummary ? ` tags=${tagSummary}` : " tags=all null";

    const logDate = contextToUse.date ?? date;

    console.log(
      `[world] context built date=${logDate} slot=${slot} sources=${contextToUse.sources_used.length} raw=${contextToUse.raw_count} digest=${digest}${tagsNote}`
    );
    stopSpinner.update(1);
    stopSpinner(`saved ${logDate} ${slot}`);
  } catch (err) {
    console.error("[world] macro digest error:", err?.message ?? err);
    const fallback = {
      ...baseContext,
      notes: "rule-based world context (digest error)",
    };
    fallback.slot = slot;
    fallback.cycle_id = buildArtifactCycleId({
      exchangeDate: fallback.date ?? date,
      worldContextGeneratedAt: fallback.generated_at,
      worldContextSlot: slot,
    });
    appendContext(fallback);
    const logDate = fallback.date ?? date;
    console.log(
      `[world] context built date=${logDate} slot=${slot} sources=${fallback.sources_used.length} raw=${fallback.raw_count} digest=rule`
    );
    stopSpinner.update(1);
    stopSpinner(`saved ${logDate} ${slot}`);
  }
}

main().catch((err) => {
  console.error("[world] Fatal build error:", err.message);
  process.exit(1);
});
