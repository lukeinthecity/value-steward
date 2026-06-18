/**
 * Push-notification triggers: the once/day market-open ("VS live"), session
 * ("VS off") and health-alert decisions that drive the ntfy senders.
 *
 * Kept separate from transport (pushNotifications) and from the data sources
 * (the entrypoint scripts load the snapshot/state/portfolio and pass them in),
 * so this logic is pure and easily testable. Guards/de-dup state live in
 * data/push-state.json (atomic, gitignored), independent of the Python-managed
 * steward-state to avoid coupling to that schema.
 */

import path from "path";

import { readJson, writeJsonAtomic } from "./runtimeArtifacts.js";
import { getExchangeDateString, getMarketTimeZone } from "./timeUtils.js";
import {
  sendInitializePush as defaultSendInitialize,
  sendOffPush as defaultSendOff,
  sendHealthAlertPush as defaultSendHealthAlert,
} from "./pushNotifications.js";

function pushStatePath(override) {
  if (override) return override;
  const env = (process.env.VS_PUSH_STATE_PATH || "").trim();
  if (env) return env;
  return path.join(process.cwd(), "data", "push-state.json");
}

function loadPushState(override) {
  const state = readJson(pushStatePath(override));
  return state && typeof state === "object" ? state : {};
}

function savePushState(state, override) {
  writeJsonAtomic(pushStatePath(override), state);
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function dateLabel(now, tz = getMarketTimeZone()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "numeric",
      day: "numeric",
    }).format(now);
  } catch {
    return getExchangeDateString(now);
  }
}

function portfolioEquity(portfolio) {
  return portfolio?.equity ?? portfolio?.account?.equity ?? null;
}

function portfolioPositionsCount(portfolio) {
  return Array.isArray(portfolio?.positions) ? portfolio.positions.length : null;
}

/** Trading is "off"/halted when explicitly disabled or force-no-trade is set. */
export function isHalted(state) {
  if (!state || typeof state !== "object") return false;
  return state.trading_enabled === false || state.force_no_trade === true;
}

/** Compose the one-line status summary carried by the init/off pushes. */
export function composeStatusLine({ snapshot, state, portfolio } = {}) {
  const mode = snapshot?.policy?.mode ?? state?.current_mode ?? "n/a";
  const tradeMark = isHalted(state) ? "✗" : "✓";
  const equity = portfolioEquity(portfolio);
  const positions = portfolioPositionsCount(portfolio);
  const staleCount = snapshot?.feeds?.stale_count ?? 0;
  const feeds = staleCount > 0 ? `${staleCount} stale` : "OK";
  return [
    mode,
    `trading ${tradeMark}`,
    equity !== null ? `equity ${fmtUsd(equity)}` : null,
    positions !== null ? `${positions} pos` : null,
    `feeds ${feeds}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function reportClickUrl() {
  const base = (process.env.VS_REPORT_BASE_URL || "").trim();
  return base || null;
}

// Mark the per-day guard whenever a real send was attempted (ok or transport
// failure) — never when skipped because push is unconfigured, so it still
// fires the day the topic is set.
function consumedAttempt(res) {
  return res && res.skipped !== true;
}

function outcomeReason(res) {
  if (res?.ok) return "sent";
  if (res?.skipped) return "skipped_unconfigured";
  return "send_failed";
}

/** Market-open "VS live for the day" push — once per trading day. */
export async function maybeSendInitialize({
  snapshot,
  state,
  portfolio,
  now = new Date(),
  send = defaultSendInitialize,
  pushStatePathOverride,
} = {}) {
  const today = getExchangeDateString(now);
  const pstate = loadPushState(pushStatePathOverride);
  if (pstate.last_init_push_date === today) {
    return { sent: false, reason: "already_sent_today" };
  }
  const res = await send({
    dateLabel: dateLabel(now),
    statusLine: composeStatusLine({ snapshot, state, portfolio }),
    clickUrl: reportClickUrl(),
  });
  if (consumedAttempt(res)) {
    pstate.last_init_push_date = today;
    savePushState(pstate, pushStatePathOverride);
  }
  return { sent: res?.ok === true, reason: outcomeReason(res), result: res };
}

/** Session-end "VS off" push — once per trading day; high-priority if halted. */
export async function maybeSendSessionOff({
  snapshot,
  state,
  portfolio,
  now = new Date(),
  send = defaultSendOff,
  pushStatePathOverride,
} = {}) {
  const today = getExchangeDateString(now);
  const pstate = loadPushState(pushStatePathOverride);
  if (pstate.last_off_push_date === today) {
    return { sent: false, reason: "already_sent_today" };
  }
  const halted = isHalted(state);
  const statusLine = composeStatusLine({ snapshot, state, portfolio });
  const res = await send({
    dateLabel: dateLabel(now),
    statusLine: halted ? `HALTED · ${statusLine}` : statusLine,
    unexpected: halted,
    clickUrl: reportClickUrl(),
  });
  if (consumedAttempt(res)) {
    pstate.last_off_push_date = today;
    savePushState(pstate, pushStatePathOverride);
  }
  return { sent: res?.ok === true, reason: outcomeReason(res), result: res };
}

/**
 * Health-alert push, de-duped: a *new* issue signature alerts immediately; the
 * *same* signature re-alerts only after VS_PUSH_HEALTH_ALERT_MIN_HOURS. When
 * issues clear, the alert state resets so a re-occurrence alerts immediately.
 */
export async function maybeSendHealthAlert({
  snapshot,
  now = new Date(),
  send = defaultSendHealthAlert,
  pushStatePathOverride,
  minHours = Number(process.env.VS_PUSH_HEALTH_ALERT_MIN_HOURS ?? 6),
} = {}) {
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const pstate = loadPushState(pushStatePathOverride);

  if (!issues.length) {
    if (pstate.last_health_alert) {
      delete pstate.last_health_alert;
      savePushState(pstate, pushStatePathOverride);
    }
    return { sent: false, reason: "no_issues" };
  }

  const signature = issues
    .map((issue) => issue.code)
    .sort()
    .join(",");
  const prev = pstate.last_health_alert || {};
  const hoursSince = prev.at ? (now.getTime() - Date.parse(prev.at)) / 3600000 : null;
  if (prev.signature === signature && hoursSince !== null && hoursSince < minHours) {
    return { sent: false, reason: "deduped" };
  }

  const summary = issues
    .slice(0, 4)
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("\n");
  const res = await send({
    issueCount: issues.length,
    summary,
    clickUrl: reportClickUrl(),
  });
  if (consumedAttempt(res)) {
    pstate.last_health_alert = {
      signature,
      at: now.toISOString(),
      count: issues.length,
    };
    savePushState(pstate, pushStatePathOverride);
  }
  return { sent: res?.ok === true, reason: outcomeReason(res), result: res };
}
