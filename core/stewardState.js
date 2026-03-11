// core/stewardState.js
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";

const STATE_PATH = path.join(process.cwd(), "data", "steward-state.json");

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
    version: 1,
    updated_at: new Date().toISOString()
  };
}

/**
 * Professional Reading: Retry logic to handle race conditions from other processes.
 */
async function readWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const raw = await fs.readFile(STATE_PATH, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 50 * (i + 1)));
    }
  }
}

export async function loadState() {
  try {
    const data = await readWithRetry();
    return { ...defaultState(), ...data };
  } catch {
    return defaultState();
  }
}

export function loadStateSync() {
  if (!existsSync(STATE_PATH)) return defaultState();
  for (let i = 0; i < 3; i++) {
    try {
      return { ...defaultState(), ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
    } catch {
      if (i === 2) return defaultState();
      // small busy-wait for sync
    }
  }
}

/**
 * Professional Writing: Atomic Rename Pattern.
 * Writes to a temp file first, then renames. This prevents other processes from
 * ever reading a partially-written file.
 */
export async function saveState(state) {
  const payload = { ...state, updated_at: new Date().toISOString() };
  const dir = path.dirname(STATE_PATH);
  await fs.mkdir(dir, { recursive: true });
  
  const tmpPath = `${STATE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await fs.rename(tmpPath, STATE_PATH);
  
  return payload;
}

export function saveStateSync(state) {
  const payload = { ...state, updated_at: new Date().toISOString() };
  const dir = path.dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  
  const tmpPath = `${STATE_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  renameSync(tmpPath, STATE_PATH);
  
  return payload;
}
