# World Context

## Overview
The world context system captures macro/political/economic signals as a daily,
read-only snapshot. RSS feeds provide headline indices, and a best-effort
hydration layer attempts to extract readable article text for richer context.

## Pipeline
fetch → hydrate → build (macro digest)

- `world:fetch`: pull enabled RSS sources into `data/world-inbox.jsonl`.
- `world:hydrate`: attempt full-text extraction into `data/world-hydrated.jsonl`.
- `world:build`: create a daily context entry in `data/world-context.jsonl`.

## Files
- `world/feeds.json`: editable RSS source list.
- `world/schema.worldContext.json`: schema for daily world context objects.
- `data/world-inbox.jsonl`: raw, normalized RSS items (one JSON per line).
- `data/world-hydrated.jsonl`: hydration attempts (one JSON per line).
- `data/world-context.jsonl`: daily world context objects (one JSON per line).

## How to add or edit sources
Edit `world/feeds.json` and add a new source entry:
- `id` must be unique.
- `enabled` controls whether the feed is fetched.
- `tags` are optional labels for grouping.

## Commands
- `npm run world:fetch`: fetch enabled RSS sources and append to inbox.
- `npm run world:hydrate`: fetch and extract full text for new links.
- `npm run world:build`: build a daily world context entry with macro digest.
- `npm run world:run`: fetch + hydrate + build in sequence.

## Hydration settings
Environment variables (with defaults):
- `WORLD_HYDRATE_MAX` (default 5)
- `WORLD_HYDRATE_SLEEP_MS` (default 1500)
- `WORLD_HYDRATE_TIMEOUT_MS` (default 15000)
- `WORLD_HYDRATE_MAX_CHARS` (default 15000)

## Common failure modes
- HTTP 403 / paywalls
- Non-HTML content (PDFs)
- Timeouts or content too short

## Macro Digest & LLM Integration
- The build step can invoke a local LLM command to fill `summary` and tag values.
- Env vars:
  - `WORLD_LLM_CMD` (required to enable LLM digest)
  - `WORLD_LLM_TIMEOUT_MS` (optional, default 15000)
- Example (illustrative only):
  - `WORLD_LLM_CMD="llama-cli --model ./models/mistral-macro.gguf --prompt-file ./prompts/world_macro.txt"`
- The integration is model-agnostic: a JSON payload is sent via stdin and a JSON
  world context is expected on stdout.
- Failure modes:
  - Not configured → stub context with notes: "stub world context (LLM not configured)".
  - LLM error/timeout → stub context with notes including the reason.
  - Validation failure → stub context; logs contain details.
- At this stage, `world-context.jsonl` is read-only from the perspective of trading
  and risk logic. It is a macro diary and future teaching substrate.

## Agent integration
- `world/loadLatestWorldContext.js` is the single entry point for loading the
  most recent valid context (local file or GitHub if a token is provided).
- The EOD tick attaches `worldContext` to each result, and the lesson email
  includes key macro tags + summary when available.

## Notes
The builder emits a stub world context when the LLM command is not configured
or fails, with null tags and a short note for auditability.
