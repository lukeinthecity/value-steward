// scripts/controls.js
import { loadStateSync, updateStateSync } from "../core/stewardState.js";
import path from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

async function main() {
  if (command === "enable") {
    updateStateSync((state) => {
      state.trading_enabled = true;
      state.control_reason = "manual_enable";
      return state;
    });
    console.log("[controls] Trading enabled.");
  } else if (command === "disable") {
    updateStateSync((state) => {
      state.trading_enabled = false;
      state.control_reason = "manual_disable";
      state.control_updated_at = new Date().toISOString();
      return state;
    });
    console.log("[controls] Trading disabled.");
  } else if (command === "halt" || command === "force-no-trade") {
    updateStateSync((state) => {
      state.force_no_trade = true;
      state.control_reason = "manual_halt";
      state.control_updated_at = new Date().toISOString();
      return state;
    });
    console.log("[controls] System HALTED (force_no_trade=true).");
  } else if (command === "resume" || command === "clear") {
    updateStateSync((state) => {
      state.force_no_trade = false;
      state.control_reason = "manual_resume";
      state.control_updated_at = new Date().toISOString();
      return state;
    });
    console.log("[controls] System resumed (force_no_trade=false).");
  } else if (command === "status") {
    const state = loadStateSync();
    console.log("[controls] Status:");
    console.log(`  trading_enabled: ${state.trading_enabled}`);
    console.log(`  force_no_trade:  ${state.force_no_trade}`);
    console.log(`  reason:          ${state.control_reason}`);
  } else {
    console.log(
      "Usage: node scripts/controls.js [enable|disable|halt|resume|force-no-trade|clear|status]",
    );
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(console.error);
}
