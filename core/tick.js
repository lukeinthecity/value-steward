// core/tick.js
import Alpaca from "@alpacahq/alpaca-trade-api";
import { runValueSteward } from "./runValueSteward.js";
import { loadState, updateState } from "./stewardState.js";
import { MODES } from "./modes.js";
import { computeCanTrade } from "./tradeGate.js";
import { applyGpioStateToControl } from "./gpioBridge.js";
import { getExchangeDateString } from "./timeUtils.js";
import {
  appendHistoryEntry,
  buildArtifactCycleId,
  buildHistoryEntryFromTickResult,
  loadPolicySnapshot,
  saveLatestTickSnapshot,
} from "./runtimeArtifacts.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";

function sha256File(relativePath) {
  const absolutePath = path.join(process.cwd(), relativePath);
  const content = fs.readFileSync(absolutePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function buildRuntimeExpectations() {
  let gitHead = "";
  let gitDirty = "";
  try {
    gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    try {
      execFileSync("git", ["diff", "--quiet"], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      gitDirty = "0";
    } catch {
      gitDirty = "1";
    }
  } catch {
    gitHead = "";
    gitDirty = "";
  }

  return {
    VS_EXPECTED_GIT_HEAD: gitHead,
    VS_EXPECTED_GIT_DIRTY: gitDirty,
    VS_EXPECTED_SHA_CLI_PY: sha256File("src/valuesteward/cli.py"),
    VS_EXPECTED_SHA_EXECUTION_ENGINE_PY: sha256File(
      "src/valuesteward/core/execution_engine.py"
    ),
    VS_EXPECTED_SHA_CONFIG_PY: sha256File("src/valuesteward/config.py"),
    VS_EXPECTED_SHA_POLICY_PY: sha256File("src/valuesteward/policy.py"),
  };
}

export function buildFallbackTickResult({
  now,
  policy,
  state,
  marketOpen,
  clock,
  worldContext,
  tradeGate,
  snapshotError = null,
}) {
  const riskLevel = Number(policy?.risk_level);
  const normalizedRiskLevel = Number.isFinite(riskLevel) ? riskLevel : null;
  return {
    ranAt: state.last_run_at ?? now,
    marketOpen: typeof marketOpen === "boolean" ? marketOpen : null,
    accountStatus:
      typeof marketOpen === "boolean"
        ? marketOpen
          ? "UNKNOWN"
          : "MARKET_CLOSED"
        : null,
    equity: null,
    buyingPower: null,
    cash: null,
    portfolioValue: null,
    marginMultiplier: null,
    mode: policy?.mode ?? null,
    agentMode: state.current_mode ?? null,
    risk_level: normalizedRiskLevel,
    targetCashFraction:
      normalizedRiskLevel === null ? null : 1 - normalizedRiskLevel,
    equityToBuyingPower: null,
    cashUtilization: null,
    numPositions: Array.isArray(state.last_known_positions)
      ? state.last_known_positions.length
      : null,
    longMarketValue: null,
    shortMarketValue: null,
    grossExposure: null,
    netExposure: null,
    maxPositionWeight: null,
    positions: Array.isArray(state.last_known_positions)
      ? state.last_known_positions
      : [],
    isMarketOpen: typeof marketOpen === "boolean" ? marketOpen : null,
    nextOpen: clock?.next_open ?? null,
    nextClose: clock?.next_close ?? null,
    worldContext,
    marketTimestamp: now,
    tradeGate,
    snapshotStatus: snapshotError
      ? "python_authoritative_node_degraded"
      : "python_authoritative_minimal",
    snapshotError,
  };
}

export async function runTick({ alpacaConfig, marketOpen, clock }) {
  const now = new Date().toISOString();
  let state = await loadState();
  
  // 1. Sync Infrastructure (GPIO/Mode)
  const gpioApply = applyGpioStateToControl();
  if (gpioApply.updated) {
    state = gpioApply.state;
  }

  // 2. Determine Mode
  const lastRun = state.last_run_at ? Date.parse(state.last_run_at) : null;
  const todayExchange = getExchangeDateString(new Date());
  const lastRunExchange = lastRun ? getExchangeDateString(new Date(lastRun)) : null;

  let nextMode = state.current_mode;
  if (!state.last_run_at) nextMode = MODES.INACTIVE;
  else if (lastRunExchange && lastRunExchange !== todayExchange) nextMode = MODES.CATCHUP;
  else nextMode = MODES.LIVE;

  state = await updateState((draft) => {
    draft.current_mode = nextMode;
    return draft;
  });

  // 3. THE HANDOVER: Spawn the Python Brain
  // This is the CRITICAL STEP to ensure logging and DB sync happen in Python.
  console.log(`[VS] tick @ ${now} - Handing over to Python Brain...`);
  
  const pythonTick = () => {
    const venvPython = path.join(process.cwd(), ".venv", "bin", "python3");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";
    const runtimeExpectations = buildRuntimeExpectations();
    
    return new Promise((resolve) => {
      const child = spawn(pythonCmd, ["-m", "valuesteward.cli", "tick"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...runtimeExpectations,
          PYTHONPATH: "./src",
        },
        stdio: "inherit" 
      });
      child.on("error", (err) => {
        console.error(`[VS] Failed to start Python process: ${err.message}`);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 0));
    });
  };

  const exitCode = await pythonTick();
  if (exitCode !== 0) {
    throw new Error(`Python execution failed with exit code ${exitCode}.`);
  }
  state = await loadState();

  // 4. Persist a canonical, Python-authoritative tick artifact before enrichment.
  const policy = loadPolicySnapshot();
  if (!policy) {
    throw new Error("Policy snapshot unavailable after Python tick.");
  }
  const worldContext = await loadLatestWorldContext().catch(() => null);
  const cycleId =
    worldContext?.cycle_id ??
    buildArtifactCycleId({
      exchangeDate: getExchangeDateString(new Date()),
      worldContextGeneratedAt: worldContext?.generated_at ?? null,
      worldContextSlot: worldContext?.slot ?? null,
    });
  const tradeGate = computeCanTrade({
    mode: state.current_mode,
    internetOk: null,
    brokerOk: null,
  });
  let finalResult = buildFallbackTickResult({
    now,
    policy,
    state,
    marketOpen,
    clock,
    worldContext,
    tradeGate,
  });

  saveLatestTickSnapshot({
    generated_at: new Date().toISOString(),
    exchange_date: getExchangeDateString(new Date()),
    cycle_id: cycleId,
    python_exit_code: exitCode,
    policy: {
      version: policy.version ?? null,
      mode: policy.mode ?? null,
      risk_level: policy.risk_level ?? null,
    },
    result: {
      ...finalResult,
      cycle_id: cycleId,
    },
  });

  // 5. Enrich the dashboard snapshot with fresh read-only broker data when available.
  try {
    const alpaca = new Alpaca(alpacaConfig);
    const result = await runValueSteward({
      alpaca,
      policy,
      mode: state.current_mode,
      marketOpen,
      clock,
      worldContext,
    });
    finalResult = {
      ...result,
      tradeGate,
      agentMode: state.current_mode,
      snapshotStatus: "node_enriched",
      snapshotError: null,
    };
    saveLatestTickSnapshot({
      generated_at: new Date().toISOString(),
      exchange_date: getExchangeDateString(new Date()),
      cycle_id: cycleId,
      python_exit_code: exitCode,
      policy: {
        version: policy.version ?? null,
        mode: policy.mode ?? null,
        risk_level: policy.risk_level ?? null,
      },
      result: {
        ...finalResult,
        cycle_id: cycleId,
      },
    });
  } catch (err) {
    finalResult = buildFallbackTickResult({
      now,
      policy,
      state,
      marketOpen,
      clock,
      worldContext,
      tradeGate,
      snapshotError: err?.message ?? String(err),
    });
    saveLatestTickSnapshot({
      generated_at: new Date().toISOString(),
      exchange_date: getExchangeDateString(new Date()),
      cycle_id: cycleId,
      python_exit_code: exitCode,
      policy: {
        version: policy.version ?? null,
        mode: policy.mode ?? null,
        risk_level: policy.risk_level ?? null,
      },
      result: {
        ...finalResult,
        cycle_id: cycleId,
      },
    });
    console.warn(
      `[VS] Node enrichment degraded after Python tick: ${err?.message ?? err}`
    );
  }

  try {
    appendHistoryEntry(
      buildHistoryEntryFromTickResult({
        exchangeDate: getExchangeDateString(new Date()),
        generatedAt: new Date().toISOString(),
        cycleId,
        policy,
        result: finalResult,
      })
    );
  } catch (err) {
    console.warn(`[VS] Failed to append history entry: ${err?.message ?? err}`);
  }

  console.log(`[VS] tick complete (exit=${exitCode}). mode=${state.current_mode} tradingEnabled=${state.trading_enabled}`);

  return { policy, result: finalResult };
}
