// scripts/controls.js
import { loadStateSync, saveStateSync } from "../core/stewardState.js";

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

async function main() {
  const state = loadStateSync();

  if (command === "enable") {
    state.trading_enabled = true;
    state.control_reason = "manual_enable";
    saveStateSync(state);
    console.log("[controls] Trading enabled.");
  } else if (command === "disable") {
    state.trading_enabled = false;
    state.control_reason = "manual_disable";
    saveStateSync(state);
    console.log("[controls] Trading disabled.");
  } else if (command === "halt") {
    state.force_no_trade = true;
    state.control_reason = "manual_halt";
    saveStateSync(state);
    console.log("[controls] System HALTED (force_no_trade=true).");
  } else if (command === "resume") {
    state.force_no_trade = false;
    state.control_reason = "manual_resume";
    saveStateSync(state);
    console.log("[controls] System resumed (force_no_trade=false).");
  } else if (command === "status") {
    console.log("[controls] Status:");
    console.log(`  trading_enabled: ${state.trading_enabled}`);
    console.log(`  force_no_trade:  ${state.force_no_trade}`);
    console.log(`  reason:          ${state.control_reason}`);
  } else {
    console.log("Usage: node scripts/controls.js [enable|disable|halt|resume|status]");
  }
}

main().catch(console.error);
