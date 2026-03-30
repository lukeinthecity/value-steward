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

export function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
  return payload;
}

export function appendJsonlLineSync(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  try {
    const line = `${JSON.stringify(entry)}\n`;
    fs.writeSync(fd, line, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

export function buildArtifactCycleId({
  exchangeDate,
  slot = null,
  sourceTimestamp = null,
} = {}) {
  if (!exchangeDate || !sourceTimestamp) return null;
  const normalizedSlot = slot ? String(slot).trim() : "unspecified";
  return `${exchangeDate}:${normalizedSlot}:${sourceTimestamp}`;
}

export function getArtifactCycleId(artifact) {
  return artifact?.cycle_id ?? artifact?.result?.cycle_id ?? null;
}

export function assertMatchingCycleIds(pairs = []) {
  const present = pairs.filter((pair) => pair?.cycleId);
  if (present.length <= 1) {
    return {
      ok: true,
      expectedCycleId: present[0]?.cycleId ?? null,
      mismatches: [],
    };
  }

  const expectedCycleId = present[0].cycleId;
  const mismatches = present.filter((pair) => pair.cycleId !== expectedCycleId);
  return {
    ok: mismatches.length === 0,
    expectedCycleId,
    mismatches: mismatches.map((pair) => ({
      label: pair.label,
      cycleId: pair.cycleId,
    })),
  };
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
  { exchangeDate = null, requireExecuted = true } = {}
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
      exchangeDate ? order._exchangeDate === exchangeDate : true
    )
    .sort((a, b) => b._sortTimestamp - a._sortTimestamp);

  if (!candidates.length) return null;

  const latest = { ...candidates[0] };
  delete latest._sortTimestamp;
  delete latest._exchangeDate;
  return latest;
}
