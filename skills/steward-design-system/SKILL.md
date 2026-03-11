---
name: steward-design-system
description: Design system and UI/UX patterns for the Value Steward financial dashboard. Provides institutional-grade CSS, layout guidelines, and visualization components for market data and trading intents.
---

# Steward Design System

This skill provides the design language and UI patterns for the Value Steward project. It is optimized for "Command Center" style dashboards used in institutional trading and risk management.

## Core Principles

1.  **High Information Density:** Financial UIs should maximize data visibility without overwhelming the user. Use compact grids and clear grouping.
2.  **Color Semantic Utility:** Colors must communicate status and risk instantly.
    - **Neutral/Background:** Deep Grays/Blacks (`#0a0a0a`, `#1a1a1a`).
    - **Profit/Bullish:** Emerald Green (`#10b981`).
    - **Loss/Bearish:** Crimson Red (`#ef4444`).
    - **Risk/Warning:** Amber Gold (`#f59e0b`).
    - **System/Action:** Cobalt Blue (`#3b82f6`).
3.  **Typography:** Use high-legibility monospace fonts for all numerical data and ticker symbols to ensure alignment and readability.

## UI Patterns

### 1. Macro Heatmap
Visualizes the divergence between rule-based and AI-based macro scores.
- **Pattern:** Side-by-side vertical meters with color gradients.
- **Context:** Use when rendering world context summaries.

### 2. Intent Feed (Live Terminal)
A scrolling log of the bot's thoughts.
- **Pattern:** Monospace text with timestamp prefixes.
- **Color Coding:** Use blue for "INFO", amber for "SKEPTICAL/HOLD", and green/red for "TRADE".

### 3. Signal Sparklines
Mini-charts for symbol performance.
- **Pattern:** SVG-based line charts with no axes, showing the last 20 bars.

## Implementation Guide

See [styles.md](references/styles.md) for the shared CSS variable system and [components.md](references/components.md) for HTML/JS component templates.
