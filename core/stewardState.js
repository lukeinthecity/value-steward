// core/stewardState.js
import fs from "fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { getExchangeDateString } from "./timeUtils.js";

const STATE_PATH = path.join(process.cwd(), "data", "steward-state.json");
const STATE_LOCK_PATH = `${STATE_PATH}.lock`;
const LEGACY_AGENT_STATE_PATH = path.join(process.cwd(), "data", "agent-state.json");
const LOCK_TIMEOUT_MS = Number(process.env.VS_STATE_LOCK_TIMEOUT_MS ?? 5000);
const LOCK_STALE_MS = Number(process.env.VS_STATE_LOCK_STALE_MS ?? 15000);
const LOCK_RETRY_MS = Number(process.env.VS_STATE_LOCK_RETRY_MS ?? 25);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy wait for short sync lock retries only.
  }
}

function defaultState() {
  return {
    current_mode: "INACTIVE",
    last_run_at: null,
    last_mode_transition_reason: "initial_boot",
    last_known_positions: [],
    trading_enabled: true,
    force_no_trade: false,
    control_reason: null,
    control_updated_at: null,
    daily_starting_equity: null,
    last_equity_reset_date: null,
    executions_today: 0,
    last_executed_date: null,
    last_executed_at: null,
    last_health_email_at: null,
    last_health_email_date: null,
    phase1_start_date: null,
    phase1_milestones_sent: [],
    phase1_ready_notified: false,
    last_eod_email_date: null,
    version: 1,
    updated_at: new Date().toISOString(),
  };
}

function loadLegacyAgentStateSync() {
  if (!existsSync(LEGACY_AGENT_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LEGACY_AGENT_STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function normalizeState(data = {}) {
  const source = data && typeof data === "object" ? data : {};
  const next = { ...defaultState(), ...source };
  const legacy = loadLegacyAgentStateSync();

  if (legacy) {
    if (!("last_health_email_at" in source) && legacy.last_health_email_at) {
      next.last_health_email_at = legacy.last_health_email_at;
    }
    if (!("last_health_email_date" in source) && legacy.last_health_email_date) {
      next.last_health_email_date = legacy.last_health_email_date;
    }
    if (!("last_eod_email_date" in source) && legacy.last_eod_email_date) {
      next.last_eod_email_date = legacy.last_eod_email_date;
    }
    if (
      !("phase1_milestones_sent" in source) &&
      Array.isArray(legacy.phase1_milestones_sent)
    ) {
      next.phase1_milestones_sent = legacy.phase1_milestones_sent;
    }
    if (!("phase1_ready_notified" in source) && legacy.phase1_ready_notified === true) {
      next.phase1_ready_notified = true;
    }
  }

  if (next.phase1_start_date !== null && typeof next.phase1_start_date !== "string") {
    next.phase1_start_date = null;
  }
  next.phase1_milestones_sent = Array.isArray(next.phase1_milestones_sent)
    ? Array.from(
        new Set(
          next.phase1_milestones_sent.filter(
            (value) => Number.isFinite(value) && value > 0
          )
        )
      ).sort((a, b) => a - b)
    : [];
  next.phase1_ready_notified = next.phase1_ready_notified === true;

  return next;
}

function stateTempPath() {
  return `${STATE_PATH}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
}

function readStateFileSync() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

async function readStateFile() {
  const raw = await fs.readFile(STATE_PATH, "utf8");
  return JSON.parse(raw);
}

function writeStateFileSync(payload) {
  const dir = path.dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = stateTempPath();
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  renameSync(tmpPath, STATE_PATH);
}

async function writeStateFile(payload) {
  const dir = path.dirname(STATE_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = stateTempPath();
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.rename(tmpPath, STATE_PATH);
}

async function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      await fs.mkdir(STATE_LOCK_PATH);
      return;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const stats = await fs.stat(STATE_LOCK_PATH);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(STATE_LOCK_PATH);
          continue;
        }
      } catch {
        // Another process may have released the lock already.
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out acquiring state lock for ${STATE_PATH}`);
}

function acquireLockSync() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(STATE_LOCK_PATH);
      return;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const stats = statSync(STATE_LOCK_PATH);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          rmdirSync(STATE_LOCK_PATH);
          continue;
        }
      } catch {
        // Another process may have released the lock already.
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out acquiring state lock for ${STATE_PATH}`);
}

async function releaseLock() {
  try {
    await fs.rmdir(STATE_LOCK_PATH);
  } catch {
    // Lock may already be gone after a stale-lock cleanup.
  }
}

function releaseLockSync() {
  try {
    rmdirSync(STATE_LOCK_PATH);
  } catch {
    // Lock may already be gone after a stale-lock cleanup.
  }
}

async function withStateLock(fn) {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

function withStateLockSync(fn) {
  acquireLockSync();
  try {
    return fn();
  } finally {
    releaseLockSync();
  }
}

/**
 * Professional Reading: Retry logic to handle concurrent atomic renames.
 */
async function readWithRetry(retries = 3) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const raw = await fs.readFile(STATE_PATH, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(50 * (i + 1));
    }
  }
  return {};
}

export async function loadState() {
  try {
    const data = await readWithRetry();
    return normalizeState(data);
  } catch {
    return normalizeState({});
  }
}

export function loadStateSync() {
  if (!existsSync(STATE_PATH)) return normalizeState({});
  for (let i = 0; i < 3; i += 1) {
    try {
      return normalizeState(readStateFileSync());
    } catch {
      if (i === 2) return normalizeState({});
      sleepSync(25 * (i + 1));
    }
  }
  return normalizeState({});
}

/**
 * Writes a complete state payload under lock.
 */
export async function saveState(state) {
  return withStateLock(async () => {
    const payload = { ...normalizeState(state), updated_at: new Date().toISOString() };
    await writeStateFile(payload);
    return payload;
  });
}

export function saveStateSync(state) {
  return withStateLockSync(() => {
    const payload = { ...normalizeState(state), updated_at: new Date().toISOString() };
    writeStateFileSync(payload);
    return payload;
  });
}

export async function updateState(mutator) {
  return withStateLock(async () => {
    const current = existsSync(STATE_PATH) ? normalizeState(await readStateFile()) : normalizeState({});
    const draft = structuredClone(current);
    const nextState = (await mutator(draft)) ?? draft;
    const payload = { ...normalizeState(nextState), updated_at: new Date().toISOString() };
    await writeStateFile(payload);
    return payload;
  });
}

export function updateStateSync(mutator) {
  return withStateLockSync(() => {
    const current = existsSync(STATE_PATH) ? normalizeState(readStateFileSync()) : normalizeState({});
    const draft = structuredClone(current);
    const nextState = mutator(draft) ?? draft;
    const payload = { ...normalizeState(nextState), updated_at: new Date().toISOString() };
    writeStateFileSync(payload);
    return payload;
  });
}

export async function markHealthEmailSent(sentAt = new Date()) {
  const ts = sentAt instanceof Date ? sentAt : new Date(sentAt);
  return updateState((state) => {
    state.last_health_email_at = ts.toISOString();
    state.last_health_email_date = getExchangeDateString(ts);
    return state;
  });
}

export async function markPhaseEmailSent({ milestones = [], ready = false } = {}) {
  return updateState((state) => {
    const sent = new Set(state.phase1_milestones_sent ?? []);
    for (const milestone of milestones) {
      if (Number.isFinite(milestone) && milestone > 0) {
        sent.add(milestone);
      }
    }
    state.phase1_milestones_sent = Array.from(sent).sort((a, b) => a - b);
    if (ready) {
      state.phase1_ready_notified = true;
    }
    return state;
  });
}

export async function markEodEmailSent(sentAt = new Date()) {
  const ts = sentAt instanceof Date ? sentAt : new Date(sentAt);
  return updateState((state) => {
    state.last_eod_email_date = getExchangeDateString(ts);
    return state;
  });
}

export function markEodEmailSentSync(sentAt = new Date()) {
  const ts = sentAt instanceof Date ? sentAt : new Date(sentAt);
  return updateStateSync((state) => {
    state.last_eod_email_date = getExchangeDateString(ts);
    return state;
  });
}
