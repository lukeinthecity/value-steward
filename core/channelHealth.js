/**
 * Shared channel-health tracking (email, push, and any future alert path).
 *
 * You can't rely on an alert channel to tell you that the alert channel is
 * broken. Each channel records the outcome of every send attempt to its own
 * data/<channel>-health.json so the non-alert observability path
 * (npm run runtime:status) surfaces failures.
 *
 * Per-channel schema:
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

/**
 * Build a health tracker bound to one channel's file.
 *
 * @param {object} args
 * @param {string} args.envVar - Env var that overrides the file path.
 *   Resolved per-call (not at import) so tests can point at an explicit file
 *   without mutating process.cwd() — chdir is global and unsafe under
 *   concurrent test runners.
 * @param {string} args.defaultFile - File name under data/.
 * @returns {{ healthPath: () => string, recordHealth: (args: object) => void }}
 */
export function createChannelHealth({ envVar, defaultFile }) {
  function healthPath() {
    const override = (process.env[envVar] || "").trim();
    if (override) return override;
    return path.join(process.cwd(), "data", defaultFile);
  }

  function readHealth() {
    try {
      return JSON.parse(fs.readFileSync(healthPath(), "utf8"));
    } catch {
      return {};
    }
  }

  function normalizeLabel(label) {
    const s = String(label || "")
      .trim()
      .toLowerCase();
    return s.length ? s : "unknown";
  }

  /**
   * Record one send-attempt outcome.
   * @param {object} args
   * @param {string} args.label - Send type/category (e.g. "eod", "health").
   * @param {boolean} args.ok - Whether the send succeeded.
   * @param {string|null} [args.error] - Error message when ok is false.
   */
  function recordHealth({ label, ok, error = null }) {
    const key = normalizeLabel(label);
    const nowIso = new Date().toISOString();
    let health = readHealth();
    if (!health || typeof health !== "object") health = {};
    const prev =
      health[key] && typeof health[key] === "object" ? health[key] : {};
    health[key] = {
      last_attempt_at: nowIso,
      last_outcome: ok ? "ok" : "error",
      last_error: ok ? null : error ? String(error).slice(0, 300) : "unknown",
      last_success_at: ok ? nowIso : (prev.last_success_at ?? null),
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

  return { healthPath, recordHealth };
}
