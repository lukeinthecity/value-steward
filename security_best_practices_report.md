# Security Audit Report

## Executive Summary

The highest-risk area in this codebase is the Electron desktop surface. The renderer consumes untrusted data from world context, logs, and model output using HTML sinks, while the preload bridge exposes high-impact capabilities including plaintext secret access, `.env` mutation, local file reads, script execution, and manual order submission. In its current form, an XSS in the renderer is likely to become credential theft and trading-path abuse.

## Critical Findings

### 1. Renderer XSS Can Escalate Into Secret Exfiltration and Trading Actions
- Location:
  - `desktop/renderer.js:53`
  - `desktop/renderer.js:287`
  - `desktop/renderer.js:358`
  - `desktop/renderer.js:385`
  - `desktop/preload.js:523`
- Evidence:
  - The renderer writes untrusted strings into `innerHTML` from:
    - `world.scout_thesis`
    - `world.summary`
    - `world.scout_headlines`
    - `intent` log content
    - position symbols and other artifact fields
  - The same renderer has access to privileged preload APIs including:
    - `readEnv`
    - `writeEnv`
    - `readText`
    - `runScript`
    - `placeManualOrder`
- Impact:
  - A malicious or prompt-injected model output, poisoned log line, or malformed artifact can execute script in the renderer.
  - From there, attacker code can read broker/model/email credentials, rewrite `.env`, trigger local scripts, or submit trades through the desktop bridge.
- Fix:
  - Remove `innerHTML` sinks for untrusted content and replace them with safe DOM construction and `textContent`.
  - Reduce the preload API surface so secrets and command execution are not exposed to the renderer.
- Mitigation:
  - Add a restrictive CSP and keep Electron sandboxing enabled.
  - Treat model output and log/artifact content as attacker-controlled.

## High Findings

### 2. Desktop UI Reads and Writes Plaintext Secrets Through the Renderer
- Location:
  - `desktop/renderer.js:416`
  - `desktop/renderer.js:485`
  - `desktop/preload.js:489`
  - `desktop/preload.js:508`
- Evidence:
  - The renderer loads `.env` values directly into DOM fields.
  - The renderer can write updated credentials back into `.env`.
- Impact:
  - Any renderer compromise exposes long-lived secrets directly.
  - This breaks the normal trust boundary between local secret storage and presentation code.
- Fix:
  - Remove `.env` read/write access from the renderer.
  - Move secret management to an operator-only path in the main process or external secret storage.
- Mitigation:
  - Minimize secrets stored in `.env`.
  - Rotate credentials if the desktop has been used in an unsafe environment.

### 3. Electron Sandbox Defense Is Disabled and No CSP Is Visible
- Location:
  - `desktop/main.js:15`
  - `desktop/index.html:1`
- Evidence:
  - `sandbox: false` in the `BrowserWindow` configuration.
  - No visible Content Security Policy is present in the desktop HTML.
- Impact:
  - Defense-in-depth is weak precisely where the renderer is already using unsafe HTML sinks.
  - Any renderer compromise has fewer barriers to escalation.
- Fix:
  - Re-enable Electron sandboxing unless there is a documented blocker.
  - Add a strict CSP suitable for the desktop UI.
- Mitigation:
  - If sandbox must stay off temporarily, the preload bridge must be drastically reduced and all HTML sinks removed.

## Medium Findings

### 4. Broad Preload Bridge Exposes Local Files and Process Execution to the Renderer
- Location:
  - `desktop/preload.js:194`
  - `desktop/preload.js:228`
  - `desktop/preload.js:523`
- Evidence:
  - The preload bridge exposes:
    - repository file reads
    - script execution
    - manual order submission
    - external URL opening
- Impact:
  - Even without direct RCE in Electron, a renderer compromise can act as a high-privilege local operator.
  - This materially increases the blast radius of any UI-layer injection bug.
- Fix:
  - Replace the broad bridge with narrow, task-specific IPC methods.
  - Gate sensitive actions behind explicit operator confirmation in the main process.
- Mitigation:
  - Keep command allowlists tight and do not expose `.env` or arbitrary file reads to the renderer.

### 5. World/Model Output Is Treated as Trusted Presentation Content
- Location:
  - `desktop/renderer.js:287`
  - `desktop/renderer.js:296`
- Evidence:
  - The UI renders Scout thesis and headlines directly into the DOM.
  - Those values originate from model output and external content.
- Impact:
  - This is a classic prompt-injection-to-XSS path in a desktop app.
  - Advisory-only model logic does not reduce renderer-side risk.
- Fix:
  - Treat all model output as untrusted text.
  - Render it only with escaped text nodes.
- Mitigation:
  - Sanitize stored world-context data before any HTML-capable rendering path if rich formatting is ever required.

## Focus Paths

- `desktop/renderer.js`
- `desktop/preload.js`
- `desktop/main.js`
- `desktop/index.html`
- `world/shadowObserver.js`
- `world/buildWorldContext.js`
- `src/valuesteward/cli.py`

