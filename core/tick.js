// core/tick.js
import Alpaca from "@alpacahq/alpaca-trade-api";
import { runValueSteward } from "./runValueSteward.js";
import { loadState, saveState } from "./stewardState.js";
import { MODES } from "./modes.js";
import { computeCanTrade } from "./tradeGate.js";
import { applyGpioStateToControl } from "./gpioBridge.js";
import { getExchangeDateString } from "./timeUtils.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export async function runTick({ alpacaConfig }) {
  const now = new Date().toISOString();
  const state = await loadState();
  
  // 1. Sync Infrastructure (GPIO/Mode)
  const gpioApply = applyGpioStateToControl();
  if (gpioApply.updated) {
    state.trading_enabled = gpioApply.state.trading_enabled;
    state.force_no_trade = gpioApply.state.force_no_trade;
  }

  // 2. Determine Mode
  const lastRun = state.last_run_at ? Date.parse(state.last_run_at) : null;
  const todayExchange = getExchangeDateString(new Date());
  const lastRunExchange = lastRun ? getExchangeDateString(new Date(lastRun)) : null;

  let nextMode = state.current_mode;
  if (!state.last_run_at) nextMode = MODES.INACTIVE;
  else if (lastRunExchange && lastRunExchange !== todayExchange) nextMode = MODES.CATCHUP;
  else nextMode = MODES.LIVE;

  state.current_mode = nextMode;
  state.last_run_at = now;
  await saveState(state);

  // 3. THE HANDOVER: Spawn the Python Brain
  // This is the CRITICAL STEP to ensure logging and DB sync happen in Python.
  console.log(`[VS] tick @ ${now} - Handing over to Python Brain...`);
  
  const pythonTick = () => {
    const venvPython = path.join(process.cwd(), ".venv", "bin", "python3");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";
    
    return new Promise((resolve) => {
      const child = spawn(pythonCmd, ["-m", "valuesteward.cli", "tick"], {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONPATH: "./src" },
        stdio: "inherit" 
      });
      child.on("exit", (code) => resolve(code));
    });
  };

  const exitCode = await pythonTick();

  // 4. Update Dashboard (Node-side Snapshot)
  const alpaca = new Alpaca(alpacaConfig);
  const result = await runValueSteward({ alpaca, policy: { mode: state.current_mode }, mode: state.current_mode });
  
  const tradeGate = computeCanTrade({ mode: state.current_mode, internetOk: true, brokerOk: true });

  console.log(`[VS] tick complete (exit=${exitCode}). mode=${state.current_mode} tradingEnabled=${state.trading_enabled}`);

  return { policy: {}, result: { ...result, tradeGate, agentMode: state.current_mode } };
}
