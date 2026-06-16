/**
 * Email-health tracking.
 *
 * The only alarm for "email is broken" used to be email itself — a single
 * point of failure that let a 5-day SMTP outage go unnoticed. This records
 * the outcome of every send attempt to data/email-health.json so the
 * non-email observability path (npm run runtime:status) can surface it.
 *
 * Schema (data/email-health.json):
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

// Resolved per-call (not at import) so the path tracks the current working
// directory — keeps tests that chdir into a temp dir honest.
function healthPath() {
  return path.join(process.cwd(), "data", "email-health.json");
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
 * Record one send attempt outcome.
 * @param {object} args
 * @param {string} args.label - Email type/category (e.g. "eod", "health", "weekly").
 * @param {boolean} args.ok - Whether the send succeeded.
 * @param {string|null} [args.error] - Error message when ok is false.
 */
export function recordEmailHealth({ label, ok, error = null }) {
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

/**
 * Wrap a nodemailer transporter so every sendMail call records its outcome.
 * Returns the same transporter (mutated) for convenience.
 */
export function instrumentTransporter(transporter, label) {
  if (!transporter || typeof transporter.sendMail !== "function") {
    return transporter;
  }
  const original = transporter.sendMail.bind(transporter);
  transporter.sendMail = async (mailOptions) => {
    try {
      const result = await original(mailOptions);
      recordEmailHealth({ label, ok: true });
      return result;
    } catch (err) {
      recordEmailHealth({ label, ok: false, error: err?.message ?? String(err) });
      throw err;
    }
  };
  return transporter;
}

export { healthPath as emailHealthPath };
