const { contextBridge, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const POLICY_PATH = "config/policy.json";

function resolveWithinRoot(relPath) {
  const abs = path.resolve(repoRoot, relPath);
  if (!abs.startsWith(repoRoot)) {
    throw new Error("Path escape blocked");
  }
  return abs;
}

function safeReadText(relPath, maxBytes = 1024 * 1024) {
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
  const raw = safeReadText(relPath);
  if (!raw) return null;
  return JSON.parse(raw);
}

function safeReadJsonl(relPath, limit = 200) {
  const raw = safeReadText(relPath);
  if (!raw) return [];
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
  const raw = safeReadText(relPath);
  if (!raw) return null;
  const lines = raw.trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
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

contextBridge.exposeInMainWorld("valueSteward", {
  repoRoot,
  readJson: safeReadJson,
  readJsonl: safeReadJsonl,
  readJsonlLatest: safeReadJsonlLatest,
  readText: safeReadText,
  stat: safeStat,
  writePolicy,
  openExternal: (url) => shell.openExternal(url),
});
