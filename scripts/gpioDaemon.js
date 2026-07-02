import fs from "fs";
import path from "path";

import { applyGpioStateToControl, loadGpioState } from "../core/gpioBridge.js";
import { loadStateSync } from "../core/stewardState.js";
import { getTradingEnabled } from "../core/tradingEnabled.js";
import { buildHealthSnapshot } from "../core/healthStatus.js";
import { getMarketTimeZone } from "../core/timeUtils.js";
import { fileURLToPath } from "url";

const DEFAULT_GPIO_PATH = path.join(process.cwd(), "data", "gpio-state.json");
const DEFAULT_LED_PATH = path.join(process.cwd(), "data", "led-status.json");

function isFalseyFlag(value) {
  return ["0", "false", "no", "off"].includes(String(value ?? "").toLowerCase());
}

function writeJsonIfChanged(filePath, payload) {
  const next = JSON.stringify(payload, null, 2);
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (prev && prev.trim() === next.trim()) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
  return true;
}

function buildLedStatus({ snapshot, state, gpio, tradingEnabled }) {
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const issueCodes = issues
    .map((issue) => issue?.code)
    .filter((code) => typeof code === "string");
  const marketOpen =
    typeof snapshot?.market_open === "boolean" ? snapshot.market_open : null;
  const controlTrading =
    typeof state?.trading_enabled === "boolean" ? state.trading_enabled : null;
  const forceNoTrade =
    typeof state?.force_no_trade === "boolean" ? state.force_no_trade : null;
  const canTrade =
    marketOpen === true &&
    tradingEnabled === true &&
    forceNoTrade !== true;

  return {
    updated_at: new Date().toISOString(),
    timezone: snapshot?.timezone ?? getMarketTimeZone(),
    market_open: marketOpen,
    health_ok: issues.length === 0,
    issue_codes: issueCodes,
    trading_enabled: tradingEnabled,
    control_trading_enabled: controlTrading,
    force_no_trade: forceNoTrade,
    can_trade: canTrade,
    control_reason: state?.control_reason ?? null,
    gpio_updated_at: gpio?.updated_at ?? null,
    gpio_source: gpio?.source ?? null,
  };
}

async function runOnce({ gpioPath, ledPath, ledEnabled }) {
  const applyResult = applyGpioStateToControl({ filePath: gpioPath });
  if (applyResult.updated) {
    const trading = applyResult.state?.trading_enabled ?? "unset";
    const forceNoTrade = applyResult.state?.force_no_trade ?? "unset";
    const reason = applyResult.state?.control_reason ?? "n/a";
    console.log(
      `[gpio] control updated trading_enabled=${trading} force_no_trade=${forceNoTrade} reason=${reason}`
    );
  }

  if (!ledEnabled) return applyResult;

  const snapshot = await buildHealthSnapshot();
  const state = applyResult.state ?? loadStateSync();
  const gpio = applyResult.gpio ?? loadGpioState(gpioPath);
  const tradingEnabled = getTradingEnabled();
  const ledPayload = buildLedStatus({
    snapshot,
    state,
    gpio,
    tradingEnabled,
  });
  const changed = writeJsonIfChanged(ledPath, ledPayload);
  if (changed) {
    console.log(`[gpio] led status updated -> ${ledPath}`);
  }
  return applyResult;
}

function getArgValue(args, name) {
  const directIndex = args.indexOf(name);
  if (directIndex >= 0 && directIndex + 1 < args.length) {
    return args[directIndex + 1];
  }
  const prefix = `${name}=`;
  const match = args.find((item) => item.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const gpioPath =
    getArgValue(args, "--gpio") || process.env.VS_GPIO_PATH || DEFAULT_GPIO_PATH;
  const ledPath =
    getArgValue(args, "--led") ||
    process.env.VS_LED_STATUS_PATH ||
    DEFAULT_LED_PATH;
  const pollMsRaw =
    getArgValue(args, "--interval") ||
    getArgValue(args, "--poll") ||
    process.env.VS_GPIO_POLL_MS;
  const pollMs = Number.isFinite(Number(pollMsRaw))
    ? Math.max(250, Number(pollMsRaw))
    : 2000;
  const once = args.includes("--once");
  const ledEnabled =
    !args.includes("--no-led") &&
    !isFalseyFlag(process.env.VS_GPIO_LED_ENABLED ?? "true");

  if (once) {
    await runOnce({ gpioPath, ledPath, ledEnabled });
    return;
  }

  console.log(
    `[gpio] watching ${gpioPath} every ${pollMs}ms (led=${ledEnabled ? ledPath : "disabled"})`
  );

  let running = true;
  const loop = async () => {
    if (!running) return;
    try {
      await runOnce({ gpioPath, ledPath, ledEnabled });
    } catch (err) {
      console.error("[gpio] tick failed:", err?.message ?? err);
    }
    if (!running) return;
    setTimeout(loop, pollMs);
  };

  process.on("SIGINT", () => {
    running = false;
    console.log("[gpio] stopping...");
  });
  process.on("SIGTERM", () => {
    running = false;
    console.log("[gpio] stopping...");
  });

  await loop();
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("[gpio] failed:", err?.message ?? err);
    process.exit(1);
  });
}
