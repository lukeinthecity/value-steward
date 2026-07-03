import fs from "fs";
import path from "path";

function dataDir() {
  return path.join(process.cwd(), "data");
}

export function getLatestTickPath() {
  return path.join(dataDir(), "latest-tick.json");
}

export function getPortfolioLivePath() {
  return path.join(dataDir(), "portfolio-live.json");
}

export function getHistoryPath() {
  return path.join(dataDir(), "history.jsonl");
}

export function getIntradayObservationsPath() {
  return path.join(dataDir(), "intraday-observations.jsonl");
}

export function getIntradaySignalSnapshotPath() {
  return path.join(dataDir(), "intraday-signal-snapshot.json");
}

export function getTrainingLogPath() {
  return path.join(dataDir(), "training-log.jsonl");
}

export function getPolicyPath() {
  return path.join(process.cwd(), "config", "policy.json");
}

export function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readLatestJsonl(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;
  const lines = raw.split("\n").filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
  return payload;
}

export function writeJsonlAtomic(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = (entries ?? []).map((entry) => JSON.stringify(entry));
  const data = lines.length ? `${lines.join("\n")}\n` : "";
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
  return entries ?? [];
}

export function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  fs.writeFileSync(tmpPath, text);
  fs.renameSync(tmpPath, filePath);
  return text;
}

export function appendJsonlLineSync(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function buildArtifactCycleId({
  exchangeDate,
  worldContextGeneratedAt,
  worldContextSlot = null,
} = {}) {
  if (!exchangeDate || !worldContextGeneratedAt) return null;
  const normalizedDate = String(exchangeDate).trim();
  const normalizedTs = String(worldContextGeneratedAt).trim();
  const normalizedSlot = worldContextSlot
    ? String(worldContextSlot).trim()
    : "";
  return normalizedSlot
    ? `${normalizedDate}:${normalizedSlot}:${normalizedTs}`
    : `${normalizedDate}:${normalizedTs}`;
}

export function getArtifactCycleId(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.cycle_id ??
    payload.cycleId ??
    payload.result?.cycle_id ??
    payload.result?.cycleId ??
    null
  );
}

export function assertMatchingCycleIds(entries) {
  const labeled = (entries ?? []).map((entry) => ({
    label: entry?.label ?? "artifact",
    cycleId: entry?.cycleId ?? getArtifactCycleId(entry?.payload),
  }));

  if (!labeled.length) {
    throw new Error("Artifact cycle provenance unavailable.");
  }

  const missing = labeled.filter((entry) => !entry.cycleId);
  if (missing.length) {
    throw new Error(
      `Artifact cycle provenance missing for: ${missing
        .map((entry) => entry.label)
        .join(", ")}.`,
    );
  }

  const expected = labeled[0].cycleId;
  const mismatches = labeled.filter((entry) => entry.cycleId !== expected);
  if (mismatches.length) {
    throw new Error(
      `Artifact cycle mismatch: expected ${expected}, got ${mismatches
        .map((entry) => `${entry.label}=${entry.cycleId}`)
        .join(", ")}.`,
    );
  }

  return expected;
}

export function loadPolicySnapshot() {
  return readJson(getPolicyPath());
}

export function loadLatestTickSnapshot() {
  return readJson(getLatestTickPath());
}

export function saveLatestTickSnapshot(payload) {
  return writeJsonAtomic(getLatestTickPath(), payload);
}

export function loadLatestTrainingEntry() {
  return readLatestJsonl(getTrainingLogPath());
}

export function loadPortfolioLiveSnapshot() {
  return readJson(getPortfolioLivePath());
}

function normalizeHistoryPosition(position) {
  return {
    symbol: position?.symbol ?? null,
    qty: position?.qty ?? position?.quantity ?? null,
    side: position?.side ?? null,
    marketValue: position?.marketValue ?? position?.market_value ?? null,
    avgEntryPrice: position?.avgEntryPrice ?? position?.avg_entry_price ?? null,
    unrealizedPl: position?.unrealizedPl ?? position?.unrealized_pl ?? null,
    unrealizedPlPc:
      position?.unrealizedPlPc ?? position?.unrealized_plpc ?? null,
    assetClass: position?.assetClass ?? position?.asset_class ?? null,
  };
}

export function buildHistoryEntryFromTickResult({
  exchangeDate,
  generatedAt = null,
  cycleId = null,
  policy = null,
  result,
}) {
  return {
    ranAt: result?.ranAt ?? generatedAt,
    generated_at: generatedAt,
    exchange_date: exchangeDate ?? null,
    cycle_id: cycleId ?? result?.cycle_id ?? null,
    mode: result?.mode ?? policy?.mode ?? null,
    agentMode: result?.agentMode ?? null,
    snapshotStatus: result?.snapshotStatus ?? null,
    accountStatus: result?.accountStatus ?? null,
    marketOpen:
      typeof result?.marketOpen === "boolean" ? result.marketOpen : null,
    equity: result?.equity ?? null,
    buyingPower: result?.buyingPower ?? null,
    cash: result?.cash ?? null,
    portfolioValue: result?.portfolioValue ?? null,
    risk_level: result?.risk_level ?? policy?.risk_level ?? null,
    cashUtilization: result?.cashUtilization ?? null,
    grossExposure: result?.grossExposure ?? null,
    netExposure: result?.netExposure ?? null,
    maxPositionWeight: result?.maxPositionWeight ?? null,
    numPositions: result?.numPositions ?? 0,
    positions: Array.isArray(result?.positions)
      ? result.positions.map(normalizeHistoryPosition)
      : [],
  };
}

export function appendHistoryEntry(payload) {
  appendJsonlLineSync(getHistoryPath(), payload);
}

export function appendIntradayObservation(payload) {
  appendJsonlLineSync(getIntradayObservationsPath(), payload);
}

export function loadIntradayObservations(exchangeDate = null) {
  const rows = readJsonl(getIntradayObservationsPath());
  if (!exchangeDate) return rows;
  return rows.filter((row) => row?.exchange_date === exchangeDate);
}

function parseDateMs(value) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function toExchangeDate(value) {
  const ms = parseDateMs(value);
  if (ms === null) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function orderSortTimestamp(order) {
  return (
    parseDateMs(order?.filled_at) ??
    parseDateMs(order?.submitted_at) ??
    parseDateMs(order?.created_at) ??
    null
  );
}

function normalizeOrderStatus(status) {
  return String(status ?? "")
    .trim()
    .toLowerCase();
}

function isExecutedOrder(order) {
  const status = normalizeOrderStatus(order?.status);
  return (
    Boolean(order?.filled_at) ||
    status === "filled" ||
    status === "partially_filled"
  );
}

export function extractLatestOrderFromPortfolioSnapshot(
  portfolio,
  { exchangeDate = null, requireExecuted = true } = {},
) {
  const directLastOrder = portfolio?.last_order ? [portfolio.last_order] : [];
  const recentOrders = Array.isArray(portfolio?.recent_orders)
    ? portfolio.recent_orders
    : [];
  const fallbackOpenOrders = Array.isArray(portfolio?.open_orders)
    ? portfolio.open_orders
    : [];
  const orders = [...directLastOrder, ...recentOrders, ...fallbackOpenOrders];

  const candidates = orders
    .map((order) => ({
      ...order,
      _sortTimestamp: orderSortTimestamp(order),
      _exchangeDate:
        toExchangeDate(order?.filled_at) ?? toExchangeDate(order?.submitted_at),
    }))
    .filter((order) => order._sortTimestamp !== null)
    .filter((order) => (requireExecuted ? isExecutedOrder(order) : true))
    .filter((order) =>
      exchangeDate ? order._exchangeDate === exchangeDate : true,
    )
    .sort((a, b) => b._sortTimestamp - a._sortTimestamp);

  if (!candidates.length) return null;

  const latest = { ...candidates[0] };
  delete latest._sortTimestamp;
  delete latest._exchangeDate;
  return latest;
}
