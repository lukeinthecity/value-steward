// This file is meant to be COPY-PASTED into a Pipedream Node.js step.
// Expected env vars: ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_BASE_URL, GITHUB_TOKEN.

import Alpaca from "@alpacahq/alpaca-trade-api";
import { sendLessonEmail } from "../core/emailNotifications.js";

const OWNER = "lukeinthecity";
const REPO = "value-steward";
const POLICY_PATH = "config/policy.json";
const HISTORY_PATH = "data/history.jsonl";
const AGENT_STATE_PATH = "data/agent-state.json";

const MODES = {
  INACTIVE: "INACTIVE",
  RECOVERY: "RECOVERY",
  LIVE: "LIVE",
  ERROR: "ERROR",
};

export default defineComponent({
  async run({ steps, $ }) {
    const alpacaConfig = {
      keyId: process.env.ALPACA_API_KEY,
      secretKey: process.env.ALPACA_API_SECRET,
      baseUrl: process.env.ALPACA_BASE_URL,
    };

    const githubToken = process.env.GITHUB_TOKEN;

    const alpaca = new Alpaca(alpacaConfig);
    const clock = await alpaca.getClock();
    const marketOpen = !!clock.is_open;

    // Re-use the alpaca instance when calling runTick
    const { policy, result } = await runTick({
      alpaca,
      githubToken,
      marketOpen,
      clock,
    });

    const training = await trainPolicyFromHistory({
      githubToken,
      minHistory: 10,
      equityDeltaThreshold: 0,
      maxStep: 0.01,
      minRisk: 0.1,
      maxRisk: 0.9,
    });

    if (training && training.updated) {
      try {
        await sendLessonEmail({ policy, result, training });
      } catch (err) {
        console.error(
          "[ValueSteward] Failed to send lesson email:",
          err?.message ?? err
        );
      }
    }

    console.log("Value Steward executed:", { policy, result, training });

    return { policy, result, training };
  },
});


// ---------------- TICK RUNNER ----------------

async function runTick({ alpaca, githubToken, marketOpen, clock }) {
  const now = new Date().toISOString();
  const agentState = await loadAgentState(githubToken);
  const lastRun = agentState.last_run_wall_clock
    ? Date.parse(agentState.last_run_wall_clock)
    : null;
  const downtimeSeconds =
    lastRun !== null ? Math.max(0, (Date.parse(now) - lastRun) / 1000) : null;
  const marketOpenFlag = typeof marketOpen === "boolean" ? marketOpen : false;

  let nextMode = agentState.current_mode || MODES.INACTIVE;
  let transitionReason = null;

  if (!agentState.last_run_wall_clock) {
    nextMode = MODES.INACTIVE;
    transitionReason = "initial_boot";
    console.log(`[VS] boot @ ${now} mode=${nextMode}`);
  } else if (marketOpenFlag && downtimeSeconds !== null && downtimeSeconds > 300) {
    nextMode = MODES.RECOVERY;
    transitionReason = "downtime_detected";
  } else {
    nextMode = MODES.LIVE;
    transitionReason = "normal";
  }

  if (nextMode !== agentState.current_mode) {
    const updatedState = await transitionMode({
      from: agentState.current_mode,
      to: nextMode,
      reason: transitionReason,
      now,
      state: agentState,
      githubToken,
    });
    agentState.current_mode = updatedState.current_mode;
    agentState.last_mode_transition_reason =
      updatedState.last_mode_transition_reason;
    agentState.status_indicator = updatedState.status_indicator;
    agentState._sha = updatedState._sha ?? agentState._sha;
  }

  const policy = await loadPolicy(githubToken);

  const result = await runValueSteward({
    alpaca,
    policy,
    mode: agentState.current_mode,
    marketOpen,
    clock,
    nowOverride: now,
  });

  const tradeGate = computeCanTrade({
    mode: agentState.current_mode,
    internetOk: true,
    brokerOk: true,
  });

  const tickResult = {
    ...result,
    downtimeSeconds,
    tradeGate,
    agentMode: agentState.current_mode,
  };

  await appendHistory(githubToken, {
    ...tickResult,
    policyVersion: policy.version,
  });

  agentState.last_run_wall_clock = now;
  agentState.last_market_timestamp = result.marketTimestamp;
  agentState.last_known_positions = result.positions || [];
  agentState.open_orders_snapshot = [];
  const saved = await saveAgentState(githubToken, agentState, agentState._sha);
  agentState._sha = saved.sha;

  console.log(
    `[VS] tick @ ${now} mode=${agentState.current_mode} marketOpen=${marketOpenFlag} ` +
      `canTrade=${tradeGate.canTrade} tradingEnabled=${tradeGate.tradingEnabled} ` +
      `downtimeSeconds=${downtimeSeconds ?? "n/a"}`
  );

  return { policy, result: tickResult };
}

async function runValueSteward({ alpaca, policy, mode, marketOpen, clock, nowOverride }) {
  const now = nowOverride ?? new Date().toISOString();
  const account = await alpaca.getAccount();

  const equityParsed = parseFloat(account.equity);
  const buyingPowerParsed = parseFloat(account.buying_power);
  const equityNum = Number.isNaN(equityParsed) ? null : equityParsed;
  const buyingPowerNum = Number.isNaN(buyingPowerParsed) ? null : buyingPowerParsed;
  const cashParsed = account.cash ? parseFloat(account.cash) : NaN;
  const cash = Number.isNaN(cashParsed) ? null : cashParsed;
  const portfolioParsed = account.portfolio_value
    ? parseFloat(account.portfolio_value)
    : equityParsed;
  const portfolioValue = Number.isNaN(portfolioParsed) ? null : portfolioParsed;
  const patternDayTrader =
    typeof account.pattern_day_trader === "boolean"
      ? account.pattern_day_trader
      : null;
  const marginMultiplier = account.multiplier
    ? parseFloat(account.multiplier)
    : null;
  const positionsSummary = [];
  let numPositions = 0;
  let longMarketValue = 0;
  let shortMarketValue = 0;

  try {
    const positions = await alpaca.getPositions();
    numPositions = positions.length;

    for (const pos of positions) {
      const mv = parseFloat(pos.market_value ?? "0");
      const qty = parseFloat(pos.qty ?? "0");
      if (Number.isNaN(mv) || Number.isNaN(qty)) continue;

      const avgEntryPrice = parseFloat(pos.avg_entry_price ?? "0");
      const unrealizedPl = parseFloat(pos.unrealized_pl ?? "0");
      const unrealizedPlPc = parseFloat(pos.unrealized_plpc ?? "0");
      const side = qty >= 0 ? "long" : "short";
      positionsSummary.push({
        symbol: pos.symbol,
        qty,
        side,
        marketValue: mv,
        avgEntryPrice: Number.isNaN(avgEntryPrice) ? null : avgEntryPrice,
        unrealizedPl: Number.isNaN(unrealizedPl) ? null : unrealizedPl,
        unrealizedPlPc: Number.isNaN(unrealizedPlPc) ? null : unrealizedPlPc,
        assetClass: pos.asset_class ?? null,
      });

      if (qty > 0) {
        longMarketValue += mv;
      } else if (qty < 0) {
        shortMarketValue += Math.abs(mv);
      }
    }
  } catch (err) {
    console.error("Error fetching positions:", err?.message ?? err);
  }

  const isMarketOpen = typeof marketOpen === "boolean" ? marketOpen : null;
  const nextOpen = clock?.next_open ?? null;
  const nextClose = clock?.next_close ?? null;

  const equityToBuyingPower =
    buyingPowerNum && buyingPowerNum > 0 && equityNum !== null
      ? equityNum / buyingPowerNum
      : null;

  let cashUtilization = null;
  if (equityNum && equityNum > 0 && buyingPowerNum !== null) {
    const raw = 1 - buyingPowerNum / equityNum;
    cashUtilization = Math.max(0, Math.min(1, raw));
  }

  const targetCashFraction = 1 - policy.risk_level;
  const grossExposure = longMarketValue + shortMarketValue;
  const netExposure = longMarketValue - shortMarketValue;
  const maxPositionWeight =
    portfolioValue !== null &&
    portfolioValue > 0 &&
    positionsSummary.length > 0
      ? Math.max(
          ...positionsSummary.map((pos) =>
            Math.abs(pos.marketValue) / portfolioValue
          )
        )
      : null;
  const worldContext = { summary: null, tags: [], sources: [] };

  return {
    ranAt: now,
    marketOpen: isMarketOpen,
    accountStatus: isMarketOpen ? account.status : "MARKET_CLOSED",
    equity: equityNum,
    buyingPower: buyingPowerNum,
    cash,
    portfolioValue,
    patternDayTrader,
    marginMultiplier: Number.isNaN(marginMultiplier) ? null : marginMultiplier,
    mode: policy.mode,
    agentMode: mode ?? null,
    risk_level: policy.risk_level,
    targetCashFraction,
    equityToBuyingPower,
    cashUtilization,
    numPositions,
    longMarketValue,
    shortMarketValue,
    grossExposure,
    netExposure,
    maxPositionWeight,
    positions: positionsSummary,
    isMarketOpen,
    nextOpen,
    nextClose,
    worldContext,
    marketTimestamp: now,
  };
}

// ---------------- GITHUB HELPERS ----------------

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "value-steward-agent",
  };
}

function isValidMode(mode) {
  return Object.values(MODES).includes(mode);
}

function getTradingEnabled() {
  const flag = process.env.TRADING_ENABLED;
  if (!flag) return false;
  return String(flag).toLowerCase() === "true";
}

function computeCanTrade({ mode, internetOk, brokerOk }) {
  const tradingEnabled = getTradingEnabled();
  const canTrade =
    tradingEnabled && internetOk && brokerOk && mode === MODES.LIVE;

  return {
    canTrade,
    tradingEnabled,
    internetOk,
    brokerOk,
    mode,
  };
}

async function loadPolicy(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${POLICY_PATH}`;

  const res = await fetch(url, { headers: githubHeaders(token) });

  if (res.status === 404) {
    return {
      version: 1,
      mode: "read-only",
      risk_level: 0.5,
      max_positions: 3,
      rebalance_threshold: 0.02,
      lastTrainedAt: null,
      lastEquityDelta: 0,
    };
  }

  if (!res.ok) {
    throw new Error(`Error loading policy: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
}

async function loadAgentState(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${AGENT_STATE_PATH}`;

  const res = await fetch(url, { headers: githubHeaders(token) });

  if (res.status === 404) {
    return {
      last_run_wall_clock: null,
      last_market_timestamp: null,
      last_known_positions: [],
      open_orders_snapshot: [],
      current_mode: MODES.INACTIVE,
      last_mode_transition_reason: "initial_boot",
      status_indicator: MODES.INACTIVE,
      _sha: null,
    };
  }

  if (!res.ok) {
    throw new Error(`Error loading agent state: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const parsed = JSON.parse(
    Buffer.from(data.content, "base64").toString("utf8")
  );
  return {
    last_run_wall_clock: null,
    last_market_timestamp: null,
    last_known_positions: [],
    open_orders_snapshot: [],
    current_mode: MODES.INACTIVE,
    last_mode_transition_reason: "initial_boot",
    status_indicator: MODES.INACTIVE,
    ...parsed,
    _sha: data.sha,
  };
}

async function saveAgentState(token, state, shaHint = null) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${AGENT_STATE_PATH}`;

  const encoded = Buffer.from(JSON.stringify(state, null, 2)).toString("base64");

  const body = {
    message: `Update agent state at ${state.last_run_wall_clock ?? "unknown"}`,
    content: encoded,
    ...(shaHint ? { sha: shaHint } : {}),
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Error saving agent state: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { sha: data.content.sha, commitSha: data.commit.sha };
}

async function transitionMode({ from, to, reason, now, state, githubToken }) {
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

  console.log(`[VS] mode transition ${state.current_mode} -> ${to} reason=${reason}`);

  const saved = await saveAgentState(githubToken, updated, state._sha ?? null);
  return { ...updated, _sha: saved.sha };
}

async function savePolicy(token, policy, shaHint = null) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${POLICY_PATH}`;

  const encoded = Buffer.from(JSON.stringify(policy, null, 2)).toString("base64");

  const body = {
    message: `Auto-train policy v${policy.version}`,
    content: encoded,
    ...(shaHint ? { sha: shaHint } : {}),
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Error saving policy: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return { sha: data.content.sha, commitSha: data.commit.sha };
}

async function appendHistory(token, entry) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${HISTORY_PATH}`;

  let sha = null;
  let existing = "";

  const getRes = await fetch(url, { headers: githubHeaders(token) });

  if (getRes.status === 200) {
    const data = await getRes.json();
    sha = data.sha;
    existing = Buffer.from(data.content, "base64").toString("utf8");
  } else if (getRes.status !== 404) {
    throw new Error(
      `Error reading history: ${getRes.status} ${await getRes.text()}`
    );
  }

  const line = JSON.stringify(entry) + "\n";
  const newContent = existing + line;
  const encoded = Buffer.from(newContent).toString("base64");

  const body = {
    message: `Log tick at ${entry.ranAt}`,
    content: encoded,
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    throw new Error(
      `Error writing history: ${putRes.status} ${await putRes.text()}`
    );
  }

  const data = await putRes.json();
  return { sha: data.content.sha, commitSha: data.commit.sha };
}

async function loadHistoryText(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${HISTORY_PATH}`;

  const res = await fetch(url, { headers: githubHeaders(token) });

  if (res.status === 404) return { text: "", sha: null };

  if (!res.ok) {
    throw new Error(`Error loading history: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = Buffer.from(data.content, "base64").toString("utf8");
  return { text, sha: data.sha };
}

async function appendTrainingLogEntry(token, entry) {
  const path = "data/training-log.jsonl";
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  let sha = null;
  let existing = "";

  const getRes = await fetch(url, { headers: githubHeaders(token) });
  if (getRes.status === 200) {
    const data = await getRes.json();
    sha = data.sha;
    existing = Buffer.from(data.content, "base64").toString("utf8");
  } else if (getRes.status !== 404) {
    throw new Error(
      `Error reading training log: ${getRes.status} ${await getRes.text()}`
    );
  }

  const line = JSON.stringify(entry) + "\n";
  const newContent = existing + line;
  const encoded = Buffer.from(newContent).toString("base64");

  const body = {
    message: `Train policy at ${entry.ranAt}`,
    content: encoded,
    ...(sha ? { sha } : {}),
  };

  const putRes = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    throw new Error(
      `Error writing training log: ${putRes.status} ${await putRes.text()}`
    );
  }

  const data = await putRes.json();
  return { sha: data.content.sha, commitSha: data.commit.sha };
}

function evaluateHistoryMetrics(historyEntries) {
  const entries = Array.isArray(historyEntries) ? historyEntries : [];
  const equities = entries
    .map((h) => parseFloat(h.equity))
    .filter((n) => !Number.isNaN(n));

  const sampleCount = entries.length;
  const equityFirst = equities.length ? equities[0] : null;
  const equityLast = equities.length ? equities[equities.length - 1] : null;
  const equityReturn =
    equityFirst && equityLast && equityFirst !== 0
      ? (equityLast - equityFirst) / equityFirst
      : null;

  const returns = [];
  for (let i = 1; i < equities.length; i += 1) {
    const prev = equities[i - 1];
    const curr = equities[i];
    if (prev === 0) continue;
    returns.push((curr - prev) / prev);
  }

  const equityVolatility = returns.length >= 2 ? stdDev(returns) : null;

  let maxDrawdown = null;
  if (equities.length >= 2) {
    let peak = equities[0];
    let worst = 0;
    for (const value of equities) {
      if (value > peak) peak = value;
      if (peak > 0) {
        const drawdown = (value - peak) / peak;
        if (drawdown < worst) worst = drawdown;
      }
    }
    maxDrawdown = Math.abs(worst);
  }

  const avgCashUtilization = mean(
    entries
      .map((h) =>
        typeof h.cashUtilization === "number" ? h.cashUtilization : null
      )
      .filter((n) => n !== null)
  );

  const avgGrossExposureRatio = mean(
    entries
      .map((h) => {
        const gross =
          typeof h.grossExposure === "number" ? h.grossExposure : null;
        const pv =
          typeof h.portfolioValue === "number" ? h.portfolioValue : null;
        if (gross === null || pv === null || pv === 0) return null;
        return gross / pv;
      })
      .filter((n) => n !== null)
  );

  const avgMaxPositionWeight = mean(
    entries
      .map((h) =>
        typeof h.maxPositionWeight === "number" ? h.maxPositionWeight : null
      )
      .filter((n) => n !== null)
  );

  const isUptrend = equityReturn !== null ? equityReturn > 0 : false;
  const isDowntrend = equityReturn !== null ? equityReturn < 0 : false;
  const isHighVol = equityVolatility !== null ? equityVolatility > 0.03 : false;
  const isUnderinvested =
    avgCashUtilization !== null ? avgCashUtilization < 0.2 : false;
  const isOverconcentrated =
    avgMaxPositionWeight !== null ? avgMaxPositionWeight > 0.3 : false;

  return {
    sampleCount,
    equityFirst,
    equityLast,
    equityReturn,
    equityVolatility,
    maxDrawdown,
    avgCashUtilization,
    avgGrossExposureRatio,
    avgMaxPositionWeight,
    isUptrend,
    isDowntrend,
    isHighVol,
    isUnderinvested,
    isOverconcentrated,
  };
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
}

function stdDev(values) {
  if (values.length < 2) return null;
  const avg = values.reduce((acc, val) => acc + val, 0) / values.length;
  const variance =
    values.reduce((acc, val) => acc + (val - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ---------------- TRAINER ----------------

async function trainPolicyFromHistory({
  githubToken,
  minHistory = 10,
  equityDeltaThreshold = 0,
  maxStep = 0.01,
  minRisk = 0.1,
  maxRisk = 0.9,
}) {
  const urlPolicy = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${POLICY_PATH}`;
  const policyRes = await fetch(urlPolicy, {
    headers: githubHeaders(githubToken),
  });

  if (!policyRes.ok) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: null,
      policyVersionAfter: null,
      oldRisk: null,
      newRisk: null,
      decision: "no_update",
      reason: "policy_load_failed",
      metrics: null,
    });
    return {
      updated: false,
      reason: "policy_load_failed",
      status: policyRes.status,
      equityDelta: null,
      oldRisk: null,
      newRisk: null,
      policyVersion: null,
      metrics: null,
    };
  }

  const policyData = await policyRes.json();
  const currentPolicy = JSON.parse(
    Buffer.from(policyData.content, "base64").toString("utf8")
  );

  if (currentPolicy.mode !== "read-only") {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk: currentPolicy.risk_level ?? null,
      newRisk: currentPolicy.risk_level ?? null,
      decision: "no_update",
      reason: "non_read_only_mode",
      metrics: null,
    });
    return {
      updated: false,
      reason: "non_read_only_mode",
      equityDelta: null,
      oldRisk: currentPolicy.risk_level ?? 0.5,
      newRisk: currentPolicy.risk_level ?? 0.5,
      policyVersion: currentPolicy.version ?? 1,
      metrics: null,
    };
  }

  const { text: historyText } = await loadHistoryText(githubToken);
  if (!historyText.trim()) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk: currentPolicy.risk_level ?? null,
      newRisk: currentPolicy.risk_level ?? null,
      decision: "no_update",
      reason: "no_history",
      metrics: null,
    });
    return {
      updated: false,
      reason: "no_history",
      equityDelta: null,
      oldRisk: currentPolicy.risk_level ?? 0.5,
      newRisk: currentPolicy.risk_level ?? 0.5,
      policyVersion: currentPolicy.version ?? 1,
      metrics: null,
    };
  }

  const lines = historyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < minHistory) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk: currentPolicy.risk_level ?? null,
      newRisk: currentPolicy.risk_level ?? null,
      decision: "no_update",
      reason: "not_enough_history",
      metrics: null,
    });
    return {
      updated: false,
      reason: "not_enough_history",
      count: lines.length,
    };
  }

  const history = lines.map((line) => JSON.parse(line));
  const metrics = evaluateHistoryMetrics(history);

  if (metrics.equityFirst === null || metrics.equityLast === null) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk: currentPolicy.risk_level ?? null,
      newRisk: currentPolicy.risk_level ?? null,
      decision: "no_update",
      reason: "not_enough_equity_points",
      metrics,
    });
    return {
      updated: false,
      reason: "not_enough_equity_points",
      equityDelta: null,
      oldRisk: currentPolicy.risk_level ?? 0.5,
      newRisk: currentPolicy.risk_level ?? 0.5,
      policyVersion: currentPolicy.version ?? 1,
      metrics,
    };
  }

  const equityDelta = metrics.equityLast - metrics.equityFirst;

  if (Math.abs(equityDelta) <= equityDeltaThreshold) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk: currentPolicy.risk_level ?? null,
      newRisk: currentPolicy.risk_level ?? null,
      decision: "no_update",
      reason: "equity_delta_small",
      metrics,
    });
    return {
      updated: false,
      reason: "equity_delta_small",
      equityDelta,
      oldRisk: currentPolicy.risk_level ?? 0.5,
      newRisk: currentPolicy.risk_level ?? 0.5,
      policyVersion: currentPolicy.version ?? 1,
      metrics,
    };
  }

  const oldRisk = currentPolicy.risk_level ?? 0.5;

  let direction = 0;
  if (metrics.isUptrend && !metrics.isHighVol && !metrics.isOverconcentrated) {
    direction += 1;
  }
  if (metrics.isDowntrend || metrics.isHighVol || (metrics.maxDrawdown ?? 0) > 0.1) {
    direction -= 1;
  }
  if (
    metrics.isUptrend &&
    !metrics.isHighVol &&
    metrics.avgCashUtilization !== null &&
    metrics.avgCashUtilization < 0.3
  ) {
    direction += 1;
  }
  if (metrics.isOverconcentrated && (!metrics.isUptrend || metrics.isHighVol)) {
    direction -= 1;
  }

  if (direction === 0) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk: currentPolicy.risk_level ?? null,
      newRisk: currentPolicy.risk_level ?? null,
      decision: "no_update",
      reason: "no_strong_signal",
      metrics,
    });
    return {
      updated: false,
      reason: "no_strong_signal",
      equityDelta,
      oldRisk: currentPolicy.risk_level ?? 0.5,
      newRisk: currentPolicy.risk_level ?? 0.5,
      policyVersion: currentPolicy.version ?? 1,
      metrics,
    };
  }

  const baseStep = maxStep;
  const strength = Math.min(1, Math.abs(metrics.equityReturn ?? 0) / 0.1);
  let step = direction * baseStep * strength;

  if (metrics.equityVolatility !== null && metrics.equityVolatility > 0.03) {
    step *= 0.5;
  }

  let newRisk = oldRisk + step;
  newRisk = Math.max(minRisk, Math.min(maxRisk, newRisk));

  if (newRisk === oldRisk) {
    await appendTrainingLogEntry(githubToken, {
      ranAt: new Date().toISOString(),
      policyVersionBefore: currentPolicy.version ?? 1,
      policyVersionAfter: currentPolicy.version ?? 1,
      oldRisk,
      newRisk,
      decision: "no_update",
      reason: "risk_clamped",
      metrics,
    });
    return {
      updated: false,
      reason: "risk_clamped",
      equityDelta,
      oldRisk,
      newRisk,
      policyVersion: currentPolicy.version ?? 1,
      metrics,
    };
  }

  const newPolicy = {
    ...currentPolicy,
    version: (currentPolicy.version ?? 1) + 1,
    risk_level: newRisk,
    lastTrainedAt: new Date().toISOString(),
    lastEquityDelta: equityDelta,
    lastMetricsSummary: {
      sampleCount: metrics.sampleCount,
      equityReturn: metrics.equityReturn,
      equityVolatility: metrics.equityVolatility,
      maxDrawdown: metrics.maxDrawdown,
      avgCashUtilization: metrics.avgCashUtilization,
      avgGrossExposureRatio: metrics.avgGrossExposureRatio,
      avgMaxPositionWeight: metrics.avgMaxPositionWeight,
    },
    lastTrainingReason: "update",
  };

  await savePolicy(githubToken, newPolicy, policyData.sha);

  await appendTrainingLogEntry(githubToken, {
    ranAt: new Date().toISOString(),
    policyVersionBefore: currentPolicy.version ?? 1,
    policyVersionAfter: newPolicy.version,
    oldRisk,
    newRisk,
    decision: "update",
    reason: "update",
    metrics,
  });

  return {
    updated: true,
    reason: "update",
    oldRisk,
    newRisk,
    equityDelta,
    policyVersion: newPolicy.version,
    metrics,
  };
}
