/**
 * Runtime status report.
 *
 * Produces a single human-readable snapshot of "what's Value Steward done
 * today / this week" by synthesizing existing log files. No invasive code
 * changes — only reads:
 *
 *   data/steward-state.json    operational mode + state
 *   data/world-health.json     world layer health
 *   data/portfolio-live.json   broker positions snapshot
 *   data/latest-tick.json      most recent tick artifact
 *   data/training-log.jsonl    ML trainer cycles
 *   data/oos-eval.jsonl        OOS evaluation history
 *   logs/intent_log.jsonl      decision audit trail
 *   File mtimes for cron pulse detection
 *
 * Modes:
 *   `--format=human` (default)  pretty-printed text for `npm run runtime:status`
 *   `--format=jsonl`            appends one snapshot line to data/runtime.log
 *
 * Wire to cron hourly to build a daily history in data/runtime.log.
 */

// Load .env first so this entrypoint never silently misses VS_*/credential
// env vars when run under cron (which provides a minimal environment).
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = process.cwd();
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function exchangeDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayName(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/New_York",
  });
}

function formatExchange(date) {
  return ET_FMT.format(date);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonlTail(filePath, limit = 50) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mtimeOrNull(filePath) {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return null;
  }
}

function ranToday(filePath, today) {
  const mtime = mtimeOrNull(filePath);
  if (!mtime) return { ran: false, mtime: null };
  return { ran: exchangeDate(mtime) === today, mtime };
}

function timeAgo(mtime) {
  if (!mtime) return "never";
  const secs = Math.floor((Date.now() - mtime.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function isMarketWeekday(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

let _holidayCache = null;
function loadMarketHolidays() {
  if (_holidayCache !== null) return _holidayCache;
  _holidayCache = new Set();
  try {
    const raw = fs.readFileSync(
      path.join(ROOT, "data", "market-holidays.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.holidays) ? parsed.holidays : [];
    for (const h of list) {
      if (typeof h === "string") _holidayCache.add(h.trim());
    }
  } catch {
    // No holiday file / parse error — fall back to weekday-only logic.
  }
  return _holidayCache;
}

// A trading day is a weekday that is not a market holiday. Keeps the runtime
// status (missed-day detection, Phase 1 day count) consistent with the
// scheduler's isTradingDay() so holidays like Memorial Day aren't reported
// as outages or counted toward the run.
function isTradingDayStr(dateStr) {
  if (!isMarketWeekday(dateStr)) return false;
  return !loadMarketHolidays().has(dateStr);
}

function listMissedTradingDays(phase1Start, today) {
  // Identify trading days (weekdays excluding market holidays) between
  // phase1Start and today that have no training-log entry.
  const trainingEntries = readJsonlTail(
    path.join(ROOT, "data", "training-log.jsonl"),
    500
  );
  const ranDays = new Set();
  for (const entry of trainingEntries) {
    const ts = entry?.ranAt;
    if (typeof ts === "string") ranDays.add(exchangeDate(new Date(ts)));
  }
  const missed = [];
  const start = new Date(`${phase1Start}T12:00:00Z`);
  const end = new Date(`${today}T12:00:00Z`);
  for (let t = start.getTime(); t < end.getTime(); t += 86400000) {
    const dStr = exchangeDate(new Date(t));
    if (!isTradingDayStr(dStr)) continue;
    if (!ranDays.has(dStr)) missed.push(dStr);
  }
  return missed;
}

function collectSnapshot() {
  const now = new Date();
  const today = exchangeDate(now);

  const state = readJsonSafe(path.join(ROOT, "data", "steward-state.json"), {});
  const policy = readJsonSafe(path.join(ROOT, "config", "policy.json"), {});
  const portfolio = readJsonSafe(
    path.join(ROOT, "data", "portfolio-live.json"),
    null
  );
  const latestTick = readJsonSafe(
    path.join(ROOT, "data", "latest-tick.json"),
    null
  );

  const trainingEntries = readJsonlTail(
    path.join(ROOT, "data", "training-log.jsonl"),
    25
  );
  const oosEntries = readJsonlTail(
    path.join(ROOT, "data", "oos-eval.jsonl"),
    10
  );
  const intentEntries = readJsonlTail(
    path.join(ROOT, "logs", "intent_log.jsonl"),
    25
  );

  const pulseFiles = {
    "world:run": "data/world-context.jsonl",
    "portfolio:refresh": "data/portfolio-live.json",
    "intraday:observe": "data/intraday-signal-snapshot.json",
    "world:health": "data/world-health.json",
    "local:tick": "data/latest-tick.json",
    "eod:run": "data/eod-state.json",
  };
  const pulse = {};
  for (const [name, rel] of Object.entries(pulseFiles)) {
    const { ran, mtime } = ranToday(path.join(ROOT, rel), today);
    pulse[name] = { ran, mtime };
  }

  const phase1Start = state.phase1_start_date || null;
  const missedDays = phase1Start
    ? listMissedTradingDays(phase1Start, today)
    : [];

  // Phase 1 day count (trading days since start, inclusive — excludes
  // weekends AND market holidays so the count matches actual run progress).
  let phase1Day = null;
  if (phase1Start) {
    const start = new Date(`${phase1Start}T12:00:00Z`);
    const end = new Date(`${today}T12:00:00Z`);
    let count = 0;
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      if (isTradingDayStr(exchangeDate(new Date(t)))) count += 1;
    }
    phase1Day = count;
  }

  const emailHealth = readJsonSafe(
    path.join(ROOT, "data", "email-health.json"),
    {}
  );

  const pushHealth = readJsonSafe(
    path.join(ROOT, "data", "push-health.json"),
    {}
  );

  return {
    generatedAt: now.toISOString(),
    exchangeNow: formatExchange(now),
    today,
    todayName: dayName(today),
    state,
    policy,
    portfolio,
    latestTick,
    trainingEntries,
    oosEntries,
    intentEntries,
    pulse,
    emailHealth,
    pushHealth,
    phase1Start,
    phase1Day,
    missedDays,
  };
}

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function renderHuman(snap) {
  const lines = [];
  lines.push("=== Value Steward Runtime Status ===");
  lines.push(`Generated:         ${snap.exchangeNow} ET`);
  lines.push(`Exchange date:     ${snap.today} (${snap.todayName})`);
  if (snap.phase1Day && snap.phase1Start) {
    lines.push(
      `Phase 1:           Day ${snap.phase1Day} (started ${snap.phase1Start})`
    );
  }
  if (snap.missedDays.length) {
    lines.push(
      `Missed days:       ${snap.missedDays.length} — ${snap.missedDays.join(", ")}`
    );
  }
  lines.push("");

  lines.push("System Pulse (cron activity today):");
  for (const [name, info] of Object.entries(snap.pulse)) {
    const marker = info.ran ? "✓" : "·";
    const when = info.mtime
      ? `${formatExchange(info.mtime)} (${timeAgo(info.mtime)})`
      : "never";
    lines.push(`  ${marker} ${name.padEnd(22)} ${when}`);
  }
  lines.push("");

  const st = snap.state;
  lines.push("Operational State:");
  lines.push(`  current_mode:    ${st.current_mode ?? "?"}`);
  lines.push(`  trading_enabled: ${st.trading_enabled ?? "?"}`);
  lines.push(`  force_no_trade:  ${st.force_no_trade ?? "?"}`);
  lines.push(`  executions_today: ${st.executions_today ?? 0}`);
  lines.push(`  last_executed:   ${st.last_executed_at ?? "never"}`);
  lines.push(`  daily_starting_equity: ${fmtUsd(st.daily_starting_equity)}`);
  lines.push("");

  if (snap.portfolio) {
    lines.push("Portfolio (from latest portfolio:refresh):");
    const equity = snap.portfolio.equity ?? snap.portfolio.account?.equity;
    const cash = snap.portfolio.cash ?? snap.portfolio.account?.cash;
    const positions = snap.portfolio.positions || [];
    if (equity) lines.push(`  equity:    ${fmtUsd(Number(equity))}`);
    if (cash) lines.push(`  cash:      ${fmtUsd(Number(cash))}`);
    lines.push(`  positions: ${positions.length}`);
    for (const pos of positions.slice(0, 5)) {
      const sym = pos.symbol || "?";
      const qty = pos.quantity ?? pos.qty ?? "?";
      const mv = pos.market_value ?? pos.marketValue;
      lines.push(`    - ${sym} qty=${qty} mv=${fmtUsd(Number(mv))}`);
    }
    lines.push("");
  }

  lines.push(`Recent Trades (last 5 BUY/SELL):`);
  const trades = snap.intentEntries
    .filter((e) =>
      ["BUY", "SELL", "MULTI"].includes(String(e?.action_type))
    )
    .slice(-5);
  if (trades.length === 0) {
    lines.push("  (none in window)");
  } else {
    for (const t of trades) {
      const ts = (t.timestamp || "").slice(0, 19);
      lines.push(
        `  ${ts}  ${(t.action_type ?? "?").padEnd(5)}  ${(t.symbol ?? "-").padEnd(6)}  ${t.reason_code ?? ""}`
      );
    }
  }
  lines.push("");

  lines.push("Recent Blocks (last 5 BUY_BLOCKED):");
  const blocks = snap.intentEntries
    .filter(
      (e) => e?.action_type === "NO_ACTION" && /^BUY_/.test(e?.reason_code || "")
    )
    .slice(-5);
  if (blocks.length === 0) {
    lines.push("  (none in window)");
  } else {
    for (const b of blocks) {
      const ts = (b.timestamp || "").slice(0, 19);
      const sym = b.signal_symbol || b.symbol || "-";
      lines.push(`  ${ts}  ${sym.padEnd(6)}  ${b.reason_code ?? ""}`);
    }
  }
  lines.push("");

  lines.push("ML Training (last 5 cycles, each source):");
  const recent = snap.trainingEntries.slice(-15);
  for (const e of recent.slice(-5)) {
    const ts = (e.ranAt || "").slice(0, 19);
    const src = (e.source ?? "?").padEnd(24);
    lines.push(`  ${ts}  ${src}  ${e.decision ?? "?"}  ${e.reason ?? ""}`);
  }
  lines.push("");

  lines.push("OOS Evaluation (last 3 cycles):");
  for (const e of snap.oosEntries.slice(-3)) {
    const ts = (e.evaluatedAt || "").slice(0, 19);
    const rolling = e.rolling || {};
    const sharpe =
      typeof rolling.sharpe === "number"
        ? rolling.sharpe.toFixed(3)
        : "null";
    lines.push(
      `  ${ts}  pv=${(e.policyVersion ?? "?").toString().padStart(3)}  ` +
        `rolling_n=${(rolling.sampleCount ?? 0)
          .toString()
          .padStart(3)}  sharpe=${sharpe}`
    );
  }
  if (snap.oosEntries.length === 0) lines.push("  (no entries)");
  lines.push("");

  // Email health — surfaces silent SMTP failures (the only prior alarm for
  // broken email was email itself).
  lines.push("Email Health:");
  const eh = snap.emailHealth || {};
  const ehKeys = Object.keys(eh);
  if (ehKeys.length === 0) {
    lines.push("  (no send attempts recorded yet)");
  } else {
    for (const key of ehKeys.sort()) {
      const rec = eh[key] || {};
      const outcome = rec.last_outcome === "ok" ? "✓ ok" : "✗ ERROR";
      const attempt = rec.last_attempt_at
        ? `${formatExchange(new Date(rec.last_attempt_at))} (${timeAgo(new Date(rec.last_attempt_at))})`
        : "never";
      lines.push(`  ${outcome.padEnd(8)} ${key.padEnd(24)} ${attempt}`);
      if (rec.last_outcome === "error" && rec.last_error) {
        lines.push(`           └─ ${rec.last_error}`);
      }
    }
  }
  lines.push("");

  // Push health — surfaces silent ntfy failures (same single-point-of-failure
  // reasoning as email health).
  lines.push("Push Health:");
  const ph = snap.pushHealth || {};
  const phKeys = Object.keys(ph);
  if (phKeys.length === 0) {
    lines.push("  (no send attempts recorded yet)");
  } else {
    for (const key of phKeys.sort()) {
      const rec = ph[key] || {};
      const outcome = rec.last_outcome === "ok" ? "✓ ok" : "✗ ERROR";
      const attempt = rec.last_attempt_at
        ? `${formatExchange(new Date(rec.last_attempt_at))} (${timeAgo(new Date(rec.last_attempt_at))})`
        : "never";
      lines.push(`  ${outcome.padEnd(8)} ${key.padEnd(24)} ${attempt}`);
      if (rec.last_outcome === "error" && rec.last_error) {
        lines.push(`           └─ ${rec.last_error}`);
      }
    }
  }
  lines.push("");

  // Concise feature-flag status
  lines.push("ML Feature Flags:");
  const flags = [
    ["VS_SIGNAL_WEIGHT_LEARN", "weight learning", "on"],
    ["VS_OOS_EVAL_ENABLED", "OOS eval", "on"],
    ["VS_CHAMPION_CHALLENGER_ENABLED", "champion-challenger", "off"],
    ["VS_SCORE_GATE_THOMPSON_ENABLED", "Thompson sampling", "off"],
    ["VS_NEW_ENTRY_EXPLORATION_EPSILON", "epsilon-greedy ε", "0.0"],
  ];
  for (const [envKey, label, defaultVal] of flags) {
    const val = process.env[envKey] ?? defaultVal;
    lines.push(`  ${label.padEnd(22)} ${val}`);
  }

  return lines.join("\n");
}

function renderJsonl(snap) {
  // Compact one-line snapshot for the historical runtime.log.
  const trades = snap.intentEntries.filter((e) =>
    ["BUY", "SELL", "MULTI"].includes(String(e?.action_type))
  );
  const blocks = snap.intentEntries.filter(
    (e) =>
      e?.action_type === "NO_ACTION" && /^BUY_/.test(e?.reason_code || "")
  );
  const lastTraining = snap.trainingEntries.at(-1) || null;
  const lastOos = snap.oosEntries.at(-1) || null;

  const compact = {
    generatedAt: snap.generatedAt,
    today: snap.today,
    phase1Day: snap.phase1Day,
    missedDays: snap.missedDays,
    pulse: Object.fromEntries(
      Object.entries(snap.pulse).map(([k, v]) => [k, v.ran])
    ),
    operational: {
      mode: snap.state.current_mode ?? null,
      trading_enabled: snap.state.trading_enabled ?? null,
      executions_today: snap.state.executions_today ?? 0,
    },
    counts: {
      recent_trades: trades.length,
      recent_blocks: blocks.length,
      recent_training_cycles: snap.trainingEntries.length,
      recent_oos_evals: snap.oosEntries.length,
    },
    lastTrainingAt: lastTraining?.ranAt ?? null,
    lastOosRollingSharpe:
      typeof lastOos?.rolling?.sharpe === "number"
        ? lastOos.rolling.sharpe
        : null,
    emailHealth: Object.fromEntries(
      Object.entries(snap.emailHealth || {}).map(([k, v]) => [
        k,
        v?.last_outcome ?? null,
      ])
    ),
    emailAnyError: Object.values(snap.emailHealth || {}).some(
      (v) => v?.last_outcome === "error"
    ),
  };
  return JSON.stringify(compact);
}

function parseArgs(argv) {
  const args = { format: "human", append: false, watchSeconds: 0 };
  for (const a of argv) {
    if (a.startsWith("--format=")) args.format = a.slice("--format=".length);
    else if (a === "--append") args.append = true;
    else if (a.startsWith("--watch=")) {
      const n = Number(a.slice("--watch=".length));
      if (Number.isFinite(n) && n > 0) args.watchSeconds = Math.max(1, Math.floor(n));
    } else if (a === "--watch") {
      args.watchSeconds = 10; // default refresh cadence
    }
  }
  return args;
}

function renderOnce(format) {
  const snap = collectSnapshot();
  if (format === "jsonl") {
    return { snap, output: renderJsonl(snap) };
  }
  return { snap, output: renderHuman(snap) };
}

// ANSI: move cursor home + clear screen below. Doesn't touch scrollback so
// users can scroll up to see earlier renders.
const CLEAR = "\x1b[H\x1b[J";

async function runWatchLoop(format, seconds) {
  // Hide cursor while watching for cleaner output, restore on exit.
  process.stdout.write("\x1b[?25l");
  const restore = () => {
    process.stdout.write("\x1b[?25h\n");
  };
  process.on("SIGINT", () => {
    restore();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(0);
  });

  // eslint-disable-next-line no-constant-condition -- intentional watch loop; exits via SIGINT/SIGTERM above
  while (true) {
    const { output } = renderOnce(format);
    const banner = `(watch mode — refreshing every ${seconds}s, ctrl+c to exit)\n`;
    process.stdout.write(CLEAR + banner + output + "\n");
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

export function runRuntimeStatus(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.watchSeconds > 0) {
    return runWatchLoop(args.format, args.watchSeconds);
  }
  const { snap, output } = renderOnce(args.format);
  if (args.format === "jsonl" && args.append) {
    fs.appendFileSync(path.join(ROOT, "data", "runtime.log"), `${output}\n`);
  } else {
    console.log(output);
  }
  return snap;
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runRuntimeStatus();
}
