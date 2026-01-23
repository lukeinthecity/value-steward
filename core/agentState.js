import fs from "fs/promises";
import path from "path";

import { MODES, isValidMode } from "./modes.js";

const AGENT_STATE_PATH = path.join(process.cwd(), "data", "agent-state.json");

function defaultState() {
  return {
    last_run_wall_clock: null,
    last_market_timestamp: null,
    last_known_positions: [],
    open_orders_snapshot: [],
    current_mode: MODES.INACTIVE,
    last_mode_transition_reason: "initial_boot",
    status_indicator: MODES.INACTIVE,
  };
}

export async function loadAgentState() {
  try {
    const raw = await fs.readFile(AGENT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
    };
  } catch (err) {
    return defaultState();
  }
}

export async function saveAgentState(state) {
  await fs.mkdir(path.dirname(AGENT_STATE_PATH), { recursive: true });
  await fs.writeFile(AGENT_STATE_PATH, JSON.stringify(state, null, 2));
}

export async function transitionMode({ from, to, reason, now, state }) {
  if (!isValidMode(to)) {
    console.warn(`[VS] Invalid mode transition target: ${to}`);
    return state;
  }

  if (from !== state.current_mode) {
    console.warn(
      `[VS] Mode transition mismatch: expected ${from}, actual ${state.current_mode}`
    );
  }

  const updated = {
    ...state,
    current_mode: to,
    last_mode_transition_reason: reason,
    status_indicator: to,
  };

  console.log(
    `[VS] mode transition ${state.current_mode} -> ${to} reason=${reason} at=${now}`
  );

  await saveAgentState(updated);
  return updated;
}
