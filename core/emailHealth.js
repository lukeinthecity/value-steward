/**
 * Email-health tracking.
 *
 * The only alarm for "email is broken" used to be email itself — a single
 * point of failure that let a 5-day SMTP outage go unnoticed. This records
 * the outcome of every send attempt to data/email-health.json so the
 * non-email observability path (npm run runtime:status) can surface it.
 *
 * Shared implementation lives in core/channelHealth.js (same tracker as
 * push notifications).
 */

import { createChannelHealth } from "./channelHealth.js";

const channel = createChannelHealth({
  envVar: "VS_EMAIL_HEALTH_PATH",
  defaultFile: "email-health.json",
});

/**
 * Record one send attempt outcome.
 * @param {object} args
 * @param {string} args.label - Email type/category (e.g. "eod", "health", "weekly").
 * @param {boolean} args.ok - Whether the send succeeded.
 * @param {string|null} [args.error] - Error message when ok is false.
 */
export function recordEmailHealth(args) {
  channel.recordHealth(args);
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

export const emailHealthPath = channel.healthPath;
