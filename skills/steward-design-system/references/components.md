# Steward Design System Components

## 1. Macro Heatmap Meter

Used to visualize Guardian vs Scout divergence.

```html
<div class="macro-meter-group">
  <div class="meter-col">
    <div class="label-mini">Guardian</div>
    <div class="meter-bar">
      <div class="meter-fill" style="height: 40%; background: var(--color-warning);"></div>
    </div>
    <div class="data-mono">0.40</div>
  </div>
  <div class="meter-col">
    <div class="label-mini">Scout</div>
    <div class="meter-bar">
      <div class="meter-fill" style="height: 70%; background: var(--color-ai);"></div>
    </div>
    <div class="data-mono">0.70</div>
  </div>
</div>
```

## 2. Intent Feed Item

```javascript
function createIntentEl(intent) {
  const div = document.createElement('div');
  div.className = 'intent-item data-mono';
  const colorClass = intent.action_type === 'BUY' ? 'bullish' : 
                     intent.action_type === 'SELL' ? 'bearish' : 'muted';
  
  div.innerHTML = `
    <span class="text-muted">[${new Date(intent.timestamp).toLocaleTimeString()}]</span>
    <span class="text-${colorClass}">${intent.action_type}</span>
    <span>${intent.symbol || ''}</span>
    <span class="text-muted">| ${intent.reason_code}</span>
  `;
  return div;
}
```

## 3. Risk HUD

```html
<div class="risk-hud">
  <div class="hud-item">
    <div class="label-mini">Account Risk</div>
    <div class="data-mono text-bullish">20.4%</div>
  </div>
  <div class="hud-item">
    <div class="label-mini">Daily PnL</div>
    <div class="data-mono text-bearish">-1.2%</div>
  </div>
</div>
```
