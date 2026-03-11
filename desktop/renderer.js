
const elements = {
  guardianMeter: document.getElementById('guardian-meter'),
  scoutMeter: document.getElementById('scout-meter'),
  worldSummary: document.getElementById('world-summary'),
  hudExposure: document.getElementById('hud-exposure'),
  hudEquity: document.getElementById('hud-equity'),
  hudBaseline: document.getElementById('hud-baseline'),
  intentFeed: document.getElementById('intent-feed'),
  portfolioPositions: document.getElementById('portfolio-positions'),
  tickLog: document.getElementById('tick-log'),
  refreshBtn: document.getElementById('refresh-data'),
  actionGrid: document.getElementById('action-grid'),
  // Config Elements
  confAlpacaId: document.getElementById('conf-alpaca-id'),
  confAlpacaSecret: document.getElementById('conf-alpaca-secret'),
  confGeminiKey: document.getElementById('conf-gemini-key'),
  saveConfigBtn: document.getElementById('save-config')
};

const getApi = () => window.valueSteward;

// Global Ticker State for Infinite Loop
let marketPrices = { 'SPY': null, 'DIA': null, 'QQQ': null };
let newsHeadlines = [];

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);
}

function formatPct(val) {
  return ((val || 0) * 100).toFixed(2) + '%';
}

function updateUnifiedTicker() {
  const tickerEl = document.getElementById('news-ticker');
  if (!tickerEl) return;

  const marketParts = Object.entries(marketPrices)
    .filter(([, price]) => price !== null)
    .map(([sym, price]) => `<span class="ticker-item">${sym}: <span class="data-mono">$${price.toFixed(2)}</span></span>`);

  const newsParts = newsHeadlines.map(h => `<span>${h}</span>`);
  
  const content = [...marketParts, ...newsParts].join('');
  if (!content) return;

  // Elite Quant: Triple the content for absolute infinite wrapping
  tickerEl.innerHTML = content + content + content;
}

function renderMacro(world) {
  if (!world) {
    elements.worldSummary.textContent = "Awaiting world context build...";
    return;
  }
  
  const gScore = world.macro_view?.macro_score || 0;
  const sScore = world.scout_score || 0;
  
  if (elements.guardianMeter) {
    const fill = elements.guardianMeter.querySelector('.meter-fill');
    const text = elements.guardianMeter.querySelector('.data-mono');
    if (fill) fill.style.width = (gScore * 100) + '%';
    if (text) text.textContent = gScore.toFixed(2);
  }
  
  if (elements.scoutMeter) {
    const fill = elements.scoutMeter.querySelector('.meter-fill');
    const text = elements.scoutMeter.querySelector('.data-mono');
    if (fill) fill.style.width = (sScore * 100) + '%';
    if (text) text.textContent = sScore.toFixed(2);
  }
  
  const scoutStatus = world.scout_label ? ` [AI: ${world.scout_label.toUpperCase()}]` : '';
  elements.worldSummary.innerHTML = `
    <div class="text-ai" style="margin-bottom: 0.5rem; font-weight: bold;">Guardian: ${world.macro_view?.macro_label?.toUpperCase() || 'CALM'}${scoutStatus}</div>
    <div>${world.scout_thesis || world.summary || "No macro thesis available."}</div>
  `;

  // Update Global News State
  // Elite Quant: Prioritize AI-summarized professional headlines
  if (world.scout_headlines && world.scout_headlines.length > 0) {
    newsHeadlines = world.scout_headlines;
  } else if (world.summary) {
    newsHeadlines = world.summary.split('|').map(s => s.trim());
  }
  updateUnifiedTicker();
}

function startMarketTicker() {
  const api = getApi();
  if (!api) return;

  api.onMarketEvent((event) => {
    if (event.type === 'trade' || event.type === 'bar') {
      marketPrices[event.symbol] = event.price;
      updateUnifiedTicker();
    }
  });

  api.startMarketStream(['SPY', 'DIA', 'QQQ']);
}

function renderHUD(snapshot, state) {
  if (!snapshot) {
    elements.hudExposure.textContent = "0.00%";
    elements.hudEquity.textContent = "Equity: $0.00 | Cash: $0.00";
    return;
  }

  const exposurePct = (snapshot.grossExposure && snapshot.equity) ? snapshot.grossExposure / snapshot.equity : 0;
  elements.hudExposure.textContent = formatPct(exposurePct);
  
  const equity = snapshot.equity || 0;
  const cash = snapshot.cash || 0;
  elements.hudEquity.textContent = `Equity: ${formatCurrency(equity)} | Cash: ${formatCurrency(cash)}`;
  
  const baseline = state?.daily_starting_equity || equity;
  elements.hudBaseline.textContent = formatCurrency(baseline);
  
  const loss = baseline ? (equity / baseline) - 1 : 0;
  elements.hudEquity.style.color = loss >= 0 ? 'var(--color-bullish)' : 'var(--color-bearish)';
}

function renderIntents(intents) {
  if (!intents || !intents.length) {
    elements.intentFeed.innerHTML = '<div class="text-muted">No intents logged yet.</div>';
    return;
  }
  elements.intentFeed.innerHTML = '';
  
  intents.slice().reverse().forEach(intent => {
    let tsString = intent.timestamp;
    if (tsString && !tsString.endsWith('Z') && !tsString.includes('+')) {
        tsString += 'Z';
    }
    const ts = new Date(tsString);
    
    const div = document.createElement('div');
    div.className = 'intent-item data-mono';
    const colorClass = intent.action_type === 'BUY' ? 'text-bullish' : 
                       intent.action_type === 'SELL' ? 'text-bearish' : 'text-muted';
    
    div.innerHTML = `
      <span class="text-muted">[${ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}]</span>
      <span class="${colorClass}">${intent.action_type.padEnd(6)}</span>
      <span style="width: 60px; display: inline-block;">${intent.symbol || '---'}</span>
      <span class="text-muted">| ${intent.reason_code || 'N/A'}</span>
      <span class="text-ai" style="margin-left: 10px; font-size: 0.75rem;">${intent.world_scout_label || ''}</span>
    `;
    elements.intentFeed.appendChild(div);
  });
}

function renderPositions(snapshot) {
  elements.portfolioPositions.innerHTML = '';
  const positions = snapshot?.positions || [];
  
  if (!positions.length) {
    elements.portfolioPositions.innerHTML = '<div class="text-muted">No active positions.</div>';
    return;
  }
  
  positions.forEach(pos => {
    const card = document.createElement('div');
    card.className = 'position-card';
    
    const pnl = pos.unrealizedPl || 0;
    const pnlPct = pos.unrealizedPlPc || 0;
    
    card.innerHTML = `
      <header>
        <strong class="text-action">${pos.symbol}</strong>
        <span class="label-mini">${(pos.side || 'long').toUpperCase()}</span>
      </header>
      <div class="hud-item ${pnl >= 0 ? 'bullish' : 'bearish'}">
        <div class="label-mini">PnL</div>
        <div class="data-mono ${pnl >= 0 ? 'text-bullish' : 'text-bearish'}">
          ${formatCurrency(pnl)} (${(pnlPct * 100).toFixed(2)}%)
        </div>
      </div>
      <div class="label-mini" style="margin-top: 8px;">Market Value</div>
      <div class="data-mono">${formatCurrency(pos.marketValue)}</div>
    `;
    elements.portfolioPositions.appendChild(card);
  });
}

async function loadConfig() {
  const api = getApi();
  if (!api) return;
  const env = api.readEnv();
  if (elements.confAlpacaId) elements.confAlpacaId.value = env.ALPACA_API_KEY_ID || "";
  if (elements.confAlpacaSecret) elements.confAlpacaSecret.value = env.ALPACA_SECRET_KEY || "";
  if (elements.confGeminiKey) elements.confGeminiKey.value = env.GOOGLE_GENAI_API_KEY || "";
}

async function loadData() {
  const api = getApi();
  if (!api) return;
  
  try {
    const world = api.readJsonlLatest("data/world-context.jsonl");
    const intents = api.readJsonl("logs/intent_log.jsonl", 50);
    const state = api.readJson("data/steward-state.json");
    const history = api.readJsonlLatest("data/history.jsonl");
    const tickLog = api.readText("logs/tick.log", 50 * 1024);

    const nextTickEl = document.getElementById('next-tick');
    const tickMetaEl = document.getElementById('tick-meta');
    if (state && nextTickEl) {
      nextTickEl.textContent = state.current_mode || "INACTIVE";
      nextTickEl.style.color = state.trading_enabled ? 'var(--color-action)' : 'var(--color-warning)';
      if (tickMetaEl) {
        const lastRun = state.last_run_at ? new Date(state.last_run_at).toLocaleTimeString() : 'Never';
        tickMetaEl.textContent = `Last Run: ${lastRun}`;
      }
    }

    renderMacro(world);
    renderHUD(history, state);
    renderIntents(intents);
    renderPositions(history);
    
    if (tickLog) {
      elements.tickLog.textContent = tickLog;
      elements.tickLog.scrollTop = elements.tickLog.scrollHeight;
    }
  } catch (err) {
    console.error("[UI] Sync error:", err);
  }
}

elements.refreshBtn.addEventListener('click', loadData);

elements.saveConfigBtn.addEventListener('click', () => {
  const api = getApi();
  if (!api) return;
  
  const updates = {
    ALPACA_API_KEY_ID: elements.confAlpacaId.value.trim(),
    ALPACA_SECRET_KEY: elements.confAlpacaSecret.value.trim(),
    GOOGLE_GENAI_API_KEY: elements.confGeminiKey.value.trim()
  };
  
  api.writeEnv(updates);
  elements.tickLog.textContent += `\n[UI] Configuration saved to .env and reloaded.\n`;
  alert("Settings saved successfully.");
});

elements.actionGrid.addEventListener('click', async (e) => {
  const script = e.target.getAttribute('data-script');
  if (!script) return;
  
  e.target.disabled = true;
  elements.tickLog.textContent += `\n[UI] Spawning ${script}...\n`;
  
  try {
    const api = getApi();
    if (!api) throw new Error("API Bridge not available");
    const res = await api.runScript(script);
    elements.tickLog.textContent += res.output;
  } catch (err) {
    elements.tickLog.textContent += `\n[ERROR] ${err.message}\n`;
  } finally {
    e.target.disabled = false;
    loadData();
  }
});

// Fullscreen Hover Logic
const topbar = document.querySelector('.topbar');
const trigger = document.getElementById('fullscreen-trigger');

if (trigger && topbar) {
  trigger.addEventListener('mouseenter', () => {
    if (document.body.classList.contains('fullscreen')) {
      topbar.classList.add('is-visible');
    }
  });

  topbar.addEventListener('mouseleave', () => {
    if (document.body.classList.contains('fullscreen')) {
      topbar.classList.remove('is-visible');
    }
  });
}

// Keyboard Shortcut for Fullscreen Mode
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    document.body.classList.toggle('fullscreen');
    if (!document.body.classList.contains('fullscreen')) {
      topbar.classList.remove('is-visible');
    }
  }
});

// Initial Load
loadData();
loadConfig();
startMarketTicker();
setInterval(loadData, 30000);
