/**
 * Push-notification health tracking.
 *
 * Mirrors email-health: records the outcome of every push send to
 * data/push-health.json so a silent ntfy failure surfaces in
 * `npm run runtime:status` instead of going unnoticed (the same single-
 * point-of-failure reasoning — you can't rely on the alert channel to tell
 * you the alert channel is broken).
 *
 * Shared implementation lives in core/channelHealth.js (same tracker as
 * email).
 */

import { createChannelHealth } from "./channelHealth.js";

const channel = createChannelHealth({
  envVar: "VS_PUSH_HEALTH_PATH",
  defaultFile: "push-health.json",
});

/**
 * Record one push send attempt outcome.
 * @param {object} args
 * @param {string} args.label - Push type (e.g. "initialize", "off", "health_alert").
 * @param {boolean} args.ok - Whether the send succeeded.
 * @param {string|null} [args.error] - Error message when ok is false.
 */
export function recordPushHealth(args) {
  channel.recordHealth(args);
}

export const pushHealthPath = channel.healthPath;
