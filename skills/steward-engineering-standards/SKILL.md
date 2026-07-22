---
name: steward-engineering-standards
description: Process scripting and architectural design best practices for the Value Steward project. Ensures unified standards for hybrid JS/Python systems and atomic data persistence.
---

# Steward Engineering Standards

This skill codifies the architectural principles and process scripting best practices for the Value Steward platform. Favour these patterns over generic "cobbled together" logic to keep the system maintainable and well-structured.

## 1. Data Integrity & Persistence

### Atomic Writes (The Gold Standard)
Never write directly to a file. Always write to a `.tmp` file and use an atomic move/rename operation.
- **Node.js:** `fs.writeFile(tmp, data) -> fs.rename(tmp, actual)`
- **Python:** `tmp_path.write_text(data) -> os.replace(tmp_path, actual_path)`
- **Why:** Prevents corruption during power failure or concurrent access.

### Unified State Management
The system must have exactly ONE source of truth for operational state (`data/steward-state.json`). 
- **Rule:** Every tick must load the latest state, apply modifications, and save atomically.
- **Handshake:** Node.js manages infrastructure (mode, timing); Python manages math (baseline, capital).

## 2. Process Scripting Best Practices

### Environment Loading (`.env`) on Entrypoints
Every Node.js script that is a **runnable entrypoint** (anything launched directly by
cron, systemd, or `npm run` — not a library that is only imported)
must load `.env` explicitly as its **first import**:
```js
import "dotenv/config";
```
- **Why:** cron and systemd provide a minimal environment that does not include the
  developer shell's variables. Without an explicit load, the script silently falls
  back to defaults (e.g. `VS_*` feature flags read as unset) and the failure is
  invisible — no crash, just wrong behavior. Relying on a transitive import to pull
  in dotenv is fragile: a future refactor of the import graph can break it by accident.
- **Rule:** if a script reads `process.env`, it loads dotenv itself. Do not depend on
  another module to do it.

### The Retry Decorator
All external API calls (Alpaca, Gemini) must be wrapped in exponential backoff retry logic.
- **Pattern:** Attempt 1 (1s wait) -> Attempt 2 (2s wait) -> Attempt 3 (4s wait).

### Streamlined Logging
- **Institutional Tone:** Use `logger.info`, `logger.warning`, and `logger.error`. 
- **Auditability:** Every decision must result in a `reason_code` and a `timestamp` with an explicit `Z` (UTC) suffix.

## 3. Hybrid Architecture (JS/Python Boundary)

### Clean Handshakes
- Infrastructure scripts (Node.js) should spawn Python logic using the `spawn` or `exec` pattern.
- **Atomic Ticks:** Python must exit with specific codes (0 for success, non-zero for failure) to allow Node.js to trigger health alerts correctly.

### Path-Agnostic Resolution
Never use relative paths like `./data`. Always resolve relative to the project root using absolute path calculation (`path.resolve` or `Path(__file__)`).

## Reference Guides

- [Process Scripting Patterns](references/process_scripting.md) - Code examples for atomic I/O and retries.
