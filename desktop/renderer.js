// The whole system operates on US exchange time; render market/system
// timestamps in it too so the dashboard reads consistently regardless of the
// viewer's local timezone (and so tests are deterministic).
const EXCHANGE_TIME_ZONE = "America/New_York";

const SECRET_FIELD_CONFIG = [
  {
    key: "ALPACA_API_KEY_ID",
    label: "Alpaca API Key ID",
    inputId: "conf-alpaca-id",
  },
  {
    key: "ALPACA_SECRET_KEY",
    label: "Alpaca Secret Key",
    inputId: "conf-alpaca-secret",
  },
  {
    key: "GOOGLE_GENAI_API_KEY",
    label: "Gemini API Key",
    inputId: "conf-gemini-key",
  },
  { key: "SMTP_PASS", label: "SMTP App Password", inputId: "conf-smtp-pass" },
  {
    key: "MASSIVE_API_KEY",
    label: "Massive API Key",
    inputId: "conf-massive-key",
  },
];

const elements = {
  guardianMeter: document.getElementById("guardian-meter"),
  scoutMeter: document.getElementById("scout-meter"),
  worldSummary: document.getElementById("world-summary"),
  hudExposure: document.getElementById("hud-exposure"),
  hudEquity: document.getElementById("hud-equity"),
  hudBaseline: document.getElementById("hud-baseline"),
  intentFeed: document.getElementById("intent-feed"),
  portfolioPositions: document.getElementById("portfolio-positions"),
  tickLog: document.getElementById("tick-log"),
  refreshBtn: document.getElementById("refresh-data"),
  actionGrid: document.getElementById("action-grid"),
  nextTick: document.getElementById("next-tick"),
  tickMeta: document.getElementById("tick-meta"),
  newsTicker: document.getElementById("news-ticker"),
  secretStatus: document.getElementById("secret-status"),
  saveSecretsBtn: document.getElementById("save-secrets"),
  storageHint: document.getElementById("secret-storage-hint"),
  secretInputs: Object.fromEntries(
    SECRET_FIELD_CONFIG.map((field) => [
      field.key,
      document.getElementById(field.inputId),
    ]),
  ),
};

const getApi = () => window.valueSteward;

let newsHeadlines = [];
let tickerOffsetPx = 0;
let tickerLastFrameAt = null;
let tickerAnimationFrame = null;
let tickerTravelWidthPx = 0;

function clearElement(node) {
  if (!node) return;
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendLine(node, text, className) {
  if (!node) return;
  const line = document.createElement("div");
  if (className) line.className = className;
  line.textContent = text;
  node.appendChild(line);
}

function formatCurrency(val) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(val || 0);
}

function formatPct(val) {
  return `${((val || 0) * 100).toFixed(2)}%`;
}

function updateUnifiedTicker() {
  const tickerEl = elements.newsTicker;
  if (!tickerEl) return;

  clearElement(tickerEl);
  if (!newsHeadlines.length) {
    tickerEl.textContent = "Awaiting intelligence headlines...";
    tickerTravelWidthPx = 0;
    return;
  }

  const buildStrip = () => {
    const fragment = document.createDocumentFragment();
    newsHeadlines.forEach((headline) => {
      const headlineEl = document.createElement("span");
      headlineEl.className = "ticker-headline";
      headlineEl.textContent = headline;
      fragment.appendChild(headlineEl);

      const dividerEl = document.createElement("span");
      dividerEl.className = "ticker-divider";
      dividerEl.textContent = " // ";
      fragment.appendChild(dividerEl);
    });
    return fragment;
  };

  tickerEl.appendChild(buildStrip());
  tickerEl.appendChild(buildStrip());
  tickerEl.appendChild(buildStrip());
  tickerTravelWidthPx = computeTickerTravelWidth(tickerEl);
  tickerOffsetPx = normalizeTickerOffset(tickerOffsetPx, tickerTravelWidthPx);
  tickerEl.style.transform = `translateX(${tickerOffsetPx}px)`;
  ensureTickerLoop(tickerEl);
}

function computeTickerTravelWidth(tickerEl) {
  const totalWidth = Number(tickerEl?.scrollWidth) || 0;
  return totalWidth > 0 ? totalWidth / 3 : 0;
}

function normalizeTickerOffset(offsetPx, travelWidthPx) {
  if (!travelWidthPx) return 0;
  while (offsetPx <= -travelWidthPx) {
    offsetPx += travelWidthPx;
  }
  while (offsetPx > 0) {
    offsetPx -= travelWidthPx;
  }
  return offsetPx;
}

function ensureTickerLoop(tickerEl) {
  if (!tickerEl || tickerAnimationFrame !== null) return;

  const durationSeconds = 60;
  const step = (timestamp) => {
    if (tickerLastFrameAt === null) {
      tickerLastFrameAt = timestamp;
    }

    const deltaSeconds = Math.max(0, (timestamp - tickerLastFrameAt) / 1000);
    tickerLastFrameAt = timestamp;

    if (tickerTravelWidthPx > 0) {
      const pixelsPerSecond = tickerTravelWidthPx / durationSeconds;
      tickerOffsetPx -= pixelsPerSecond * deltaSeconds;
      tickerOffsetPx = normalizeTickerOffset(
        tickerOffsetPx,
        tickerTravelWidthPx,
      );
      tickerEl.style.transform = `translateX(${tickerOffsetPx}px)`;
    }

    tickerAnimationFrame = window.requestAnimationFrame(step);
  };

  tickerAnimationFrame = window.requestAnimationFrame(step);
}

function parseTimestamp(value) {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function normalizePosition(position) {
  if (!position || !position.symbol) return null;
  return {
    symbol: position.symbol,
    side: position.side || "long",
    marketValue: position.marketValue ?? position.market_value ?? 0,
    unrealizedPl: position.unrealizedPl ?? position.unrealized_pl ?? null,
    unrealizedPlPc: position.unrealizedPlPc ?? position.unrealized_plpc ?? null,
  };
}

function mergePositionMetrics(positions, fallbackPositions = []) {
  const fallbackBySymbol = new Map(
    (fallbackPositions || [])
      .map(normalizePosition)
      .filter(Boolean)
      .map((position) => [position.symbol, position]),
  );

  return (positions || [])
    .map(normalizePosition)
    .filter(Boolean)
    .map((position) => {
      const fallback = fallbackBySymbol.get(position.symbol);
      if (!fallback) return position;
      return {
        ...position,
        unrealizedPl:
          position.unrealizedPl === null
            ? fallback.unrealizedPl
            : position.unrealizedPl,
        unrealizedPlPc:
          position.unrealizedPlPc === null
            ? fallback.unrealizedPlPc
            : position.unrealizedPlPc,
        side: position.side || fallback.side || "long",
      };
    });
}

function normalizeHudSnapshot(snapshot) {
  if (!snapshot) return null;
  if (snapshot.snapshot) {
    return {
      equity: snapshot.snapshot.equity ?? 0,
      cash: snapshot.snapshot.cash ?? 0,
      grossExposure:
        snapshot.snapshot.risk_exposure_pct !== undefined &&
        snapshot.snapshot.risk_exposure_pct !== null &&
        snapshot.snapshot.equity !== undefined
          ? snapshot.snapshot.risk_exposure_pct * snapshot.snapshot.equity
          : 0,
      ranAt: snapshot.updated_at || snapshot.snapshot.timestamp || null,
    };
  }
  return {
    equity: snapshot.equity ?? 0,
    cash: snapshot.cash ?? 0,
    grossExposure: snapshot.grossExposure ?? 0,
    ranAt: snapshot.ranAt || snapshot.generated_at || null,
  };
}

function resolveHudSnapshot({ history, portfolio, latestTick }) {
  const candidates = [
    {
      timestamp: parseTimestamp(
        portfolio?.updated_at || portfolio?.snapshot?.timestamp,
      ),
      snapshot: normalizeHudSnapshot(portfolio),
    },
    {
      timestamp: parseTimestamp(
        latestTick?.generated_at || latestTick?.result?.ranAt,
      ),
      snapshot: normalizeHudSnapshot(latestTick?.result),
    },
    {
      timestamp: parseTimestamp(history?.ranAt),
      snapshot: normalizeHudSnapshot(history),
    },
  ];

  candidates.sort((left, right) => right.timestamp - left.timestamp);
  return candidates.find((candidate) => candidate.snapshot)?.snapshot || null;
}

function resolvePositionSnapshot({ history, portfolio, latestTick }) {
  const latestTickPositions = Array.isArray(latestTick?.result?.positions)
    ? latestTick.result.positions
    : [];
  const candidates = [
    {
      source: "portfolio",
      timestamp: parseTimestamp(portfolio?.updated_at),
      positions: Array.isArray(portfolio?.positions)
        ? mergePositionMetrics(portfolio.positions, latestTickPositions)
        : null,
    },
    {
      source: "latestTick",
      timestamp: parseTimestamp(
        latestTick?.generated_at || latestTick?.result?.ranAt,
      ),
      positions: latestTickPositions,
    },
    {
      source: "history",
      timestamp: parseTimestamp(history?.ranAt),
      positions: Array.isArray(history?.positions) ? history.positions : null,
    },
  ];

  candidates.sort((left, right) => right.timestamp - left.timestamp);
  const selected =
    candidates.find((candidate) => candidate.positions !== null) ||
    candidates[0];
  return {
    source: selected?.source || "history",
    positions: selected?.positions || [],
  };
}

function buildHoldingDateMap(intents = [], positions = []) {
  const heldSymbols = new Set(
    (positions || []).map((position) => position.symbol),
  );
  const openedAtBySymbol = new Map();

  intents.forEach((intent) => {
    const symbol = intent?.symbol;
    if (!heldSymbols.has(symbol) || !intent?.timestamp) return;
    if (intent.action_type === "BUY") {
      if (!openedAtBySymbol.has(symbol)) {
        openedAtBySymbol.set(symbol, intent.timestamp);
      }
    } else if (intent.action_type === "SELL") {
      openedAtBySymbol.delete(symbol);
    }
  });

  return openedAtBySymbol;
}

function renderMacro(world) {
  if (!world) {
    elements.worldSummary.textContent = "Awaiting world context build...";
    return;
  }

  const guardianScore = world.macro_view?.macro_score || 0;
  const scoutScore = world.scout_score || 0;
  const finalRegime = world.final_regime || null;

  if (elements.guardianMeter) {
    const fill = elements.guardianMeter.querySelector(".meter-fill");
    const text = elements.guardianMeter.querySelector(".data-mono");
    if (fill) fill.style.width = `${guardianScore * 100}%`;
    if (text) text.textContent = guardianScore.toFixed(2);
  }

  if (elements.scoutMeter) {
    const fill = elements.scoutMeter.querySelector(".meter-fill");
    const text = elements.scoutMeter.querySelector(".data-mono");
    if (fill) fill.style.width = `${scoutScore * 100}%`;
    if (text) text.textContent = scoutScore.toFixed(2);
  }

  const guardianLabel = world.macro_view?.macro_label?.toUpperCase() || "N/A";
  const scoutLabel = world.scout_label?.toUpperCase() || "N/A";
  const finalLabel = finalRegime?.final_label?.toUpperCase() || guardianLabel;
  const agreementLabel =
    finalRegime?.divergence === true
      ? "Divergent"
      : finalRegime?.source === "unavailable"
        ? "Partial"
        : "Aligned";
  const fusionSource = finalRegime?.source
    ? String(finalRegime.source)
    : "guardian";

  clearElement(elements.worldSummary);
  appendLine(
    elements.worldSummary,
    `System Regime: ${finalLabel}`,
    "text-ai world-summary-primary",
  );
  appendLine(
    elements.worldSummary,
    `System Logic: Deterministic ${guardianLabel} / Probabilistic ${scoutLabel}`,
    "label-mini",
  );
  appendLine(
    elements.worldSummary,
    `Agreement: ${agreementLabel} · Fusion: ${fusionSource}`,
    "label-mini",
  );
  appendLine(
    elements.worldSummary,
    world.scout_thesis || world.summary || "No macro thesis available.",
    "world-summary-thesis",
  );

  if (
    Array.isArray(world.scout_headlines) &&
    world.scout_headlines.length > 0
  ) {
    newsHeadlines = world.scout_headlines.map((headline) => String(headline));
  } else if (world.summary) {
    newsHeadlines = String(world.summary)
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
  } else {
    newsHeadlines = [];
  }
  updateUnifiedTicker();
}

function renderHUD(snapshot, state) {
  if (!snapshot) {
    elements.hudExposure.textContent = "0.00%";
    elements.hudEquity.textContent = "Equity: $0.00 | Cash: $0.00";
    return;
  }

  const exposurePct =
    snapshot.grossExposure && snapshot.equity
      ? snapshot.grossExposure / snapshot.equity
      : 0;
  elements.hudExposure.textContent = formatPct(exposurePct);

  const equity = snapshot.equity || 0;
  const cash = snapshot.cash || 0;
  elements.hudEquity.textContent = `Equity: ${formatCurrency(equity)} | Cash: ${formatCurrency(cash)}`;

  const baseline = state?.daily_starting_equity || equity;
  elements.hudBaseline.textContent = formatCurrency(baseline);

  const loss = baseline ? equity / baseline - 1 : 0;
  elements.hudEquity.style.color =
    loss >= 0 ? "var(--color-bullish)" : "var(--color-bearish)";
}

function renderIntents(intents) {
  clearElement(elements.intentFeed);
  if (!intents || !intents.length) {
    appendLine(elements.intentFeed, "No intents logged yet.", "text-muted");
    return;
  }

  intents
    .slice()
    .reverse()
    .forEach((intent) => {
      let tsString = intent.timestamp;
      if (tsString && !tsString.endsWith("Z") && !tsString.includes("+")) {
        tsString += "Z";
      }
      const ts = new Date(tsString);

      const row = document.createElement("div");
      row.className = "intent-item data-mono";

      const time = document.createElement("span");
      time.className = "text-muted";
      const dateText = Number.isNaN(ts.getTime())
        ? "unknown"
        : ts.toLocaleDateString([], {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            timeZone: EXCHANGE_TIME_ZONE,
          });
      const timeText = Number.isNaN(ts.getTime())
        ? "unknown"
        : ts.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
            timeZone: EXCHANGE_TIME_ZONE,
          });
      time.textContent = `[${dateText} ${timeText}]`;
      row.appendChild(time);
      row.appendChild(document.createTextNode(" "));

      const action = document.createElement("span");
      action.className =
        intent.action_type === "BUY"
          ? "text-bullish"
          : intent.action_type === "SELL"
            ? "text-bearish"
            : "text-muted";
      action.textContent = String(intent.action_type || "").padEnd(6);
      row.appendChild(action);
      row.appendChild(document.createTextNode(" "));

      const symbol = document.createElement("span");
      symbol.style.width = "60px";
      symbol.style.display = "inline-block";
      symbol.textContent = intent.symbol || "---";
      row.appendChild(symbol);
      row.appendChild(
        document.createTextNode(` | ${intent.reason_code || "N/A"}`),
      );

      if (intent.world_scout_label) {
        const scout = document.createElement("span");
        scout.className = "text-ai";
        scout.style.marginLeft = "10px";
        scout.style.fontSize = "0.75rem";
        scout.textContent = String(intent.world_scout_label);
        row.appendChild(scout);
      }

      elements.intentFeed.appendChild(row);
    });
}

function renderPositions(snapshot, holdingDates = new Map()) {
  clearElement(elements.portfolioPositions);
  const positions = snapshot?.positions || [];

  if (!positions.length) {
    appendLine(
      elements.portfolioPositions,
      "No active positions.",
      "text-muted",
    );
    return;
  }

  positions.forEach((pos) => {
    const card = document.createElement("div");
    card.className = "position-card";

    const header = document.createElement("header");
    const symbol = document.createElement("strong");
    symbol.className = "text-action";
    symbol.textContent = pos.symbol;
    header.appendChild(symbol);

    const side = document.createElement("span");
    side.className = "label-mini";
    side.textContent = String(pos.side || "long").toUpperCase();
    header.appendChild(side);
    card.appendChild(header);

    const heldLabel = document.createElement("div");
    heldLabel.className = "label-mini position-detail-label";
    heldLabel.style.marginTop = "8px";
    heldLabel.textContent = "Held Since";
    card.appendChild(heldLabel);

    const heldValue = document.createElement("div");
    heldValue.className = "data-mono position-detail-value";
    heldValue.textContent = holdingDates.get(pos.symbol)
      ? new Date(holdingDates.get(pos.symbol)).toLocaleDateString("en-US", {
          timeZone: EXCHANGE_TIME_ZONE,
        })
      : "n/a";
    card.appendChild(heldValue);

    if (pos.unrealizedPl === null) {
      const pnlLabel = document.createElement("div");
      pnlLabel.className = "label-mini";
      pnlLabel.style.marginTop = "8px";
      pnlLabel.textContent = "PnL";
      card.appendChild(pnlLabel);

      const pending = document.createElement("div");
      pending.className = "data-mono text-muted";
      pending.textContent = "Pending refresh";
      card.appendChild(pending);
    } else {
      const pnlHud = document.createElement("div");
      pnlHud.className = `hud-item ${pos.unrealizedPl >= 0 ? "bullish" : "bearish"}`;

      const pnlLabel = document.createElement("div");
      pnlLabel.className = "label-mini";
      pnlLabel.textContent = "PnL";
      pnlHud.appendChild(pnlLabel);

      const pnlValue = document.createElement("div");
      pnlValue.className = `data-mono ${pos.unrealizedPl >= 0 ? "text-bullish" : "text-bearish"}`;
      pnlValue.textContent = `${formatCurrency(pos.unrealizedPl)} (${((pos.unrealizedPlPc || 0) * 100).toFixed(2)}%)`;
      pnlHud.appendChild(pnlValue);
      card.appendChild(pnlHud);
    }

    const marketValueLabel = document.createElement("div");
    marketValueLabel.className = "label-mini";
    marketValueLabel.style.marginTop = "8px";
    marketValueLabel.textContent = "Market Value";
    card.appendChild(marketValueLabel);

    const marketValue = document.createElement("div");
    marketValue.className = "data-mono";
    marketValue.textContent = formatCurrency(pos.marketValue);
    card.appendChild(marketValue);

    elements.portfolioPositions.appendChild(card);
  });
}

function describeSecretStatus(status) {
  if (!status?.configured)
    return { text: "Missing", className: "text-bearish" };
  if (status.source === "secure_store")
    return { text: "Stored securely", className: "text-bullish" };
  if (status.source === ".env_fallback")
    return { text: "Using .env fallback", className: "text-warning" };
  return { text: "Configured", className: "text-bullish" };
}

function renderSecretStatus(secretStatus) {
  clearElement(elements.secretStatus);
  if (!elements.secretStatus) return;

  if (elements.storageHint) {
    elements.storageHint.textContent = secretStatus?.storageAvailable
      ? "Secrets entered here are encrypted in desktop storage. Existing .env values remain as privileged fallback until replaced."
      : "Secure desktop storage is unavailable on this device. The app can still use existing .env fallback values, but it cannot store new secrets securely here.";
    elements.storageHint.className =
      `label-mini ${secretStatus?.storageAvailable ? "" : "text-warning"}`.trim();
  }

  if (elements.saveSecretsBtn) {
    elements.saveSecretsBtn.disabled = !secretStatus?.storageAvailable;
  }

  SECRET_FIELD_CONFIG.forEach((field) => {
    const row = document.createElement("div");
    row.className = "secret-row";

    const meta = document.createElement("div");
    meta.className = "secret-meta";

    const label = document.createElement("div");
    label.className = "label-mini";
    label.textContent = field.label;
    meta.appendChild(label);

    const statusEl = document.createElement("div");
    const display = describeSecretStatus(secretStatus?.secrets?.[field.key]);
    statusEl.className = `data-mono secret-status ${display.className}`;
    statusEl.textContent = display.text;
    meta.appendChild(statusEl);

    row.appendChild(meta);

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "secret-clear";
    clearButton.dataset.secretKey = field.key;
    clearButton.textContent = "Clear";
    const canClear =
      secretStatus?.storageAvailable &&
      secretStatus?.secrets?.[field.key]?.source === "secure_store";
    clearButton.disabled = !canClear;
    if (!canClear) {
      clearButton.title =
        secretStatus?.secrets?.[field.key]?.source === ".env_fallback"
          ? "This credential is coming from .env fallback and cannot be cleared from the desktop UI."
          : "No securely stored credential to clear.";
    }
    row.appendChild(clearButton);

    elements.secretStatus.appendChild(row);
  });
}

function collectSecretUpdates() {
  return Object.fromEntries(
    Object.entries(elements.secretInputs)
      .map(([key, input]) => [key, String(input?.value || "").trim()])
      .filter(([, value]) => value),
  );
}

function clearSecretInputs() {
  Object.values(elements.secretInputs).forEach((input) => {
    if (input) input.value = "";
  });
}

async function saveSecrets() {
  const api = getApi();
  if (!api || !elements.saveSecretsBtn) return;
  const updates = collectSecretUpdates();
  if (!Object.keys(updates).length) {
    if (elements.tickLog) {
      elements.tickLog.textContent += "\n[UI] No secret changes submitted.\n";
    }
    return;
  }

  elements.saveSecretsBtn.disabled = true;
  try {
    const status = await api.setSecrets(updates);
    clearSecretInputs();
    renderSecretStatus(status);
    if (elements.tickLog) {
      elements.tickLog.textContent += "\n[UI] Secure secret store updated.\n";
    }
  } catch (err) {
    if (elements.tickLog) {
      elements.tickLog.textContent += `\n[ERROR] ${err.message}\n`;
    }
  } finally {
    elements.saveSecretsBtn.disabled = false;
  }
}

async function loadData() {
  const api = getApi();
  if (!api) return;

  try {
    const {
      world,
      intents,
      state,
      history,
      portfolio,
      latestTick,
      tickLog,
      secretStatus,
    } = (await api.loadDashboardData()) || {};

    if (state && elements.nextTick) {
      elements.nextTick.textContent = state.current_mode || "INACTIVE";
      elements.nextTick.style.color = state.trading_enabled
        ? "var(--color-action)"
        : "var(--color-warning)";
      if (elements.tickMeta) {
        const lastRun = state.last_run_at
          ? new Date(state.last_run_at).toLocaleString([], {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: true,
              timeZone: EXCHANGE_TIME_ZONE,
            })
          : "Never";
        elements.tickMeta.textContent = `Last Run: ${lastRun}`;
      }
    }

    renderMacro(world);
    renderHUD(resolveHudSnapshot({ history, portfolio, latestTick }), state);
    renderIntents(intents);
    const positionSnapshot = resolvePositionSnapshot({
      history,
      portfolio,
      latestTick,
    });
    const holdingDates = buildHoldingDateMap(
      intents,
      positionSnapshot.positions,
    );
    renderPositions(positionSnapshot, holdingDates);
    renderSecretStatus(secretStatus);

    if (tickLog && elements.tickLog) {
      elements.tickLog.textContent = tickLog;
      elements.tickLog.scrollTop = elements.tickLog.scrollHeight;
    }
  } catch (err) {
    console.error("[UI] Sync error:", err);
  }
}

if (elements.refreshBtn) {
  elements.refreshBtn.addEventListener("click", loadData);
}

if (elements.saveSecretsBtn) {
  elements.saveSecretsBtn.addEventListener("click", saveSecrets);
}

if (elements.secretStatus) {
  elements.secretStatus.addEventListener("click", async (event) => {
    const target = event.target;
    const secretKey = target?.dataset?.secretKey;
    if (!secretKey) return;

    target.disabled = true;
    try {
      const api = getApi();
      if (!api) throw new Error("API Bridge not available");
      const status = await api.clearSecret(secretKey);
      renderSecretStatus(status);
      if (elements.tickLog) {
        elements.tickLog.textContent += `\n[UI] Cleared ${secretKey} from secure storage.\n`;
      }
    } catch (err) {
      if (elements.tickLog) {
        elements.tickLog.textContent += `\n[ERROR] ${err.message}\n`;
      }
    } finally {
      target.disabled = false;
    }
  });
}

if (elements.actionGrid) {
  elements.actionGrid.addEventListener("click", async (e) => {
    const target = e.target;
    const script = target?.getAttribute?.("data-script");
    if (!script) return;

    target.disabled = true;
    if (elements.tickLog) {
      elements.tickLog.textContent += `\n[UI] Spawning ${script}...\n`;
    }

    try {
      const api = getApi();
      if (!api) throw new Error("API Bridge not available");
      const res = await api.runAction(script);
      if (elements.tickLog) {
        elements.tickLog.textContent += res?.output || "";
      }
    } catch (err) {
      if (elements.tickLog) {
        elements.tickLog.textContent += `\n[ERROR] ${err.message}\n`;
      }
    } finally {
      target.disabled = false;
      loadData();
    }
  });
}

const topbar = document.querySelector(".topbar");
const trigger = document.getElementById("fullscreen-trigger");

if (trigger && topbar) {
  trigger.addEventListener("mouseenter", () => {
    if (document.body.classList.contains("fullscreen")) {
      topbar.classList.add("is-visible");
    }
  });

  topbar.addEventListener("mouseleave", () => {
    if (document.body.classList.contains("fullscreen")) {
      topbar.classList.remove("is-visible");
    }
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "F11") {
    document.body.classList.toggle("fullscreen");
    if (!document.body.classList.contains("fullscreen") && topbar) {
      topbar.classList.remove("is-visible");
    }
  }
});

loadData();
setInterval(loadData, 30000);

function renderRuntimeStatus(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  const phaseDay = snapshot.phase1Day ?? null;
  setText(
    "runtime-phase1",
    phaseDay ? `Day ${phaseDay} of 60` : "(not started)",
  );

  const missedDays = Array.isArray(snapshot.missedDays)
    ? snapshot.missedDays
    : [];
  setText(
    "runtime-missed",
    missedDays.length === 0
      ? "no missed days"
      : `${missedDays.length} missed: ${missedDays.join(", ")}`,
  );
  const missedEl = document.getElementById("runtime-missed");
  if (missedEl) {
    missedEl.style.color =
      missedDays.length > 0 ? "var(--color-warning, #fbbf24)" : "";
  }

  const op = snapshot.operational || {};
  setText("runtime-mode", op.mode ?? "?");
  setText(
    "runtime-executions",
    `executions today: ${op.executions_today ?? 0} · trading: ${
      op.trading_enabled ? "on" : "off"
    }`,
  );

  setText(
    "runtime-last-training",
    snapshot.lastTrainingAt
      ? snapshot.lastTrainingAt.slice(0, 19).replace("T", " ")
      : "(none yet)",
  );
  setText(
    "runtime-last-oos",
    snapshot.lastOosRollingSharpe === null
      ? "OOS Sharpe: (insufficient data)"
      : `OOS Sharpe: ${snapshot.lastOosRollingSharpe.toFixed(3)}`,
  );

  const pulseEl = document.getElementById("runtime-pulse");
  if (pulseEl) {
    const pulse = snapshot.pulse || {};
    pulseEl.innerHTML = "";
    for (const [name, ran] of Object.entries(pulse)) {
      const pill = document.createElement("span");
      pill.className = `pulse-pill ${ran ? "ok" : "miss"}`;
      pill.textContent = `${ran ? "✓" : "·"} ${name}`;
      pulseEl.appendChild(pill);
    }
  }
}

async function loadRuntimeStatus() {
  const api = getApi();
  if (!api?.loadRuntimeStatus) return;
  try {
    const result = await api.loadRuntimeStatus();
    if (result?.ok && result.snapshot) {
      renderRuntimeStatus(result.snapshot);
      const indicator = document.getElementById("runtime-refresh-indicator");
      if (indicator) {
        const ts = new Date().toLocaleTimeString();
        indicator.textContent = `(last updated ${ts} · refreshes every 30s)`;
      }
    }
  } catch {
    // Silent — runtime panel is informational; don't break the rest of the UI.
  }
}

loadRuntimeStatus();
setInterval(loadRuntimeStatus, 30000);

if (typeof window !== "undefined") {
  window.__VS_RENDERER_TEST__ = {
    buildHoldingDateMap,
    collectSecretUpdates,
    computeTickerTravelWidth,
    normalizeTickerOffset,
    normalizePosition,
    resolvePositionSnapshot,
  };
}
