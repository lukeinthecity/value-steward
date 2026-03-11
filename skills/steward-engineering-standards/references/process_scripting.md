# Process Scripting Patterns

## Atomic Write Pattern

### Node.js (Standard Utility)
```javascript
import fs from "fs/promises";
import path from "path";

export async function saveAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, filePath);
}
```

### Python (Standard Utility)
```python
import os
import json
from pathlib import Path

def save_atomic(file_path: Path, data: dict):
    tmp_path = file_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2))
    os.replace(tmp_path, file_path)
```

## Exponential Backoff Pattern

### Python Decorator
```python
import time
from functools import wraps

def retry_institutional(retries=3, base_delay=1.0):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for i in range(retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if i == retries - 1: raise e
                    time.sleep(base_delay * (2 ** i))
            return None
        return wrapper
    return decorator
```

## Shell Handshake (Node to Python)

```javascript
import { spawn } from "child_process";

export function spawnBrain(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-m", "valuesteward.cli", ...args], {
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: "./src" }
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`Brain exited with code ${code}`));
    });
  });
}
```
