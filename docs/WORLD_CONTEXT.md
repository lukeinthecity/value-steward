# World Context

## Overview
The world context system captures macro/political/economic signals as a daily,
read-only snapshot. It is built from RSS feeds and logged to repo files so the
agent can learn from stable, repo-versioned inputs.

## Files
- `world/feeds.json`: editable RSS source list.
- `world/schema.worldContext.json`: schema for daily world context objects.
- `data/world-inbox.jsonl`: raw, normalized RSS items (one JSON per line).
- `data/world-context.jsonl`: daily world context objects (one JSON per line).

## How to add or edit sources
Edit `world/feeds.json` and add a new source entry:
- `id` must be unique.
- `enabled` controls whether the feed is fetched.
- `tags` are optional labels for grouping.

## Commands
- `npm run world:fetch`: fetch enabled RSS sources and append to inbox.
- `npm run world:build`: build a stub daily world context entry.
- `npm run world:run`: fetch + build in sequence.

## Notes
LLM integration is a later step. The current builder emits a stub world context
with null tags and a short note for auditability.
