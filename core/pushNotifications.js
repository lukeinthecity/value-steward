/**
 * Push notifications via ntfy (https://ntfy.sh, or a self-hosted server).
 *
 * Deliberately a thin, swappable layer (mirrors emailNotifications): the rest
 * of the system calls sendInitializePush / sendOffPush / sendHealthAlertPush
 * and never touches the transport. Swapping ntfy for another provider later is
 * a one-file change.
 *
 * Fail-safe: a push is an *observability* signal, never a control-path step.
 * sendPush never throws (a failed alert must not crash a tick); it records the
 * outcome to push-health and returns a result object.
 *
 * Config (env):
 *   VS_NTFY_TOPIC    required to enable; the secret topic you subscribe to.
 *   VS_NTFY_SERVER   ntfy server base URL (default https://ntfy.sh).
 *   VS_NTFY_TOKEN    optional bearer token (self-hosted / reserved topics).
 *   VS_PUSH_ENABLED  master switch (default on). Set false to mute all pushes.
 */

import { recordPushHealth } from "./pushHealth.js";

const DEFAULT_SERVER = "https://ntfy.sh";

function loadPushConfig(label) {
  const enabled = !["0", "false", "no", "off"].includes(
    String(process.env.VS_PUSH_ENABLED ?? "true").toLowerCase()
  );
  if (!enabled) return null;

  const topic = (process.env.VS_NTFY_TOPIC || "").trim();
  if (!topic) {
    console.warn(`[push] VS_NTFY_TOPIC not set; skipping ${label} push.`);
    return null;
  }

  const server = (process.env.VS_NTFY_SERVER || DEFAULT_SERVER)
    .trim()
    .replace(/\/+$/, "");
  const token = (process.env.VS_NTFY_TOKEN || "").trim();
  return { server, topic, token, url: `${server}/${encodeURIComponent(topic)}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a push via ntfy.
 *
 * @param {object} args
 * @param {string} [args.label="push"] - Health-tracking category.
 * @param {string} [args.title] - Notification title.
 * @param {string} args.message - Notification body.
 * @param {number} [args.priority=3] - ntfy priority 1 (min) .. 5 (max/urgent).
 * @param {string[]} [args.tags=[]] - ntfy tag/emoji shortcodes (e.g. ["rocket"]).
 * @param {string|null} [args.clickUrl=null] - URL opened when the push is tapped.
 * @param {Function} [args.fetchImpl=globalThis.fetch] - Injectable for tests.
 * @param {number} [args.retries=2] - Retry attempts on failure.
 * @param {number} [args.retryBaseMs=1000] - Exponential backoff base.
 * @returns {Promise<{ok: boolean, skipped: boolean, status?: number, error?: string}>}
 */
export async function sendPush({
  label = "push",
  title,
  message,
  priority = 3,
  tags = [],
  clickUrl = null,
  fetchImpl = globalThis.fetch,
  retries = 2,
  retryBaseMs = 1000,
}) {
  const config = loadPushConfig(label);
  if (!config) return { ok: false, skipped: true };

  if (typeof fetchImpl !== "function") {
    recordPushHealth({ label, ok: false, error: "fetch_unavailable" });
    console.warn(`[push] no fetch implementation available; skipping ${label}.`);
    return { ok: false, skipped: false, error: "fetch_unavailable" };
  }

  const headers = { "Content-Type": "text/plain; charset=utf-8" };
  if (title) headers.Title = title;
  if (priority) headers.Priority = String(priority);
  if (Array.isArray(tags) && tags.length) headers.Tags = tags.join(",");
  if (clickUrl) headers.Click = clickUrl;
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers,
        body: String(message ?? ""),
      });
      if (!res || !res.ok) {
        throw new Error(`http_${res ? res.status : "no_response"}`);
      }
      recordPushHealth({ label, ok: true });
      return { ok: true, skipped: false, status: res.status };
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(retryBaseMs * 2 ** attempt);
    }
  }

  const errMsg = lastError?.message ?? String(lastError);
  recordPushHealth({ label, ok: false, error: errMsg });
  console.warn(
    `[push] ${label} failed after ${retries + 1} attempt(s): ${errMsg}`
  );
  return { ok: false, skipped: false, error: errMsg };
}

/**
 * Market-open "VS is live for the day" push. Caller composes the one-line
 * status summary (decoupled from the runtime data shape).
 */
export function sendInitializePush({ dateLabel, statusLine, clickUrl = null, ...opts }) {
  return sendPush({
    label: "initialize",
    title: `VS live · ${dateLabel}`,
    message: statusLine,
    priority: 3,
    tags: ["rocket"],
    clickUrl,
    ...opts,
  });
}

/**
 * Session-end / shutdown "VS is off" push. Use a higher priority + warning tag
 * for an *unexpected* off (kill-switch / force_no_trade), default otherwise.
 */
export function sendOffPush({
  dateLabel,
  statusLine,
  clickUrl = null,
  unexpected = false,
  ...opts
}) {
  return sendPush({
    label: "off",
    title: `VS off · ${dateLabel}`,
    message: statusLine,
    priority: unexpected ? 4 : 3,
    tags: unexpected ? ["warning", "octagonal_sign"] : ["checkered_flag"],
    clickUrl,
    ...opts,
  });
}

/**
 * Health-alert push. High priority; caller passes a short issue summary.
 */
export function sendHealthAlertPush({ issueCount, summary, clickUrl = null, ...opts }) {
  return sendPush({
    label: "health_alert",
    title: `VS health alert (${issueCount} issue${issueCount === 1 ? "" : "s"})`,
    message: summary,
    priority: 4,
    tags: ["warning"],
    clickUrl,
    ...opts,
  });
}
