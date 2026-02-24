const api = window.valueSteward;
const EXCHANGE_TZ = "America/New_York";

const elements = {
  policySummary: document.getElementById("policy-summary"),
  policyRisk: document.getElementById("policy-risk"),
  policyTarget: document.getElementById("policy-target"),
  policyBuffer: document.getElementById("policy-buffer"),
  policyForceNoTrade: document.getElementById("policy-force-no-trade"),
  savePolicy: document.getElementById("save-policy"),
  policyStatus: document.getElementById("policy-status"),
  worldSummary: document.getElementById("world-summary"),
  worldTags: document.getElementById("world-tags"),
  worldSources: document.getElementById("world-sources"),
  marketSummary: document.getElementById("market-summary"),
  marketPositions: document.getElementById("market-positions"),
  trainingSummary: document.getElementById("training-summary"),
  rssTicker: document.getElementById("rss-ticker"),
  tickLog: document.getElementById("tick-log"),
  tickLogMeta: document.getElementById("tick-log-meta"),
  nextTick: document.getElementById("next-tick"),
  tickCountdown: document.getElementById("tick-countdown"),
  tickMeta: document.getElementById("tick-meta"),
  dataStatus: document.getElementById("data-status"),
  refreshData: document.getElementById("refresh-data"),
  refreshStatus: document.getElementById("refresh-status"),
};

function formatPercent(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "n/a";
  if (Number.isNaN(Number(value))) return "n/a";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(value) {
  if (!value) return "n/a";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

function getOffsetMinutesForTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const offsetPart = parts.find((part) => part.type === "timeZoneName");
  const value = offsetPart?.value ?? "GMT+0";
  const match = value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

function getExchangeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EXCHANGE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: map.weekday,
  };
}

function makeDateInExchangeTz(components) {
  const offsetMinutes = getOffsetMinutesForTz(new Date(), EXCHANGE_TZ);
  const utcMs =
    Date.UTC(
      components.year,
      components.month - 1,
      components.day,
      components.hour,
      components.minute,
      0,
      0
    ) - offsetMinutes * 60 * 1000;
  return new Date(utcMs);
}

function isWeekendShort(weekday) {
  return weekday === "Sat" || weekday === "Sun";
}

function getNextTickTime(now = new Date()) {
  const parts = getExchangeParts(now);
  const isWeekend = isWeekendShort(parts.weekday);
  const start = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 9,
    minute: 30,
  };
  const end = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 16,
    minute: 0,
  };

  function nextWeekdayDate(base) {
    const date = new Date(base);
    do {
      date.setDate(date.getDate() + 1);
    } while (isWeekendShort(getExchangeParts(date).weekday));
    const nextParts = getExchangeParts(date);
    return {
      year: nextParts.year,
      month: nextParts.month,
      day: nextParts.day,
      hour: 9,
      minute: 30,
    };
  }

  const nowExchange = makeDateInExchangeTz(parts);
  const startDate = makeDateInExchangeTz(start);
  const endDate = makeDateInExchangeTz(end);

  if (isWeekend) {
    return makeDateInExchangeTz(nextWeekdayDate(nowExchange));
  }

  if (nowExchange < startDate) {
    return startDate;
  }

  if (nowExchange >= endDate) {
    return makeDateInExchangeTz(nextWeekdayDate(nowExchange));
  }

  const minutesSinceStart = Math.floor((nowExchange - startDate) / (1000 * 60));
  const nextQuarter = Math.floor(minutesSinceStart / 15) * 15 + 15;
  const next = new Date(startDate);
  next.setMinutes(startDate.getMinutes() + nextQuarter, 0, 0);
  if (next > endDate) {
    return makeDateInExchangeTz(nextWeekdayDate(nowExchange));
  }
  return next;
}

function updateCountdown() {
  const now = new Date();
  const next = getNextTickTime(now);
  const diffMs = next - now;
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const minutes = String(Math.floor(diffSeconds / 60)).padStart(2, "0");
  const seconds = String(diffSeconds % 60).padStart(2, "0");
  const formatter = new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: EXCHANGE_TZ,
  });
  const dateFormatter = new Intl.DateTimeFormat([], { timeZone: EXCHANGE_TZ });
  elements.nextTick.textContent = formatter.format(next);
  elements.tickCountdown.textContent =
    Number.isFinite(diffSeconds) ? `${minutes}:${seconds}` : "--:--";
  elements.tickMeta.textContent = `${dateFormatter.format(next)} · ${EXCHANGE_TZ}`;
}

function renderPolicy(policy) {
  const items = [
    ["Version", policy?.version ?? "n/a"],
    ["Mode", policy?.mode ?? "n/a"],
    ["Risk Level", formatPercent(policy?.risk_level)],
    ["Target Exposure", formatPercent(policy?.target_risk_exposure_pct_low)],
    ["Buffer", formatPercent(policy?.rebalance_buffer_pct)],
    [
      "Force No-Trade",
      policy?.trade_gate_overrides?.force_no_trade ? "true" : "false",
    ],
    ["Last Trained", formatDate(policy?.lastTrainedAt)],
    ["Last Equity Δ", formatNumber(policy?.lastEquityDelta)],
  ];

  elements.policySummary.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="policy-item"><span>${label}</span><strong>${value}</strong></div>`
    )
    .join("");

  elements.policyRisk.value = policy?.risk_level ?? "";
  elements.policyTarget.value = policy?.target_risk_exposure_pct_low ?? "";
  elements.policyBuffer.value = policy?.rebalance_buffer_pct ?? "";
  elements.policyForceNoTrade.checked = Boolean(
    policy?.trade_gate_overrides?.force_no_trade
  );
}

function renderWorld(world) {
  if (!world) {
    elements.worldSummary.textContent = "No world context available.";
    elements.worldTags.innerHTML = "";
    elements.worldSources.innerHTML = "";
    return;
  }
  const macro = world.macro_view ?? {};
  elements.worldSummary.innerHTML = `
    <div>Date: ${world.date ?? "n/a"} (slot: ${world.slot ?? "n/a"})</div>
    <div>Generated: ${formatDate(world.generated_at)}</div>
    <div>Macro: ${macro.macro_label ?? "n/a"} (score ${formatNumber(
      macro.macro_score
    )})</div>
    <div>Confidence: ${formatNumber(macro.confidence)}</div>
    <div>Sources: ${world.sources_used?.length ?? 0} | Raw count: ${
    world.raw_count ?? 0
  }</div>
  `;

  const tags = world.tags || {};
  elements.worldTags.innerHTML = Object.entries(tags)
    .map(([key, value]) => {
      const display = value === null || value === undefined ? "n/a" : value.toFixed(2);
      return `<div class="tag">${key}: ${display}</div>`;
    })
    .join("");

  const sources = world.sources_used || [];
  elements.worldSources.innerHTML = sources.length
    ? sources.map((source) => `<div>${source}</div>`).join("")
    : "<div>No sources recorded.</div>";
}

function renderMarket(snapshot) {
  if (!snapshot) {
    elements.marketSummary.textContent = "No market snapshot available.";
    elements.marketPositions.innerHTML = "";
    return;
  }
  elements.marketSummary.innerHTML = `
    <div>Equity: $${formatNumber(snapshot.equity)}</div>
    <div>Cash: $${formatNumber(snapshot.cash)}</div>
    <div>Buying Power: $${formatNumber(snapshot.buyingPower)}</div>
    <div>Exposure: ${formatPercent(snapshot.grossExposure / snapshot.portfolioValue || 0)}</div>
    <div>Market Open: ${snapshot.marketOpen ? "true" : "false"}</div>
    <div>Last Tick: ${formatDate(snapshot.ranAt)}</div>
  `;

  const positions = snapshot.positions || [];
  if (!positions.length) {
    elements.marketPositions.innerHTML = "<div>No positions.</div>";
    return;
  }
  elements.marketPositions.innerHTML = positions
    .slice(0, 8)
    .map(
      (pos) =>
        `<div>${pos.symbol}: ${formatNumber(pos.qty)} @ $${formatNumber(
          pos.marketValue
        )} (${pos.side})</div>`
    )
    .join("");
}

function renderTraining(entry) {
  if (!entry) {
    elements.trainingSummary.textContent = "No training log entries.";
    return;
  }
  elements.trainingSummary.innerHTML = `
    <div>Ran At: ${formatDate(entry.ranAt)}</div>
    <div>Decision: ${entry.decision ?? "n/a"} (${entry.reason ?? "n/a"})</div>
    <div>Risk: ${formatPercent(entry.oldRisk)} → ${formatPercent(entry.newRisk)}</div>
    <div>Policy Version: ${entry.policyVersionAfter ?? "n/a"}</div>
  `;
}

function renderRss(entries) {
  if (!entries.length) {
    elements.rssTicker.innerHTML = "<div>No RSS entries yet.</div>";
    return;
  }
  const sorted = entries
    .slice()
    .sort((a, b) => Date.parse(b.published ?? b.ts) - Date.parse(a.published ?? a.ts))
    .slice(0, 15);

  elements.rssTicker.innerHTML = sorted
    .map(
      (entry) => `
        <div class="ticker-item">
          <strong>${entry.title ?? "(no title)"}</strong>
          <span>${entry.source_id ?? "unknown"} · ${formatDate(
        entry.published ?? entry.ts
      )}</span>
          ${
            entry.link
              ? `<a href="#" class="rss-link" data-link="${entry.link}">Open Article</a>`
              : ""
          }
        </div>
      `
    )
    .join("");
}

function renderTickLog(logText, stats) {
  elements.tickLog.textContent = logText || "No tick log found.";
  if (!stats) {
    elements.tickLogMeta.textContent = "No tick log metadata.";
    return;
  }
  elements.tickLogMeta.textContent = `Last updated: ${formatDate(
    stats.mtime
  )} (${formatNumber(stats.size)} bytes)`;
}

function renderDataStatus(statuses) {
  const rows = statuses.map(
    (row) =>
      `<div>${row.label}: ${row.exists ? "ok" : "missing"} · last ${
        row.mtime ? formatDate(row.mtime) : "n/a"
      } · ${formatNumber(row.size)} bytes</div>`
  );
  elements.dataStatus.innerHTML = rows.join("");
}

function loadData() {
  const policy = api.readJson("config/policy.json");
  const world = api.readJsonlLatest("data/world-context.jsonl");
  const history = api.readJsonlLatest("data/history.jsonl");
  const training = api.readJsonlLatest("data/training-log.jsonl");
  const inbox = api.readJsonl("data/world-inbox.jsonl", 200);
  const tickLog = api.readText("logs/tick.log", 200 * 1024);
  const tickLogStats = api.stat("logs/tick.log");
  const files = [
    { label: "policy.json", path: "config/policy.json" },
    { label: "history.jsonl", path: "data/history.jsonl" },
    { label: "training-log.jsonl", path: "data/training-log.jsonl" },
    { label: "world-context.jsonl", path: "data/world-context.jsonl" },
    { label: "world-inbox.jsonl", path: "data/world-inbox.jsonl" },
    { label: "tick.log", path: "logs/tick.log" },
  ];
  const status = files.map((file) => {
    const stat = api.stat(file.path);
    return {
      label: file.label,
      exists: Boolean(stat),
      mtime: stat?.mtime ?? null,
      size: stat?.size ?? 0,
    };
  });

  renderPolicy(policy);
  renderWorld(world);
  renderMarket(history);
  renderTraining(training);
  renderRss(inbox);
  renderTickLog(tickLog, tickLogStats);
  renderDataStatus(status);
}

function handleSavePolicy() {
  const update = {
    risk_level: Number(elements.policyRisk.value),
    target_risk_exposure_pct_low: Number(elements.policyTarget.value),
    rebalance_buffer_pct: Number(elements.policyBuffer.value),
    trade_gate_overrides: {
      force_no_trade: elements.policyForceNoTrade.checked,
    },
  };
  const saved = api.writePolicy(update);
  elements.policyStatus.textContent = `Saved @ ${new Date().toLocaleTimeString()}`;
  renderPolicy(saved);
}

elements.savePolicy.addEventListener("click", handleSavePolicy);
elements.refreshData.addEventListener("click", () => {
  loadData();
  elements.refreshStatus.textContent = `Refreshed @ ${new Date().toLocaleTimeString()}`;
});
elements.rssTicker.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const link = target.getAttribute("data-link");
  if (!link) return;
  event.preventDefault();
  api.openExternal(link);
});

loadData();
updateCountdown();
setInterval(updateCountdown, 1000);
setInterval(loadData, 30000);

function updateFullscreenState() {
  const isFullscreen =
    window.innerHeight >= screen.availHeight - 2 ||
    window.outerHeight >= screen.availHeight - 2;
  document.body.classList.toggle("fullscreen", isFullscreen);
  return isFullscreen;
}

const topbar = document.getElementById("topbar");
const menuHandle = document.getElementById("menu-handle");

function showTopbar() {
  if (!topbar) return;
  topbar.classList.add("is-visible");
}

function hideTopbar() {
  if (!topbar) return;
  topbar.classList.remove("is-visible");
}

if (menuHandle) {
  menuHandle.addEventListener("mouseenter", showTopbar);
}
if (topbar) {
  topbar.addEventListener("mouseleave", hideTopbar);
  topbar.addEventListener("mouseenter", showTopbar);
}

window.addEventListener("resize", updateFullscreenState);
updateFullscreenState();

window.addEventListener("mousemove", (event) => {
  const isFullscreen = updateFullscreenState();
  if (!isFullscreen) return;
  if (event.clientY <= 6) {
    showTopbar();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "m") {
    if (!topbar) return;
    topbar.classList.toggle("is-visible");
  }
});
