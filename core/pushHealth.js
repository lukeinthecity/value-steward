/**
 * Push-notification health tracking.
 *
 * Mirrors email-health: records the outcome of every push send to
 * data/push-health.json so a silent ntfy failure surfaces in
 * `npm run runtime:status` instead of going unnoticed (the same single-
 * point-of-failure reasoning — you can't rely on the alert channel to tell
 * you the alert channel is broken).
 *
 * Schema (data/push-health.json):
 *   {
 *     "<label>": {
 *       "last_attempt_at": ISO,
 *       "last_outcome": "ok" | "error",
 *       "last_error": string | null,
 *       "last_success_at": ISO | null
 *     },
 *     ...
 *   }
 */

import fs from "fs";
import path from "path";

// Resolved per-call (not at import). VS_PUSH_HEALTH_PATH lets tests point at an
// explicit file without mutating process.cwd() (chdir is global and unsafe
// under concurrent test runners).
function healthPath() {
  const override = (process.env.VS_PUSH_HEALTH_PATH || "").trim();
  if (override) return override;
  return path.join(process.cwd(), "data", "push-health.json");
}

function readHealth() {
  try {
    return JSON.parse(fs.readFileSync(healthPath(), "utf8"));
  } catch {
    return {};
  }
}

function normalizeLabel(label) {
  const s = String(label || "").trim().toLowerCase();
  return s.length ? s : "unknown";
}

/**
 * Record one push send attempt outcome.
 * @param {object} args
 * @param {string} args.label - Push type (e.g. "initialize", "off", "health_alert").
 * @param {boolean} args.ok - Whether the send succeeded.
 * @param {string|null} [args.error] - Error message when ok is false.
 */
export function recordPushHealth({ label, ok, error = null }) {
  const key = normalizeLabel(label);
  const nowIso = new Date().toISOString();
  let health = readHealth();
  if (!health || typeof health !== "object") health = {};
  const prev = health[key] && typeof health[key] === "object" ? health[key] : {};
  health[key] = {
    last_attempt_at: nowIso,
    last_outcome: ok ? "ok" : "error",
    last_error: ok ? null : error ? String(error).slice(0, 300) : "unknown",
    last_success_at: ok ? nowIso : prev.last_success_at ?? null,
  };
  try {
    const p = healthPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(health, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    // Health recording must never break the actual send path.
  }
}

export { healthPath as pushHealthPath };
