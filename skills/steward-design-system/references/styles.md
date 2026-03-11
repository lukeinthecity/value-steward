# Steward Design System Styles

## CSS Variables

Copy these into your main CSS file to ensure institutional branding.

```css
:root {
  /* Neutral Palette */
  --bg-primary: #0a0a0a;
  --bg-secondary: #141414;
  --bg-tertiary: #1f1f1f;
  --border-muted: #2a2a2a;
  
  /* Text */
  --text-primary: #e5e5e5;
  --text-secondary: #a3a3a3;
  --text-muted: #737373;
  
  /* Semantic Status */
  --color-bullish: #10b981;
  --color-bearish: #ef4444;
  --color-warning: #f59e0b;
  --color-action: #3b82f6;
  --color-ai: #8b5cf6; /* Distinct purple for AI Scout data */
  
  /* Layout */
  --grid-gap: 1rem;
  --radius-sm: 4px;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --font-sans: 'Inter', -apple-system, sans-serif;
}
```

## Typography Classes

```css
.data-mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.label-mini {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
```
