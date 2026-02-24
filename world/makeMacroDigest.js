import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

import { validateContext } from "./contextUtils.js";

const execAsync = promisify(exec);
const SCHEMA_PATH = path.join(process.cwd(), "world", "schema.worldContext.json");
const DEFAULT_TIMEOUT_MS = 15000;
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

function loadSchema() {
  const raw = fs.readFileSync(SCHEMA_PATH, "utf8");
  return JSON.parse(raw);
}

function filterRecent(entries) {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  return entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    return Number.isNaN(ts) ? false : ts >= cutoff;
  });
}

function buildHydratedDocs(entries) {
  return entries.map((entry) => ({
    ts: entry.ts,
    source_id: entry.source_id,
    title: entry.title,
    link: entry.link ?? null,
    published: entry.published ?? null,
    text: entry.content_text ?? null,
    summary: entry.summary ?? null,
  }));
}


export async function makeMacroDigest({ baseContext, hydratedEntries }) {
  const schema = loadSchema();
  const recent = filterRecent(hydratedEntries);
  const hydratedDocs = buildHydratedDocs(recent);

  const cmd = process.env.WORLD_LLM_CMD?.trim();
  if (!cmd) {
    return {
      context: null,
      digest: "rule",
    };
  }

  const prompt = {
    schema,
    base_context: baseContext,
    hydrated_docs: hydratedDocs,
  };

  const timeoutMs = Number(process.env.WORLD_LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  try {
    const { stdout } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      input: JSON.stringify(prompt),
    });

    const parsed = JSON.parse(stdout);

    if (parsed.date !== baseContext.date) {
      console.warn("[world] digest date mismatch; using rule-based context");
      return { context: null, digest: "rule" };
    }

    if (!validateContext(parsed)) {
      console.warn("[world] digest validation failed; using rule-based context");
      return { context: null, digest: "rule" };
    }

    return { context: parsed, digest: "LLM" };
  } catch (err) {
    const reason = err?.message ?? String(err);
    console.error("[world] LLM call failed:", reason);
    return { context: null, digest: "rule" };
  }
}
