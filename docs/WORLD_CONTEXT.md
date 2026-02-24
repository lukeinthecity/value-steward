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
- `npm run world:inspect`: inspect the latest world context and a corpus preview.

## Inspecting the latest world context
For a quick human-readable summary of the latest world context entry and a small
preview of the hydrated corpus, run:

```bash
npm run world:inspect
```

This shows the most recent date, raw_count, sources_used, tag status (null vs
populated), and up to 5 items from the current corpus_preview.

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
- The build step can optionally invoke a local LLM command to fill `summary`
  and additional context fields.
- Env vars:
  - `WORLD_LLM_CMD` (required to enable LLM digest)
  - `WORLD_LLM_TIMEOUT_MS` (optional, default 15000)
- Example (illustrative only):
  - `WORLD_LLM_CMD="llama-cli --model ./models/mistral-macro.gguf --prompt-file ./prompts/world_macro.txt"`
- The integration is model-agnostic: a JSON payload is sent via stdin and a JSON
  world context is expected on stdout.
- Failure modes:
  - Not configured → rule-based context only (no LLM digest).
  - LLM error/timeout → rule-based context; logs contain details.
  - Validation failure → rule-based context; logs contain details.
- `world-context.jsonl` is read-only from the perspective of data ingestion,
  but its macro labels now adjust LOW-mode target exposure and buffer.

## World time zone normalization
- World context dates are normalized to a single "world time zone."
- Resolution order:
  - `WORLD_TIMEZONE` (explicit override)
  - `TZ` (system-level time zone)
  - `Intl.DateTimeFormat().resolvedOptions().timeZone`
  - fallback to `UTC`
- This ensures `worldContext.date` reflects the intended local trading day even
  when RSS items are timestamped in UTC or foreign time zones.

## Phase 1: Rule-based macro tags (no LLM)
- Tags are now filled using simple keyword rules over the last ~48h of hydrated news.
- Each tag is a bounded score in [0.0, 1.0], where 0 means no signal and 1 means elevated risk.
- This layer is deterministic, auditable, and safe for local or Pi runs.
- Run the full pipeline locally:
  - `npm run world:fetch`
  - `npm run world:hydrate`
  - `npm run world:build`
  - `npm run world:inspect`
If relevant headlines exist, `world:inspect` should show non-null tag values.

## Stability & calibration
- tags_raw: single-day rule-based scores in [0, 1].
- tags: smoothed values using an exponential blend over recent days.
- Smoothing uses alpha=0.4 and clamps daily movement to maxDelta=0.15.
- Scale guide: 0.0–0.3 low, 0.3–0.7 neutral, 0.7–1.0 high.

## Agent integration
- `world/loadLatestWorldContext.js` is the single entry point for loading the
  most recent valid context from local files.
- The tick attaches `worldContext` to each result, and the lesson email
  includes key macro tags + summary when available.
- In LOW mode, macro labels can adjust the target exposure and buffer.

## Notes
The builder emits a rule-based world context when the LLM command is not
configured or fails, with null tags and a short note for auditability.
