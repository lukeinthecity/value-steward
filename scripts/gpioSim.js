import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DEFAULT_GPIO_PATH = path.join(process.cwd(), "data", "gpio-state.json");
const GPIO_PATH =
  process.env.VS_GPIO_PATH && process.env.VS_GPIO_PATH.trim().length
    ? process.env.VS_GPIO_PATH
    : DEFAULT_GPIO_PATH;

function readState() {
  if (!fs.existsSync(GPIO_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(GPIO_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(payload) {
  fs.mkdirSync(path.dirname(GPIO_PATH), { recursive: true });
  fs.writeFileSync(GPIO_PATH, JSON.stringify(payload, null, 2));
  console.log(`[gpio:sim] wrote ${GPIO_PATH}`);
}

function getReason(args, fallback) {
  const idx = args.indexOf("--reason");
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const direct = args.find((arg) => arg.startsWith("--reason="));
  if (direct) return direct.split("=").slice(1).join("=") || fallback;
  return fallback;
}

function printState(state) {
  if (!state) {
    console.log("[gpio:sim] no gpio-state.json found.");
    return;
  }
  console.log("[gpio:sim] current gpio state:");
  console.log(JSON.stringify(state, null, 2));
}

function buildPayload(overrides, reason) {
  return {
    trading_enabled:
      Object.prototype.hasOwnProperty.call(overrides, "trading_enabled")
        ? overrides.trading_enabled
        : null,
    force_no_trade:
      Object.prototype.hasOwnProperty.call(overrides, "force_no_trade")
        ? overrides.force_no_trade
        : null,
    reason,
    updated_at: new Date().toISOString(),
    source: "gpio_sim",
  };
}

function main() {
  const args = process.argv.slice(2);
  const action = (args[0] || "status").toLowerCase();

  if (action === "status") {
    printState(readState());
    return;
  }

  const reason = getReason(args, `gpio_sim:${action}`);

  if (action === "enable") {
    writeState(buildPayload({ trading_enabled: true }, reason));
    return;
  }

  if (action === "disable") {
    writeState(buildPayload({ trading_enabled: false }, reason));
    return;
  }

  if (action === "force-no-trade") {
    writeState(buildPayload({ force_no_trade: true }, reason));
    return;
  }

  if (action === "clear") {
    writeState(buildPayload({ trading_enabled: null, force_no_trade: null }, reason));
    return;
  }

  console.error(`[gpio:sim] unknown action: ${action}`);
  console.log("Valid actions: status, enable, disable, force-no-trade, clear");
  process.exit(1);
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main();
}
