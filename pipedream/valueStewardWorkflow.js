// This file is meant to be COPY-PASTED into a Pipedream Node.js step.
// Expected env vars: ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_BASE_URL, GITHUB_TOKEN.

import Alpaca from "@alpacahq/alpaca-trade-api";

const OWNER = "lukeinthecity";
const REPO = "value-steward";
const POLICY_PATH = "config/policy.json";
const HISTORY_PATH = "data/history.jsonl";

export default defineComponent({
  async run({ steps, $ }) {
    const alpacaConfig = {
      keyId: process.env.ALPACA_API_KEY,
      secretKey: process.env.ALPACA_API_SECRET,
      baseUrl: process.env.ALPACA_BASE_URL,
    };

    const githubToken = process.env.GITHUB_TOKEN;

    // 1) Tick: perceive & log
    const { policy, result } = await runTick({
      alpacaConfig,
      githubToken,
    });

    // 2) Train: update policy based on accumulated history (with guardrails)
    const training = await trainPolicyFromHistory({
      githubToken,
      minHistory: 10,
      equityDeltaThreshold: 0,
      maxStep: 0.01,
      minRisk: 0.1,
      maxRisk: 0.9,
    });

    console.log("Value Steward executed:", {
      policy,
      result,
      training,
    });

    return { policy, result, training };
  },
});

// ---------------- TICK RUNNER ----------------

async function runTick({ alpacaConfig, githubToken }) {
  const alpaca = new Alpaca(alpacaConfig);

  const policy = await loadPolicy(githubToken);

  const result = await runValueSteward({ alpaca, policy });

  const entry = {
    ...result,
    policyVersion: policy.version,
  };

  await appendHistory(githubToken, entry);

  return { policy, result };
}

async function runValueSteward({ alpaca, policy }) {
  const now = new Date().toISOString();
  const account = await alpaca.getAccount();

  const equityNum = parseFloat(account.equity);
  const buyingPowerNum = parseFloat(account.buying_power);
  const targetCashFraction = 1 - policy.risk_level;

  return {
    ranAt: now,
    accountStatus: account.status,
    equity: equityNum,
    buyingPower: buyingPowerNum,
    mode: policy.mode,
    risk_level: policy.risk_level,
    targetCashFraction,
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
    return {
      updated: false,
      reason: "policy_load_failed",
      status: policyRes.status,
    };
  }

  const policyData = await policyRes.json();
  const currentPolicy = JSON.parse(
    Buffer.from(policyData.content, "base64").toString("utf8")
  );

  if (currentPolicy.mode !== "read-only") {
    return { updated: false, reason: "non_read_only_mode" };
  }

  const { text: historyText } = await loadHistoryText(githubToken);
  if (!historyText.trim()) {
    return { updated: false, reason: "no_history" };
  }

  const lines = historyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < minHistory) {
    return {
      updated: false,
      reason: "not_enough_history",
      count: lines.length,
    };
  }

  const history = lines.map((line) => JSON.parse(line));

  const equities = history
    .map((h) => parseFloat(h.equity))
    .filter((n) => !Number.isNaN(n));

  if (equities.length < 2) {
    return { updated: false, reason: "not_enough_equity_points" };
  }

  const first = equities[0];
  const last = equities[equities.length - 1];
  const equityDelta = last - first;

  if (Math.abs(equityDelta) <= equityDeltaThreshold) {
    return { updated: false, reason: "equity_delta_small", equityDelta };
  }

  const oldRisk = currentPolicy.risk_level ?? 0.5;

  const direction = equityDelta > 0 ? 1 : -1;
  const step =
    Math.min(maxStep, Math.abs(equityDelta) / Math.max(1, Math.abs(first))) *
    direction;

  let newRisk = oldRisk + step;
  newRisk = Math.max(minRisk, Math.min(maxRisk, newRisk));

  if (newRisk === oldRisk) {
    return { updated: false, reason: "risk_clamped", equityDelta };
  }

  const newPolicy = {
    ...currentPolicy,
    version: (currentPolicy.version ?? 1) + 1,
    risk_level: newRisk,
    lastTrainedAt: new Date().toISOString(),
    lastEquityDelta: equityDelta,
  };

  await savePolicy(githubToken, newPolicy, policyData.sha);

  return {
    updated: true,
    oldRisk,
    newRisk,
    equityDelta,
    policyVersion: newPolicy.version,
  };
}
