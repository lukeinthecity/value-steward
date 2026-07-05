/**
 * Retention rotation for the world RSS cache files.
 *
 * data/world-hydrated.jsonl grew unbounded (~39MB) while its consumers only
 * read recent windows: buildWorldContext uses a recency cutoff, and
 * hydrateLinks dedupes new inbox items against hydrated history. Rotation
 * trims entries older than the retention window, archiving them to
 * data/archive/ first — nothing is destroyed.
 *
 * Constraint: hydrated retention must be >= inbox retention, or an inbox
 * item could outlive its hydrated record and get re-fetched; enforced by a
 * clamp in runWorldArtifactRotation.
 *
 * Learning artifacts (scorecard, training log, intent logs, history) are
 * NEVER rotated — the trainers read their full Phase-1 history. A hard
 * allowlist refuses everything except the two fetch caches.
 */

import path from "path";

import {
  appendJsonlLineSync,
  readJsonl,
  writeJsonlAtomic,
} from "./runtimeArtifacts.js";

const ROTATABLE_FILES = new Set(["world-inbox.jsonl", "world-hydrated.jsonl"]);

const DEFAULT_INBOX_RETAIN_DAYS = 30;
const DEFAULT_HYDRATED_RETAIN_DAYS = 45;

function envInt(name, fallback) {
  const raw = (process.env[name] || "").trim();
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Pure split of entries into kept / trimmed by timestamp age. Entries whose
 * timestamp cannot be parsed are KEPT — never discard data we cannot date.
 */
export function rotateJsonlByAge(
  entries,
  { retainDays, now = new Date(), tsField = "ts" } = {}
) {
  const cutoffMs = now.getTime() - retainDays * 86400000;
  const kept = [];
  const trimmed = [];
  for (const entry of entries ?? []) {
    const ms = Date.parse(entry?.[tsField] ?? "");
    if (Number.isFinite(ms) && ms < cutoffMs) {
      trimmed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { kept, trimmed };
}

/**
 * Rotate one allowlisted world artifact: archive trimmed entries to
 * data/archive/<name>-YYYYMMDD.jsonl, then atomically rewrite the working
 * file with only the kept entries.
 */
export function rotateWorldArtifact({ fileName, retainDays, now = new Date() }) {
  if (!ROTATABLE_FILES.has(fileName)) {
    throw new Error(`Refusing to rotate non-allowlisted artifact: ${fileName}`);
  }
  const filePath = path.join(process.cwd(), "data", fileName);
  const entries = readJsonl(filePath);
  if (!entries.length) {
    return { file: fileName, kept: 0, trimmed: 0, archive: null };
  }

  const { kept, trimmed } = rotateJsonlByAge(entries, { retainDays, now });
  if (!trimmed.length) {
    return { file: fileName, kept: kept.length, trimmed: 0, archive: null };
  }

  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const archivePath = path.join(
    process.cwd(),
    "data",
    "archive",
    `${fileName.replace(/\.jsonl$/, "")}-${stamp}.jsonl`
  );
  // Append (not overwrite) so multiple rotations on one day accumulate.
  for (const entry of trimmed) {
    appendJsonlLineSync(archivePath, entry);
  }
  writeJsonlAtomic(filePath, kept);
  return {
    file: fileName,
    kept: kept.length,
    trimmed: trimmed.length,
    archive: archivePath,
  };
}

/**
 * Rotate both world caches with env-tunable retention
 * (WORLD_INBOX_RETAIN_DAYS / WORLD_HYDRATED_RETAIN_DAYS).
 */
export function runWorldArtifactRotation({ now = new Date() } = {}) {
  const inboxDays = envInt("WORLD_INBOX_RETAIN_DAYS", DEFAULT_INBOX_RETAIN_DAYS);
  const hydratedDays = Math.max(
    envInt("WORLD_HYDRATED_RETAIN_DAYS", DEFAULT_HYDRATED_RETAIN_DAYS),
    inboxDays
  );
  return [
    rotateWorldArtifact({
      fileName: "world-inbox.jsonl",
      retainDays: inboxDays,
      now,
    }),
    rotateWorldArtifact({
      fileName: "world-hydrated.jsonl",
      retainDays: hydratedDays,
      now,
    }),
  ];
}

export const _internals = { ROTATABLE_FILES, envInt };
