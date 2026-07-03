const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const repoRoot = path.resolve(__dirname, "..");
const SECRET_STORE_FILE = "value-steward-secrets.json";
const SECRET_KEYS = [
  "ALPACA_API_KEY_ID",
  "ALPACA_SECRET_KEY",
  "GOOGLE_GENAI_API_KEY",
  "SMTP_PASS",
  "MASSIVE_API_KEY",
];

const SCRIPT_MAP = {
  "local:tick": ["npm", ["run", "local:tick"]],
  "report:weekly": ["npm", ["run", "report:weekly"]],
  "world:build": ["npm", ["run", "world:build"]],
  "world:run": ["npm", ["run", "world:run"]],
};

function resolveWithinRoot(relPath) {
  const abs = path.isAbsolute(relPath)
    ? relPath
    : path.resolve(repoRoot, relPath);
  if (!abs.startsWith(repoRoot)) {
    throw new Error(`Path escape blocked: ${abs}`);
  }
  return abs;
}

function getSecretStorePath() {
  return path.join(app.getPath("userData"), SECRET_STORE_FILE);
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
  } catch {
    return null;
  }
}

function safeReadJsonl(relPath, limit = 200) {
  const abs = resolveWithinRoot(relPath);
  if (!fs.existsSync(abs)) return [];

  const stats = fs.statSync(abs);
  if (stats.size === 0) return [];

  const chunkSize = 128 * 1024;
  const readSize = Math.min(stats.size, chunkSize);
  const startPos = Math.max(0, stats.size - readSize);
  const fd = fs.openSync(abs, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, startPos);
  fs.closeSync(fd);

  return buffer
    .toString("utf-8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
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

  const chunkSize = 64 * 1024;
  const readSize = Math.min(stats.size, chunkSize);
  const startPos = Math.max(0, stats.size - readSize);
  const fd = fs.openSync(abs, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, startPos);
  fs.closeSync(fd);

  const lines = buffer.toString("utf-8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function readEnvFallbackSecrets() {
  try {
    const envPath = resolveWithinRoot(".env");
    if (!fs.existsSync(envPath)) return {};
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    return Object.fromEntries(
      SECRET_KEYS.map((key) => [key, String(parsed[key] || "").trim()]).filter(
        ([, value]) => value,
      ),
    );
  } catch {
    return {};
  }
}

function getStorageAvailability() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readStoredSecrets() {
  if (!getStorageAvailability()) return {};
  const storePath = getSecretStorePath();
  if (!fs.existsSync(storePath)) return {};

  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const secrets = {};
    for (const key of SECRET_KEYS) {
      const encoded = raw?.[key];
      if (!encoded) continue;
      const decrypted = safeStorage.decryptString(
        Buffer.from(encoded, "base64"),
      );
      if (decrypted) secrets[key] = decrypted;
    }
    return secrets;
  } catch {
    return {};
  }
}

function writeStoredSecrets(secrets) {
  if (!getStorageAvailability()) {
    throw new Error("secure_storage_unavailable");
  }
  const payload = {};
  for (const key of SECRET_KEYS) {
    const value = secrets[key];
    if (!value) continue;
    payload[key] = safeStorage.encryptString(String(value)).toString("base64");
  }

  const storePath = getSecretStorePath();
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, storePath);
}

function getSecretStatuses() {
  const stored = readStoredSecrets();
  const fallback = readEnvFallbackSecrets();
  return {
    storageAvailable: getStorageAvailability(),
    secrets: Object.fromEntries(
      SECRET_KEYS.map((key) => {
        if (stored[key])
          return [key, { configured: true, source: "secure_store" }];
        if (fallback[key])
          return [key, { configured: true, source: ".env_fallback" }];
        return [key, { configured: false, source: null }];
      }),
    ),
  };
}

function setSecrets(updates) {
  const sanitized = {};
  for (const key of SECRET_KEYS) {
    if (!(key in updates)) continue;
    const value = String(updates[key] ?? "").trim();
    if (!value) continue;
    sanitized[key] = value;
  }

  const current = readStoredSecrets();
  writeStoredSecrets({ ...current, ...sanitized });
  return getSecretStatuses();
}

function clearSecret(key) {
  if (!SECRET_KEYS.includes(key)) {
    throw new Error("secret_not_allowed");
  }
  const current = readStoredSecrets();
  delete current[key];
  writeStoredSecrets(current);
  return getSecretStatuses();
}

function buildRuntimeEnv() {
  const stored = readStoredSecrets();
  const fallback = readEnvFallbackSecrets();
  return {
    ...process.env,
    ...fallback,
    ...stored,
  };
}

function loadDashboardData() {
  return {
    world: safeReadJsonlLatest("data/world-context.jsonl"),
    intents: safeReadJsonl("logs/intent_log.jsonl", 50),
    state: safeReadJson("data/steward-state.json"),
    history: safeReadJsonlLatest("data/history.jsonl"),
    portfolio: safeReadJson("data/portfolio-live.json"),
    latestTick: safeReadJson("data/latest-tick.json"),
    secretStatus: getSecretStatuses(),
  };
}

function loadRuntimeSnapshot() {
  // Spawn the same runtimeStatus.js script the CLI uses so the desktop view
  // never diverges from the source of truth. The --format=jsonl path emits
  // a single compact line to stdout.
  return new Promise((resolve) => {
    const script = path.join(repoRoot, "scripts", "runtimeStatus.js");
    const child = spawn("node", [script, "--format=jsonl"], {
      cwd: repoRoot,
      env: buildRuntimeEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ ok: false, error: err?.message ?? String(err) });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `exit_code_${code}` });
        return;
      }
      try {
        const snapshot = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        resolve({ ok: true, snapshot });
      } catch (err) {
        resolve({ ok: false, error: `parse_error: ${err?.message ?? err}` });
      }
    });
  });
}

function runScript(name) {
  if (typeof name !== "string") {
    return Promise.resolve({ ok: false, error: "script_not_allowed" });
  }
  const entry = SCRIPT_MAP[name];
  if (!entry) {
    return Promise.resolve({ ok: false, error: "script_not_allowed" });
  }
  const [cmd, args] = entry;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: buildRuntimeEnv(),
      shell: false,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      resolve({
        ok: false,
        error: err?.message ?? String(err),
        code: 1,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      resolve({ ok: code === 0, code, signal });
    });
  });
}

ipcMain.handle("vs:load-dashboard-data", () => loadDashboardData());
ipcMain.handle("vs:load-runtime-status", () => loadRuntimeSnapshot());
ipcMain.handle("vs:run-action", (_event, name) => runScript(name));
ipcMain.handle("vs:get-secret-status", () => getSecretStatuses());
ipcMain.handle("vs:set-secrets", (_event, updates) =>
  setSecrets(updates || {}),
);
ipcMain.handle("vs:clear-secret", (_event, key) =>
  clearSecret(String(key || "")),
);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
