const { contextBridge, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

// Absolute path to the project root
const repoRoot = path.resolve(__dirname, "..");
const POLICY_PATH = "config/policy.json";

console.log("[PRELOAD] Initializing ValueSteward API Bridge...");
console.log("[PRELOAD] repoRoot resolved to:", repoRoot);

function resolveWithinRoot(relPath) {
  // Normalize path to handle both 'data/file' and '../data/file'
  const abs = path.isAbsolute(relPath) ? relPath : path.resolve(repoRoot, relPath);
  if (!abs.startsWith(repoRoot)) {
    // Allow reading from root, but guard against outside access
    if (!abs.includes("value-steward")) throw new Error(`Path escape blocked: ${abs}`);
  }
  return abs;
}

function safeReadText(relPath, maxBytes = 10 * 1024 * 1024) {
  const abs = resolveWithinRoot(relPath);
  if (!fs.existsSync(abs)) return null;
  const stats = fs.statSync(abs);
  const size = Math.min(stats.size, maxBytes);
  const fd = fs.openSync(abs, "r");
  const buffer = Buffer.alloc(size);
  fs.readSync(fd, buffer, 0, size, 0);
  fs.closeSync(fd);
  return buffer.toString("utf-8");
}

function safeReadJson(relPath) {
  try {
    const raw = safeReadText(relPath);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[PRELOAD] Failed to parse JSON from ${relPath}:`, err.message);
    return null;
  }
}

function safeReadJsonl(relPath, limit = 200) {
  const abs = resolveWithinRoot(relPath);
  if (!fs.existsSync(abs)) return [];
  
  const stats = fs.statSync(abs);
  if (stats.size === 0) return [];

  // Tail-read last 128KB for efficiency
  const CHUNK_SIZE = 128 * 1024;
  const readSize = Math.min(stats.size, CHUNK_SIZE);
  const startPos = Math.max(0, stats.size - readSize);
  
  const fd = fs.openSync(abs, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, startPos);
  fs.closeSync(fd);

  const raw = buffer.toString("utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const slice = lines.slice(-limit);
  return slice
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function safeReadJsonlLatest(relPath) {
  const abs = resolveWithinRoot(relPath);
  if (!fs.existsSync(abs)) return null;
  
  const stats = fs.statSync(abs);
  if (stats.size === 0) return null;

  // Read last 64KB - usually enough for several JSONL lines
  const CHUNK_SIZE = 64 * 1024;
  const readSize = Math.min(stats.size, CHUNK_SIZE);
  const startPos = Math.max(0, stats.size - readSize);
  const fd = fs.openSync(abs, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, startPos);
  fs.closeSync(fd);

  const raw = buffer.toString("utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  if (!lines.length) return null;

  // Iterate backwards through the lines in this chunk
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      // Verify it's a valid object
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function safeStat(relPath) {
  try {
    const abs = resolveWithinRoot(relPath);
    if (!fs.existsSync(abs)) return null;
    const stats = fs.statSync(abs);
    return {
      mtimeMs: stats.mtimeMs,
      mtime: stats.mtime.toISOString(),
      size: stats.size,
    };
  } catch {
    return null;
  }
}

function writePolicy(update) {
  const abs = resolveWithinRoot(POLICY_PATH);
  const current = safeReadJson(POLICY_PATH) || {};
  const next = {
    ...current,
    ...update,
  };
  fs.writeFileSync(abs, JSON.stringify(next, null, 2));
  return next;
}

function resolvePythonCommand() {
  const explicit = (process.env.VS_PYTHON || "").trim();
  if (explicit) return explicit;
  const venvPath = path.join(repoRoot, ".venv", "bin", "python");
  if (fs.existsSync(venvPath)) return venvPath;
  return "python3";
}

function resolveApiKeys() {
  const keyId = (
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_API_KEY ||
    ""
  ).trim();
  const secret = (
    process.env.ALPACA_SECRET_KEY ||
    process.env.ALPACA_API_SECRET ||
    process.env.ALPACA_API_SECRET_KEY ||
    ""
  ).trim();
  return { keyId, secret };
}

function getDataStreamUrl() {
  const override = (process.env.ALPACA_DATA_STREAM_URL || "").trim();
  if (override) return override;
  const feed = (process.env.ALPACA_DATA_FEED || "iex").trim().toLowerCase();
  return `wss://stream.data.alpaca.markets/v2/${feed}`;
}

function getTradeStreamUrl() {
  const override = (process.env.ALPACA_TRADE_STREAM_URL || "").trim();
  if (override) return override;
  return "wss://paper-api.alpaca.markets/stream";
}

const SCRIPT_MAP = {
  "train:policy": ["npm", ["run", "train:policy"]],
  "email:test": ["npm", ["run", "email:test"]],
  "local:tick": ["npm", ["run", "local:tick"]],
  "portfolio:refresh": ["npm", ["run", "portfolio:refresh"]],
  "world:fetch": ["npm", ["run", "world:fetch"]],
  "world:hydrate": ["npm", ["run", "world:hydrate"]],
  "world:build": ["npm", ["run", "world:build"]],
  "world:run": ["npm", ["run", "world:run"]],
  "world:inspect": ["npm", ["run", "world:inspect"]],
  "world:health": ["npm", ["run", "world:health"]],
  "world:health:refresh": ["npm", ["run", "world:health:refresh"]],
  desktop: ["npm", ["run", "desktop"]],
};

function runScript(name) {
  const entry = SCRIPT_MAP[name];
  if (!entry) {
    return Promise.resolve({ ok: false, error: "script_not_allowed" });
  }
  const [cmd, args] = entry;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
    });
    let output = "";
    const maxBytes = 64 * 1024;

    const append = (chunk) => {
      const text = chunk.toString();
      output = output + text;
      if (output.length > maxBytes) {
        output = output.slice(output.length - maxBytes);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      output += `\n${err?.message ?? err}`;
    });
    child.on("close", (code, signal) => {
      resolve({ ok: code === 0, code, signal, output });
    });
  });
}

function placeManualOrder(payload) {
  const symbol = String(payload?.symbol ?? "").trim().toUpperCase();
  const side = String(payload?.side ?? "").trim().toLowerCase();
  const notional = Number(payload?.notional);

  if (!symbol || !/^[A-Z0-9.-]+$/.test(symbol)) {
    return Promise.resolve({ ok: false, error: "invalid_symbol" });
  }
  if (!["buy", "sell"].includes(side)) {
    return Promise.resolve({ ok: false, error: "invalid_side" });
  }
  if (!Number.isFinite(notional) || notional <= 0) {
    return Promise.resolve({ ok: false, error: "invalid_notional" });
  }

  const pythonCmd = resolvePythonCommand();

  return new Promise((resolve) => {
    const child = spawn(
      pythonCmd,
      [
        "-m",
        "valuesteward.cli",
        "manual-order",
        "--symbol",
        symbol,
        "--side",
        side,
        "--notional",
        String(notional),
      ],
      {
        cwd: repoRoot,
        env: process.env,
        shell: false,
      }
    );
    let output = "";
    const maxBytes = 64 * 1024;
    const append = (chunk) => {
      const text = chunk.toString();
      output = output + text;
      if (output.length > maxBytes) {
        output = output.slice(output.length - maxBytes);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      output += `\n${err?.message ?? err}`;
    });
    child.on("close", (code, signal) => {
      resolve({ ok: code === 0, code, signal, output });
    });
  });
}

const marketListeners = new Set();
let marketSocket = null;
let marketLastError = null;
let marketSymbols = ["SPY", "DIA", "QQQ"];
const lastEmitBySymbol = new Map();

function emitMarketEvent(event) {
  marketListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  });
}

function startMarketStream(symbols = ["SPY", "DIA", "QQQ"]) {
  marketSymbols = symbols;
  if (marketSocket) return;
  const { keyId, secret } = resolveApiKeys();
  if (!keyId || !secret) {
    marketLastError = "missing_api_key";
    emitMarketEvent({ type: "status", connected: false, error: marketLastError });
    return;
  }
  const url = getDataStreamUrl();
  marketSocket = new WebSocket(url);

  marketSocket.on("open", () => {
    marketLastError = null;
    marketSocket.send(
      JSON.stringify({
        action: "auth",
        key: keyId,
        secret,
      })
    );
    marketSocket.send(
      JSON.stringify({
        action: "subscribe",
        trades: marketSymbols,
        bars: marketSymbols,
      })
    );
    emitMarketEvent({ type: "status", connected: true });
  });

  marketSocket.on("message", (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of messages) {
      if (msg.T === "t") {
        const symbol = msg.S;
        const price = msg.p;
        const ts = msg.t ? Date.parse(msg.t) : Date.now();
        const last = lastEmitBySymbol.get(symbol) ?? 0;
        if (Date.now() - last < 1000) continue;
        lastEmitBySymbol.set(symbol, Date.now());
        emitMarketEvent({ type: "trade", symbol, price, ts });
      }
      if (msg.T === "b") {
        const symbol = msg.S;
        const price = msg.c;
        const ts = msg.t ? Date.parse(msg.t) : Date.now();
        emitMarketEvent({ type: "bar", symbol, price, ts });
      }
      if (msg.T === "error") {
        marketLastError = msg?.msg || "stream_error";
        emitMarketEvent({ type: "status", connected: false, error: marketLastError });
      }
    }
  });

  marketSocket.on("close", () => {
    marketSocket = null;
    emitMarketEvent({ type: "status", connected: false, error: marketLastError });
  });

  marketSocket.on("error", (err) => {
    marketLastError = err?.message ?? "socket_error";
    emitMarketEvent({ type: "status", connected: false, error: marketLastError });
  });
}

function stopMarketStream() {
  if (marketSocket) {
    marketSocket.close();
    marketSocket = null;
  }
}

function onMarketEvent(listener) {
  marketListeners.add(listener);
  return () => marketListeners.delete(listener);
}

const tradeListeners = new Set();
let tradeSocket = null;

function emitTradeEvent(event) {
  tradeListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  });
}

function startTradeStream() {
  if (tradeSocket) return;
  const { keyId, secret } = resolveApiKeys();
  if (!keyId || !secret) {
    emitTradeEvent({ type: "status", connected: false, error: "missing_api_key" });
    return;
  }
  const url = getTradeStreamUrl();
  tradeSocket = new WebSocket(url);

  tradeSocket.on("open", () => {
    tradeSocket.send(JSON.stringify({ action: "auth", key: keyId, secret }));
    tradeSocket.send(
      JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } })
    );
    emitTradeEvent({ type: "status", connected: true });
  });

  tradeSocket.on("message", (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (parsed.stream === "trade_updates") {
      emitTradeEvent({ type: "trade_update", data: parsed.data });
    }
  });

  tradeSocket.on("close", () => {
    tradeSocket = null;
    emitTradeEvent({ type: "status", connected: false });
  });

  tradeSocket.on("error", (err) => {
    emitTradeEvent({ type: "status", connected: false, error: err?.message ?? "error" });
  });
}

function stopTradeStream() {
  if (tradeSocket) {
    tradeSocket.close();
    tradeSocket = null;
  }
}

function onTradeEvent(listener) {
  tradeListeners.add(listener);
  return () => tradeListeners.delete(listener);
}

function readEnv() {
  const abs = resolveWithinRoot(".env");
  if (!fs.existsSync(abs)) return {};
  try {
    const raw = fs.readFileSync(abs, "utf8");
    const lines = raw.split("\n");
    const config = {};
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        config[match[1].trim()] = match[2].trim();
      }
    }
    return config;
  } catch {
    return {};
  }
}

function writeEnv(updates) {
  const abs = resolveWithinRoot(".env");
  let content = "";
  const current = readEnv();
  const next = { ...current, ...updates };
  
  for (const [key, value] of Object.entries(next)) {
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(abs, content, "utf8");
  // Reload process.env for the current session
  Object.assign(process.env, updates);
  return next;
}

contextBridge.exposeInMainWorld("valueSteward", {
  repoRoot,
  readJson: safeReadJson,
  readJsonl: safeReadJsonl,
  readJsonlLatest: safeReadJsonlLatest,
  readText: safeReadText,
  readEnv,
  writeEnv,
  stat: safeStat,
  writePolicy,
  runScript,
  placeManualOrder,
  startMarketStream,
  stopMarketStream,
  onMarketEvent,
  startTradeStream,
  stopTradeStream,
  onTradeEvent,
  openExternal: (url) => shell.openExternal(url),
});
