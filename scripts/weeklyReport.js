import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import "dotenv/config";
import { getExchangeDateString } from "../core/timeUtils.js";
import { readJsonl } from "../core/runtimeArtifacts.js";
import { buildExecutionQualitySnapshot } from "../core/executionQualityReport.js";
import {
  getGateCalibrationPath,
  runGateCalibration,
} from "../core/gateCalibration.js";
import { getIntentOutcomesPath } from "../core/intentReconciliation.js";
import { sendWeeklyReportEmail } from "../core/emailNotifications.js";
import {
  buildDailyPromotionSnapshot,
  buildWeeklyPromotionSummary,
} from "../core/promotionMetrics.js";
import { buildSystemLogicExplanation } from "../core/systemLogicExplanation.js";
import { summarizeDecisionReview } from "../core/decisionReview.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";
import { fileURLToPath } from "url";

const SCORECARD_PATH = path.join(
  process.cwd(),
  "data",
  "signal-scorecard.jsonl",
);
const INTENT_LOG_PATH = path.join(process.cwd(), "logs", "intent_log.jsonl");

function fmtPct(val) {
  if (val === null || val === undefined) return "n/a";
  return (val * 100).toFixed(2) + "%";
}

async function main() {
  const args = process.argv.slice(2);
  const shouldEmail = args.includes("--send-email");

  const records = readJsonl(SCORECARD_PATH);
  const intents = readJsonl(INTENT_LOG_PATH);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const recentRecords = records.filter(
    (r) => new Date(r.timestamp) >= sevenDaysAgo,
  );
  const recentIntents = intents.filter(
    (i) => new Date(i.timestamp) >= sevenDaysAgo,
  );

  const reportData = {
    startDate: getExchangeDateString(sevenDaysAgo),
    endDate: getExchangeDateString(now),
    totalIntents: recentIntents.length,
    horizons: [],
    actions: {},
    holdSummary: {
      withinBuffer: 0,
      blockedByMacro: 0,
      blockedByRisk: 0,
      staleData: 0,
    },
    slippage: {
      avg: null,
      samples: 0,
    },
    intelligence: {
      avgDivergence: null,
      significantDisagreements: 0,
      samples: 0,
    },
    currentCycle: null,
    promotion: null,
    systemLogic: null,
    decisionReview: null,
  };

  console.log(
    `Value Steward Weekly Report (${reportData.startDate} to ${reportData.endDate})`,
  );
  console.log("=".repeat(60));

  // 1. System Logic Divergence (Deterministic vs Probabilistic)
  const divergenceValues = recentIntents
    .filter(
      (i) =>
        i.world_macro_score !== null &&
        i.world_macro_score !== undefined &&
        i.world_scout_score !== null &&
        i.world_scout_score !== undefined,
    )
    .map((i) => {
      const diff = Math.abs(i.world_macro_score - i.world_scout_score);
      if (diff > 0.3) reportData.intelligence.significantDisagreements++;
      return diff;
    });

  if (divergenceValues.length > 0) {
    reportData.intelligence.samples = divergenceValues.length;
    const avgDiv =
      divergenceValues.reduce((a, b) => a + b, 0) / divergenceValues.length;
    reportData.intelligence.avgDivergence = avgDiv.toFixed(2);
  }

  // 2. Slippage Analysis
  const slippageValues = recentRecords
    .filter((r) => r.expected_price && r.entry_close)
    .map((r) => {
      const diff = Math.abs(r.entry_close - r.expected_price);
      return diff / r.expected_price;
    });

  if (slippageValues.length > 0) {
    const avgSlippage =
      slippageValues.reduce((a, b) => a + b, 0) / slippageValues.length;
    reportData.slippage.avg = fmtPct(avgSlippage);
    reportData.slippage.samples = slippageValues.length;
  }

  // 3. Action/Hold Summary
  recentIntents.forEach((i) => {
    const type = i.action_type;
    reportData.actions[type] = (reportData.actions[type] || 0) + 1;

    if (
      i.reason_code === "WITHIN_BUFFER" ||
      i.reason_code === "WITHIN_BUFFER_NO_ACTION"
    )
      reportData.holdSummary.withinBuffer++;
    if (i.reason_code === "BUY_BLOCKED" || i.reason_code === "SELL_BLOCKED")
      reportData.holdSummary.blockedByMacro++;
    if (
      i.reason_code === "BLOCKED_BY_RISK_GOVERNOR" ||
      i.reason_code === "DAILY_LOSS_LIMIT"
    )
      reportData.holdSummary.blockedByRisk++;
    if (i.reason_code === "WORLD_STALE" || i.reason_code === "SIGNAL_STALE")
      reportData.holdSummary.staleData++;
  });
  reportData.decisionReview = summarizeDecisionReview(recentIntents);

  console.log("\nDecision Summary:");
  Object.entries(reportData.actions).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  if (reportData.decisionReview) {
    console.log("\nDecision Review:");
    console.log(`  Summary:         ${reportData.decisionReview.summary}`);
    console.log(
      `  Dominant reasons:${reportData.decisionReview.top_reasons.length ? ` ${reportData.decisionReview.top_reasons.map((entry) => `${entry.label} (${entry.count})`).join(", ")}` : " none"}`,
    );
    console.log(
      `  Active symbols:  ${reportData.decisionReview.top_symbols.length ? reportData.decisionReview.top_symbols.map((entry) => `${entry.label} (${entry.count})`).join(", ") : "none"}`,
    );
  }

  if (reportData.intelligence.samples > 0) {
    console.log(`\nSystem Logic Divergence (Deterministic vs Probabilistic):`);
    console.log(`  Avg Divergence:   ${reportData.intelligence.avgDivergence}`);
    console.log(
      `  Significant (>.3): ${reportData.intelligence.significantDisagreements} instances (${reportData.intelligence.samples} samples)`,
    );
  }

  console.log("\nStrategic 'Hold' Logic:");
  console.log(`  Within Buffer:    ${reportData.holdSummary.withinBuffer}`);
  console.log(
    `  Macro Blocked:    ${reportData.holdSummary.blockedByMacro} (Safety Gate)`,
  );
  console.log(
    `  Risk Blocked:     ${reportData.holdSummary.blockedByRisk} (Kill-Switch/Caps)`,
  );
  console.log(
    `  Data Stale:       ${reportData.holdSummary.staleData} (Integrity Gate)`,
  );

  if (reportData.slippage.samples > 0) {
    console.log(`\nExecution Quality (Slippage):`);
    console.log(
      `  Avg Slippage:     ${reportData.slippage.avg} (${reportData.slippage.samples} trades)`,
    );
  }

  // Execution fill quality (from intent → order reconciliation)
  const execFills = buildExecutionQualitySnapshot({
    outcomes: readJsonl(getIntentOutcomesPath()),
    scorecardRecords: records,
    now,
    windowDays: 7,
  });
  reportData.executionFills = execFills;
  console.log(`\nExecution Quality (Fills, ${execFills.window_days}d):`);
  if (!execFills.attempts) {
    console.log("  (no reconciled attempts in window)");
  } else {
    console.log(
      `  Fill rate:        ${fmtPct(execFills.fill_rate)} (${execFills.fills}/${execFills.attempts})`,
    );
    execFills.by_score_bucket.forEach((b) => {
      console.log(
        `  ${b.bucket.padEnd(4)} conviction: ${fmtPct(b.fill_rate)} (${b.fills}/${b.attempts})`,
      );
    });
    const adv = execFills.adverse_selection;
    if (adv.diff !== null) {
      console.log(
        `  Adverse selection: unfilled ${fmtPct(adv.unfilled_mean_excess_5d)} vs filled ${fmtPct(adv.filled_mean_excess_5d)} 5d excess (t=${adv.t_stat === null ? "n/a" : adv.t_stat.toFixed(2)})`,
      );
    }
  }

  // Gate calibration (BUY_BLOCKED post-mortem) — regenerated weekly.
  try {
    const gateCal = runGateCalibration({ now });
    console.log(
      `\nGate Calibration: ${gateCal.gates.length} gates over ${gateCal.total_blocked} blocked rows → ${getGateCalibrationPath()}`,
    );
  } catch (err) {
    console.warn("Gate calibration report failed:", err?.message ?? err);
  }

  // 4. Performance Scorecard
  if (recentRecords.length > 0) {
    console.log("\nPerformance Scorecard:");
    const horizonNames = ["1", "5", "20"];
    horizonNames.forEach((h) => {
      const valid = recentRecords.filter(
        (r) => r.horizons?.[h] && r.horizons[h].return !== null,
      );
      if (!valid.length) return;

      const avgRet =
        valid.reduce((sum, r) => sum + r.horizons[h].return, 0) / valid.length;
      const avgExcess =
        valid.reduce(
          (sum, r) => sum + (r.horizons[h].excess_vs_benchmark || 0),
          0,
        ) / valid.length;

      const buys = valid.filter(
        (r) => r.action_type === "BUY" || r.action_type === "MULTI",
      );
      const sells = valid.filter((r) => r.action_type === "SELL");

      const hitRate = (items) => {
        if (!items.length) return null;
        const correct = items.filter(
          (r) => r.horizons[h].directional_correct,
        ).length;
        return correct / items.length;
      };

      const horizonInfo = {
        name: h,
        samples: valid.length,
        avgReturn: fmtPct(avgRet),
        avgExcess: fmtPct(avgExcess),
        buyHitRate: hitRate(buys) !== null ? fmtPct(hitRate(buys)) : null,
        buyCount: buys.length,
        sellHitRate: hitRate(sells) !== null ? fmtPct(hitRate(sells)) : null,
        sellCount: sells.length,
      };

      reportData.horizons.push(horizonInfo);
      console.log(
        `  Horizon ${h}D: Ret=${horizonInfo.avgReturn} Excess=${horizonInfo.avgExcess} HitRate=${horizonInfo.buyHitRate || "n/a"}`,
      );
    });

    // 5. Trigger QuantStats Fact Sheet
    console.log("\nGenerating institutional Fact Sheet (QuantStats)...");
    const venvPython = path.join(process.cwd(), ".venv", "bin", "python3");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    const result = spawnSync(
      pythonCmd,
      ["-m", "valuesteward.cli", "weekly-report"],
      {
        env: { ...process.env, PYTHONPATH: "./src" },
        encoding: "utf-8",
      },
    );

    if (result.status === 0) {
      console.log("Fact Sheet saved to data/weekly-tearsheet.html");
    } else {
      console.warn("Failed to generate Fact Sheet:", result.stderr);
    }
  }

  const latestPromotion = await buildDailyPromotionSnapshot();
  const latestWorldContext = await loadLatestWorldContext();
  if (latestWorldContext) {
    reportData.systemLogic = buildSystemLogicExplanation(latestWorldContext);
  }
  reportData.currentCycle = {
    exchangeDate: latestPromotion.exchange_date,
    integrityPass: latestPromotion.integrity?.pass ?? null,
    blockers: latestPromotion.blockers ?? [],
  };
  reportData.promotion = buildWeeklyPromotionSummary({
    records: recentRecords,
    intents: recentIntents,
    latestDailyPromotion: latestPromotion,
  });

  console.log("\nPromotion Framework:");
  console.log(`  Stage:           ${reportData.promotion.stage}`);
  console.log(`  Verdict:         ${reportData.promotion.verdict}`);
  console.log(`  Operational:     ${reportData.promotion.operational_score}`);
  console.log(`  Risk:            ${reportData.promotion.risk_score}`);
  console.log(
    `  Decision:        ${reportData.promotion.decision_score ?? "n/a"}`,
  );
  console.log(`  Learning:        ${reportData.promotion.learning_score}`);
  console.log(
    `  Blockers:        ${reportData.promotion.blockers.length ? reportData.promotion.blockers.join(", ") : "none"}`,
  );
  console.log(
    `  Current blockers:${reportData.promotion.current_blockers.length ? ` ${reportData.promotion.current_blockers.join(", ")}` : " none"}`,
  );
  console.log("\nCurrent Cycle Freshness:");
  console.log(`  Exchange date:   ${reportData.currentCycle.exchangeDate}`);
  console.log(`  Integrity pass:  ${reportData.currentCycle.integrityPass}`);
  console.log(
    `  Blockers:        ${reportData.currentCycle.blockers.length ? reportData.currentCycle.blockers.join(", ") : "none"}`,
  );

  if (reportData.systemLogic) {
    console.log("\nCurrent System Logic:");
    console.log(`  Regime:          ${reportData.systemLogic.final_label}`);
    console.log(`  ${reportData.systemLogic.baseline_summary}`);
    console.log(`  ${reportData.systemLogic.overlay_summary}`);
    console.log(`  ${reportData.systemLogic.resolution_summary}`);
    console.log(`  ${reportData.systemLogic.decision_impact_summary}`);
  }

  // 6. Email Delivery
  if (shouldEmail) {
    try {
      await sendWeeklyReportEmail({ report: reportData });
      console.log("\nWeekly report email sent successfully.");
    } catch (err) {
      console.error("\nFailed to send weekly report email:", err.message);
    }
  }
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(console.error);
}
