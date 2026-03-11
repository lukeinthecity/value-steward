import fs from "fs";
import path from "path";

import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import { loadStateSync } from "./stewardState.js";
import {
  getExchangeDateString,
  getMarketTimeZone,
  isMarketOpenNow,
} from "./timeUtils.js";

const DATA_DIR = path.join(process.cwd(), "data");
const TRAINING_LOG_PATH = path.join(DATA_DIR, "training-log.jsonl");
const WORLD_HEALTH_PATH = path.join(DATA_DIR, "world-health.json");
const SCORECARD_PATH = path.join(DATA_DIR, "signal-scorecard.jsonl");
const SCORECARD_SUMMARY_PATH = path.join(DATA_DIR, "scorecard-summary.json");
const POLICY_PATH = path.join(process.cwd(), "config", "policy.json");
const FEEDS_PATH = path.join(process.cwd(), "world", "feeds.json");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadActiveFeedIds() {
  const feeds = readJson(FEEDS_PATH);
  const sources = Array.isArray(feeds?.sources) ? feeds.sources : [];
  return new Set(
    sources
      .filter((source) => source && source.enabled !== false)
      .map((source) => source.id)
      .filter((id) => typeof id === "string")
  );
}

function getLatestJsonlEntry(filePath) {
  const entries = readJsonl(filePath);
  if (!entries.length) return null;
  return entries[entries.length - 1];
}

function hoursSince(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return (Date.now() - ts) / (1000 * 60 * 60);
}

function daysSince(value) {
  const hours = hoursSince(value);
  if (hours === null) return null;
  return hours / 24;
}

function parseMilestones(value) {
  const raw = (value || "").split(",").map((item) => Number(item.trim()));
  const cleaned = raw.filter((item) => Number.isFinite(item) && item > 0);
  cleaned.sort((a, b) => a - b);
  return cleaned.length ? cleaned : [15, 30, 45, 60];
}

export async function buildHealthSnapshot({ agentState, policy, worldContext } = {}) {
  const now = new Date();
  const generatedAt = now.toISOString();
  const exchangeDate = getExchangeDateString(now);
  const tz = getMarketTimeZone();

  const state = agentState ?? loadStateSync();
  const policyData = policy ?? readJson(POLICY_PATH) ?? {};
  const training = getLatestJsonlEntry(TRAINING_LOG_PATH);
  const scorecardSummary = readJson(SCORECARD_SUMMARY_PATH);
  const scorecardRecords = readJsonl(SCORECARD_PATH);
  const healthState = readJson(WORLD_HEALTH_PATH) ?? {};
  const activeFeedIds = loadActiveFeedIds();
  const context = worldContext ?? (await loadLatestWorldContext());

  const tickAgeHours = hoursSince(state.last_run_at);
  const worldAgeHours = context?.generated_at
    ? hoursSince(context.generated_at)
    : null;
  const worldHealthAgeHours = hoursSince(healthState.last_checked);

  const staleSources = Object.entries(healthState.sources ?? {})
    .filter(([id, entry]) => {
      if (activeFeedIds.size > 0 && !activeFeedIds.has(id)) {
        return false;
      }
      return (entry?.stale_streak ?? 0) > 0;
    })
    .map(([id]) => id);

  const tradingDays = new Set(
    scorecardRecords
      .map((record) => record.entry_date)
      .filter((date) => typeof date === "string" && date.length > 0)
  ).size;

  const issues = [];
  const tickMaxHours = Number(process.env.VS_HEALTH_TICK_MAX_HOURS ?? 2);
  const worldMaxOpen = Number(process.env.VS_HEALTH_WORLD_MAX_HOURS_OPEN ?? 6);
  const worldMaxClosed = Number(process.env.VS_HEALTH_WORLD_MAX_HOURS_CLOSED ?? 36);
  const worldHealthMax = Number(process.env.VS_HEALTH_WORLD_HEALTH_MAX_HOURS ?? 24);
  const scorecardMaxDays = Number(process.env.VS_HEALTH_SCORECARD_MAX_DAYS ?? 7);

  if (tickAgeHours === null || tickAgeHours > tickMaxHours) {
    issues.push({
      level: "warn",
      code: "tick_stale",
      message: `Last tick age ${tickAgeHours?.toFixed(1) ?? "n/a"}h (max ${tickMaxHours}h).`,
    });
  }

  const marketOpen = isMarketOpenNow(now);
  const worldLimit = marketOpen ? worldMaxOpen : worldMaxClosed;
  if (worldAgeHours === null || worldAgeHours > worldLimit) {
    issues.push({
      level: "warn",
      code: "world_context_stale",
      message: `World context age ${worldAgeHours?.toFixed(1) ?? "n/a"}h (max ${worldLimit}h).`,
    });
  }

  if (worldHealthAgeHours === null || worldHealthAgeHours > worldHealthMax) {
    issues.push({
      level: "warn",
      code: "world_health_stale",
      message: `World health last checked ${worldHealthAgeHours?.toFixed(1) ?? "n/a"}h ago (max ${worldHealthMax}h).`,
    });
  }

  if (staleSources.length) {
    issues.push({
      level: "warn",
      code: "feeds_stale",
      message: `Stale feeds detected (${staleSources.length}).`,
    });
  }

  const scorecardAgeDays = daysSince(scorecardSummary?.generated_at);
  if (scorecardSummary && scorecardAgeDays !== null && scorecardAgeDays > scorecardMaxDays) {
    issues.push({
      level: "warn",
      code: "scorecard_stale",
      message: `Scorecard summary age ${scorecardAgeDays.toFixed(1)}d (max ${scorecardMaxDays}d).`,
    });
  }

  return {
    generated_at: generatedAt,
    exchange_date: exchangeDate,
    timezone: tz,
    market_open: marketOpen,
    tick: {
      last_run_at: state.last_run_at ?? null,
      age_hours: tickAgeHours,
    },
    execution: {
      last_executed_at: state.last_executed_at ?? null,
      last_executed_date: state.last_executed_date ?? null,
      executions_today: state.executions_today ?? 0,
    },
    training: {
      last_trained_at: training?.ranAt ?? training?.timestamp ?? null,
      last_reason: training?.reason ?? null,
      policy_version: training?.policyVersion ?? null,
    },
    policy: {
      version: policyData?.version ?? null,
      mode: policyData?.mode ?? null,
      risk_level: policyData?.risk_level ?? null,
    },
    world: {
      generated_at: context?.generated_at ?? null,
      age_hours: worldAgeHours,
      date: context?.date ?? null,
      slot: context?.slot ?? null,
      sources_used: Array.isArray(context?.sources_used)
        ? context.sources_used.length
        : null,
      raw_count: context?.raw_count ?? null,
      macro_label: context?.macro_view?.macro_label ?? null,
      macro_score: context?.macro_view?.macro_score ?? null,
    },
    feeds: {
      last_checked: healthState.last_checked ?? null,
      stale_sources: staleSources,
      stale_count: staleSources.length,
    },
    scorecard: {
      records: scorecardRecords.length,
      trading_days: tradingDays,
      summary_generated_at: scorecardSummary?.generated_at ?? null,
    },
    issues,
  };
}

export function buildPhase1Status() {
  const scorecardRecords = readJsonl(SCORECARD_PATH);
  const scorecardSummary = readJson(SCORECARD_SUMMARY_PATH);
  const tradingDays = new Set(
    scorecardRecords
      .map((record) => record.entry_date)
      .filter((date) => typeof date === "string" && date.length > 0)
  ).size;
  const milestones = parseMilestones(process.env.VS_PHASE1_MILESTONES);

  let hasPositiveExcess = false;
  if (scorecardSummary?.horizons) {
    for (const data of Object.values(scorecardSummary.horizons)) {
      if (data && typeof data.avg_excess_benchmark === "number") {
        if (data.avg_excess_benchmark > 0) {
          hasPositiveExcess = true;
          break;
        }
      }
    }
  }

  return {
    trading_days: tradingDays,
    records: scorecardRecords.length,
    summary_generated_at: scorecardSummary?.generated_at ?? null,
    horizons: scorecardSummary?.horizons ?? {},
    milestones,
    ready_for_review: tradingDays >= 60 && hasPositiveExcess,
  };
}

export function shouldSendHealthEmail({ agentState, snapshot }) {
  const state = agentState ?? loadStateSync();
  const enabled = !["0", "false", "no", "off"].includes(
    String(process.env.VS_EMAIL_HEALTH ?? "true").toLowerCase()
  );
  if (!enabled) return { send: false, reason: "disabled" };

  const minHours = Number(process.env.VS_HEALTH_EMAIL_MIN_HOURS ?? 6);
  const criticalMinHours = Number(
    process.env.VS_HEALTH_EMAIL_CRITICAL_MIN_HOURS ?? minHours
  );

  const lastSent = state.last_health_email_at
    ? Date.parse(state.last_health_email_at)
    : null;
  const hoursSinceLast = lastSent ? (Date.now() - lastSent) / 3600000 : null;

  const hasIssues = (snapshot.issues ?? []).length > 0;
  const dueByIssue =
    hasIssues &&
    (hoursSinceLast === null || hoursSinceLast >= criticalMinHours);

  if (!hasIssues) {
    return { send: false, reason: "no_issues" };
  }

  if (dueByIssue) {
    return { send: true, reason: "issue" };
  }

  return { send: false, reason: "recently_sent" };
}

export function shouldSendPhaseEmail({ agentState, phase, isFinalDecision }) {
  const state = agentState ?? loadStateSync();
  const enabled = !["0", "false", "no", "off"].includes(
    String(process.env.VS_EMAIL_PHASE ?? "true").toLowerCase()
  );
  if (!enabled) return { send: false, reason: "disabled" };

  const eodOnly = !["0", "false", "no", "off"].includes(
    String(process.env.VS_PHASE_EMAIL_EOD_ONLY ?? "true").toLowerCase()
  );
  if (eodOnly && !isFinalDecision) {
    return { send: false, reason: "eod_only" };
  }

  const sent = new Set(state.phase1_milestones_sent ?? []);
  const reached = phase.milestones.filter(
    (milestone) => phase.trading_days >= milestone && !sent.has(milestone)
  );

  if (reached.length) {
    return { send: true, reason: "milestone", milestones: reached };
  }

  if (phase.ready_for_review && !state.phase1_ready_notified) {
    return { send: true, reason: "ready" };
  }

  return { send: false, reason: "no_trigger" };
}
