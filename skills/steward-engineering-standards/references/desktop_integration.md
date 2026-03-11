# Desktop Integration Standards

## 1. Path-Agnostic File Access

Always resolve paths relative to the project root in the `preload.js`, not the current working directory of the Electron binary.

```javascript
const path = require("path");
const repoRoot = path.resolve(__dirname, "..");

function resolveWithinRoot(relPath) {
  return path.resolve(repoRoot, relPath);
}
```

## 2. Bridge Verification Handshake

The renderer should never assume `window.valueSteward` is ready immediately. Use a getter or a handshake.

```javascript
// renderer.js
async function loadData() {
  const api = window.valueSteward;
  if (!api) {
    console.error("Bridge not connected");
    return;
  }
  // proceed with data load
}
```

## 3. High-Volume JSONL Tail-Reading

Never load the entire history file into the UI. Read only the last chunk to ensure performance.

```javascript
// preload.js (Standard Pattern)
function safeReadJsonlLatest(relPath) {
  const abs = resolveWithinRoot(relPath);
  const stats = fs.statSync(abs);
  const readSize = Math.min(stats.size, 64 * 1024); // 64KB
  const startPos = Math.max(0, stats.size - readSize);
  
  const fd = fs.openSync(abs, "r");
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, startPos);
  fs.closeSync(fd);
  
  const lines = buffer.toString("utf-8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}
```
