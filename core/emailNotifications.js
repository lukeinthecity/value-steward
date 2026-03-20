import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.GOOGLE_GENAI_API_KEY;

/**
 * Uses Gemini to synthesize a technical report into a human-readable 
 * professional summary for investors/stewards.
 */
async function generateAISummary({ type, data }) {
  if (!API_KEY) return null;
  const client = new GoogleGenAI({ apiKey: API_KEY });
  
  const systemInstruction = `
    You are the "Head of Portfolio Reporting" for an elite institutional investment desk. 
    Your persona is sophisticated, concise, and focused on risk-adjusted performance. 
    You communicate with the Principal (the account owner) using institutional clarity.

    Your Reporting Framework:
    1. Performance Attribution: Explain the "Why" behind the results (e.g., regime shifts, momentum quality).
    2. Capital Discipline: Highlight adherence to the 3% kill-switch and 2.0 SD Vol-Stops.
    3. Strategic Posture: Define if the bot is currently defensive, opportunistic, or balanced based on the 'Guardian' and 'Scout' scores.

    Avoid flowery language. Use terms like 'alpha decay', 'volatility clustering', 'regime change', and 'convexity'.
  `;

  const prompt = `
    Report Type: ${type}
    Technical Data: ${JSON.stringify(data)}
    
    Provide a 2-3 sentence executive summary explaining the system's current 
    posture and the strategic rationale for its latest actions.
  `;

  try {
    const interaction = await client.interactions.create({
      model: "gemini-3-flash-preview",
      system_instruction: systemInstruction,
      input: prompt,
    });
    return interaction.outputs[interaction.outputs.length - 1].text;
  } catch (err) {
    console.warn("[email] AI Summary failed:", err.message);
    return null;
  }
}

function loadEmailConfig(label) {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    EMAIL_TO,
  } = process.env;

  const missing = [];
  if (!SMTP_HOST) missing.push("SMTP_HOST");
  if (!SMTP_PORT) missing.push("SMTP_PORT");
  if (!SMTP_USER) missing.push("SMTP_USER");
  if (!SMTP_PASS) missing.push("SMTP_PASS");
  if (!EMAIL_FROM) missing.push("EMAIL_FROM");
  if (!EMAIL_TO) missing.push("EMAIL_TO");

  if (missing.length) {
    console.warn(
      `[ValueSteward] Email config incomplete (missing: ${missing.join(
        ", "
      )}), skipping ${label}.`
    );
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return {
    transporter,
    from: EMAIL_FROM,
    to: EMAIL_TO,
  };
}

/**
 * Send a lesson summary email when the policy is updated.
 * This uses SMTP and is environment-agnostic.
 *
 * Required env vars:
 *   SMTP_HOST
 *   SMTP_PORT
 *   SMTP_USER
 *   SMTP_PASS
 *   EMAIL_FROM
 *   EMAIL_TO
 */
export async function sendLessonEmail({
  policy,
  result,
  training,
  worldContext,
  promotion = null,
  emailMode = "update",
  lastOrder = null,
  tradingDays = 0,
}) {
  const config = loadEmailConfig("lesson email");
  if (!config) return;
  const { transporter, from, to } = config;

  const policyVersion = policy?.version ?? "n/a";
  let subject;
  if (emailMode === "summary") {
    subject = `Value Steward EOD summary: day ${tradingDays}/60 (policy v${policyVersion})`;
  } else {
    subject = `Value Steward update: day ${tradingDays}/60 (policy v${policyVersion})`;
  }

  const metrics = training.metrics ?? {};
  const header =
    emailMode === "summary"
      ? "Value Steward End-of-Day Summary"
      : "Value Steward Daily Lesson";

  const aiSummary = await generateAISummary({ 
    type: "Daily Execution & Policy Update", 
    data: { result, training, worldContext } 
  });

  const bodyLines = [
    header,
    "",
    `Phase 1 Progress: ${tradingDays} / 60 Trading Days`,
    "-".repeat(40),
    "",
    "Steward's Insight:",
    aiSummary || "[System fallback: AI synthesis currently unavailable. Strategy remains focused on deterministic risk parity and momentum adherence.]",
    "",
    `Ran at: ${result.ranAt}`,
    `Market open at snapshot: ${result.marketOpen}`,
    "",
    "Policy:",
    `- Version: ${policyVersion}`,
    `- Mode: ${policy?.mode ?? "n/a"}`,
    `- Old risk level: ${training.oldRisk ?? policy?.risk_level ?? "n/a"}`,
    `- New risk level: ${training.newRisk ?? policy?.risk_level ?? "n/a"}`,
    "",
    "Training decision:",
    `- Updated: ${training.updated}`,
    `- Reason: ${training.reason}`,
    `- Equity delta: ${training.equityDelta ?? "n/a"}`,
    "",
    "Metrics window:",
    `- Sample count: ${metrics.sampleCount ?? "n/a"}`,
    `- Equity return: ${metrics.equityReturn ?? "n/a"}`,
    `- Equity volatility: ${metrics.equityVolatility ?? "n/a"}`,
    `- Max drawdown: ${metrics.maxDrawdown ?? "n/a"}`,
    `- Avg cash utilization: ${metrics.avgCashUtilization ?? "n/a"}`,
    `- Underinvested: ${metrics.isUnderinvested ?? "n/a"}`,
    `- Overconcentrated: ${metrics.isOverconcentrated ?? "n/a"}`,
    "",
    "Snapshot:",
    `- Equity: ${result.equity}`,
    `- Buying power: ${result.buyingPower}`,
    `- Positions held: ${result.numPositions}`,
    `- Gross exposure: ${result.grossExposure}`,
    `- Net exposure: ${result.netExposure}`,
    `- Trade gate: mode=${result.tradeGate?.mode ?? "n/a"} canTrade=${
      result.tradeGate?.canTrade ?? "n/a"
    } tradingEnabled=${result.tradeGate?.tradingEnabled ?? "n/a"}`,
    `- Downtime seconds: ${result.downtimeSeconds ?? "n/a"}`,
    "",
    "Integrity Check:",
    `- Pass: ${promotion?.integrity?.pass ?? "n/a"}`,
    `- Health issues: ${
      promotion?.health_issue_counts
        ? `warn=${promotion.health_issue_counts.warn} error=${promotion.health_issue_counts.error}`
        : "n/a"
    }`,
    `- Controls: tradingEnabled=${promotion?.integrity?.controls?.trading_enabled ?? "n/a"} forceNoTrade=${promotion?.integrity?.controls?.force_no_trade ?? "n/a"}`,
    "",
    "Cap Compliance:",
    `- Pass: ${promotion?.cap_compliance?.pass ?? "n/a"}`,
    `- Max effective cap: ${promotion?.cap_compliance?.max_effective_capital_dollars ?? "n/a"}`,
    `- Max trade cap: ${promotion?.cap_compliance?.max_trade_notional_dollars ?? "n/a"}`,
    `- Largest position value: ${promotion?.cap_compliance?.max_position_value ?? "n/a"}`,
    `- Oversized positions: ${promotion?.cap_compliance?.oversized_count ?? "n/a"}`,
    "",
    "Artifact Reconciliation:",
    `- Pass: ${promotion?.reconciliation?.pass ?? "n/a"}`,
    `- Position count match: ${promotion?.reconciliation?.position_count_match ?? "n/a"}`,
    `- Equity match: ${promotion?.reconciliation?.equity_match ?? "n/a"}`,
    `- Equity difference: ${promotion?.reconciliation?.equity_difference ?? "n/a"}`,
    "",
    "Scale Status:",
    `- Stage: ${promotion?.stage ?? "n/a"}`,
    `- Verdict: ${promotion?.verdict ?? "n/a"}`,
    `- Blockers: ${
      Array.isArray(promotion?.blockers) && promotion.blockers.length
        ? promotion.blockers.join(", ")
        : "none"
    }`,
    "",
    "World Context:",
  ];

  if (!worldContext) {
    bodyLines.push(
      "- Status: no digest available (pipeline not run yet)."
    );
  } else {
    const macroView = worldContext.macro_view ?? null;
    const finalRegime = worldContext.final_regime ?? null;
    const macroScore = macroView?.macro_score;
    const macroLabel = macroView?.macro_label;
    const macroLine =
      macroScore !== null && macroScore !== undefined
        ? `${Number(macroScore).toFixed(2)} (${macroLabel ?? "n/a"})`
        : "n/a (no tags yet)";
    const regimeLine =
      finalRegime?.final_label
        ? `${finalRegime.final_label} score=${
            typeof finalRegime.final_score === "number"
              ? Number(finalRegime.final_score).toFixed(2)
              : "n/a"
          } divergence=${finalRegime.divergence === true ? "yes" : "no"} fusion=${finalRegime.fusion_reason ?? "n/a"}`
        : "n/a";

    const tags = worldContext.tags ?? {};
    const macroTags = [
      `macro_risk=${formatTag(tags.macro_risk)}`,
      `recession_fear=${formatTag(tags.recession_fear)}`,
      `rate_hawkishness=${formatTag(tags.rate_hawkishness)}`,
    ].join(", ");

    bodyLines.push(
      `- Date: ${worldContext.date ?? "n/a"}`,
      `- Regime: ${regimeLine}`,
      `- Macro: ${macroLine} · ${macroTags}`,
      `- Geopolitics: ${formatTag(tags.geopolitical_tension)}`,
      `- Energy shock risk: ${formatTag(tags.energy_shock_risk)}`,
      `- Sources used: ${
        Array.isArray(worldContext.sources_used)
          ? worldContext.sources_used.length
          : "n/a"
      }`,
      `- Raw items in window: ${worldContext.raw_count ?? "n/a"}`
    );

    if (worldContext.massive_macro_summary) {
      bodyLines.push(`- Massive macro: ${worldContext.massive_macro_summary}`);
    }

    if (worldContext.summary) {
      bodyLines.push("", "Macro digest summary:", worldContext.summary);
    }
  }

  if (lastOrder) {
    const qtyText = lastOrder.qty ?? lastOrder.notional ?? "n/a";
    const priceText = lastOrder.filled_avg_price ?? "n/a";
    bodyLines.push(
      "",
      "Last Order:",
      `- Symbol: ${lastOrder.symbol ?? "n/a"}`,
      `- Side: ${lastOrder.side ?? "n/a"} Status: ${lastOrder.status ?? "n/a"}`,
      `- Qty/Notional: ${qtyText} Type: ${lastOrder.type ?? "n/a"}`,
      `- Submitted: ${lastOrder.submitted_at ?? "n/a"}`,
      `- Filled: ${lastOrder.filled_at ?? "n/a"} Avg price: ${priceText}`
    );
  } else {
    bodyLines.push("", "Last Order:", "- Status: unavailable");
  }

  bodyLines.push(
    "",
    "—",
    "This email was generated automatically by Value Steward’s EOD lesson loop."
  );

  const mailOptions = {
    from,
    to,
    subject,
    text: bodyLines.join("\n"),
  };

  await transporter.sendMail(mailOptions);
}

function formatTag(value) {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toFixed(2);
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return Number(value).toFixed(digits);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${(Number(value) * 100).toFixed(2)}%`;
}

export async function sendHealthEmail({ health, reason = "scheduled" }) {
  const config = loadEmailConfig("health email");
  if (!config) return;
  const { transporter, from, to } = config;

  const subject = `Value Steward health check (${health.exchange_date})`;
  const aiSummary = await generateAISummary({ 
    type: "System Health & Data Integrity", 
    data: health 
  });

  const issues = Array.isArray(health.issues) ? health.issues : [];
  const issueLines = issues.length
    ? issues.map((issue) => `- ${issue.code}: ${issue.message}`)
    : ["- None detected"];

  const staleLines = health.feeds?.stale_sources?.length
    ? [`- Stale list: ${health.feeds.stale_sources.join(", ")}`]
    : [];

  const bodyLines = [
    "Value Steward System Health",
    "",
    "Steward's Insight:",
    aiSummary || "System health is optimal. Core data pipelines are operational.",
    "",
    `Generated at: ${health.generated_at}`,
    `Timezone: ${health.timezone}`,
    `Market open now: ${health.market_open}`,
    `Reason: ${reason}`,
    "",
    "Tick:",
    `- Last run: ${health.tick?.last_run_at ?? "n/a"}`,
    `- Age (hours): ${formatNumber(health.tick?.age_hours)}`,
    "",
    "Artifacts:",
    `- Latest tick generated at: ${health.artifacts?.latest_tick?.generated_at ?? "n/a"}`,
    `- Latest tick age (hours): ${formatNumber(health.artifacts?.latest_tick?.age_hours)}`,
    `- Latest tick exchange date: ${health.artifacts?.latest_tick?.exchange_date ?? "n/a"}`,
    `- Portfolio updated at: ${health.artifacts?.portfolio?.updated_at ?? "n/a"}`,
    `- Portfolio age (hours): ${formatNumber(health.artifacts?.portfolio?.age_hours)}`,
    `- Portfolio exchange date: ${health.artifacts?.portfolio?.exchange_date ?? "n/a"}`,
    "",
    "World context:",
    `- Generated at: ${health.world?.generated_at ?? "n/a"}`,
    `- Age (hours): ${formatNumber(health.world?.age_hours)}`,
    `- Date/slot: ${health.world?.date ?? "n/a"} / ${health.world?.slot ?? "n/a"}`,
    `- Macro: ${health.world?.macro_label ?? "n/a"} (${formatNumber(
      health.world?.macro_score,
      2
    )})`,
    `- Sources used: ${health.world?.sources_used ?? "n/a"}`,
    `- Raw items: ${health.world?.raw_count ?? "n/a"}`,
    "",
    "Feed health:",
    `- Last checked: ${health.feeds?.last_checked ?? "n/a"}`,
    `- Stale sources: ${health.feeds?.stale_count ?? 0}`,
    ...staleLines,
    "",
    "Execution:",
    `- Last executed at: ${health.execution?.last_executed_at ?? "n/a"}`,
    `- Last action: ${health.execution?.last_action ?? "n/a"}`,
    `- Last symbol: ${health.execution?.last_symbol ?? "n/a"}`,
    `- Count today: ${health.execution?.count_today ?? "n/a"}`,
    "",
    "Training:",
    `- Last trained at: ${health.training?.last_trained_at ?? "n/a"}`,
    `- Last reason: ${health.training?.last_reason ?? "n/a"}`,
    `- Policy version: ${health.training?.policy_version ?? "n/a"}`,
    "",
    "Policy:",
    `- Version: ${health.policy?.version ?? "n/a"}`,
    `- Mode: ${health.policy?.mode ?? "n/a"}`,
    `- Risk level: ${health.policy?.risk_level ?? "n/a"}`,
    "",
    "Scorecard:",
    `- Records: ${health.scorecard?.records ?? "n/a"}`,
    `- Trading days: ${health.scorecard?.trading_days ?? "n/a"}`,
    `- Summary generated at: ${health.scorecard?.summary_generated_at ?? "n/a"}`,
    "",
    "Issues:",
    ...issueLines,
    "",
    "—",
    "This email was generated automatically by Value Steward’s health monitor.",
  ];

  await transporter.sendMail({
    from,
    to,
    subject,
    text: bodyLines.join("\n"),
  });
}

export async function sendPhaseCheckpointEmail({ phase, exchangeDate }) {
  const config = loadEmailConfig("phase checkpoint email");
  if (!config) return;
  const { transporter, from, to } = config;

  const subject = `Value Steward phase checkpoint (${exchangeDate})`;
  const milestoneText = phase.milestones?.length
    ? phase.milestones.join(", ")
    : "n/a";

  const horizonLines = [];
  for (const [horizon, data] of Object.entries(phase.horizons ?? {})) {
    horizonLines.push(
      `- ${horizon}d: samples=${data.samples ?? "n/a"} ` +
        `avg_excess_benchmark=${formatPercent(data.avg_excess_benchmark)} ` +
        `avg_signed_return=${formatPercent(data.avg_signed_return)} ` +
        `no_action_avoid=${formatPercent(data.no_action_beats_benchmark_rate)} ` +
        `no_action_missed=${formatPercent(data.no_action_missed_rate)}`
    );
  }

  const bodyLines = [
    "Value Steward Phase Checkpoint",
    "",
    `Exchange date: ${exchangeDate}`,
    `Trading days collected: ${phase.trading_days} / 60`,
    `Scorecard records: ${phase.records}`,
    `Summary generated at: ${phase.summary_generated_at ?? "n/a"}`,
    `Milestones configured: ${milestoneText}`,
    `Ready for review: ${phase.ready_for_review ? "yes" : "no"}`,
    "",
    "Scorecard horizons:",
    ...(horizonLines.length ? horizonLines : ["- No summary data yet"]),
    "",
    "Suggested next step:",
    phase.ready_for_review
      ? "- Consider reviewing Phase 1 DoD and deciding on Phase 2 transition."
      : "- Continue collecting daily scorecard data.",
    "",
    "—",
    "This email was generated automatically by Value Steward’s phase monitor.",
  ];

  await transporter.sendMail({
    from,
    to,
    subject,
    text: bodyLines.join("\n"),
  });
}

export async function sendWeeklyReportEmail({ report }) {
  const config = loadEmailConfig("weekly report email");
  if (!config) return;
  const { transporter, from, to } = config;

  const subject = `Value Steward Weekly Report: ${report.startDate} to ${report.endDate}`;
  const aiSummary = await generateAISummary({ 
    type: "Weekly Performance & Strategy Audit", 
    data: report 
  });

  const bodyLines = [
    `Value Steward Weekly Report`,
    `Period: ${report.startDate} to ${report.endDate}`,
    "=".repeat(60),
    "",
    "Steward's Insight:",
    aiSummary || "[System fallback: AI synthesis currently unavailable. Weekly performance characterized by adherence to risk gates and momentum-driven rebalancing.]",
    "",
    `Total Decisions: ${report.totalIntents}`,
    "",
    "Decision Summary:",
  ];

  Object.entries(report.actions).forEach(([type, count]) => {
    bodyLines.push(`  - ${type}: ${count}`);
  });

  bodyLines.push(
    "",
    "Strategic 'Hold' Logic (Protection Gates):",
    `  - Within Buffer:    ${report.holdSummary.withinBuffer}`,
    `  - Macro Blocked:    ${report.holdSummary.blockedByMacro}`,
    `  - Risk Blocked:     ${report.holdSummary.blockedByRisk}`,
    `  - Data Stale:       ${report.holdSummary.staleData}`,
    ""
    );

    if (report.slippage && report.slippage.samples > 0) {
    bodyLines.push(
      "Execution Quality (Slippage):",
      `  - Avg Slippage:     ${report.slippage.avg} (${report.slippage.samples} trades)`,
        ""
      );
      }

      if (report.intelligence && report.intelligence.samples > 0) {
      bodyLines.push(
        "Intelligence Divergence (Guardian vs Scout):",
        `  - Avg Divergence:   ${report.intelligence.avgDivergence}`,
        `  - Significant (>0.3): ${report.intelligence.significantDisagreements} instances`,
        ""
      );
      }

  if (report.horizons.length > 0) {
    bodyLines.push("Performance Scorecard:");
    report.horizons.forEach((h) => {
      bodyLines.push(`  - Horizon ${h.name}D: Ret=${h.avgReturn} Excess=${h.avgExcess} HitRate=${h.buyHitRate || 'n/a'}`);
    });
  } else {
    bodyLines.push("Performance Scorecard: No data collected for this period.");
  }

  if (report.promotion) {
    bodyLines.push(
      "",
      "Promotion Framework:",
      `  - Stage: ${report.promotion.stage}`,
      `  - Verdict: ${report.promotion.verdict}`,
      `  - Operational score: ${report.promotion.operational_score}`,
      `  - Risk score: ${report.promotion.risk_score}`,
      `  - Decision score: ${report.promotion.decision_score ?? "n/a"}`,
      `  - Learning score: ${report.promotion.learning_score}`,
      `  - 1D excess vs benchmark: ${formatPercent(report.promotion.metrics?.avg_excess_benchmark_1d)}`,
      `  - 1D excess vs cash: ${formatPercent(report.promotion.metrics?.avg_excess_cash_1d)}`,
      `  - 1D buy hit rate: ${formatPercent(report.promotion.metrics?.buy_hit_rate_1d)}`,
      `  - Blockers: ${
        report.promotion.blockers?.length
          ? report.promotion.blockers.join(", ")
          : "none"
      }`,
      `  - Current blockers: ${
        report.promotion.current_blockers?.length
          ? report.promotion.current_blockers.join(", ")
          : "none"
      }`
    );
  }

  if (report.currentCycle) {
    bodyLines.push(
      "",
      "Current Cycle Freshness:",
      `  - Exchange date: ${report.currentCycle.exchangeDate ?? "n/a"}`,
      `  - Integrity pass: ${report.currentCycle.integrityPass ?? "n/a"}`,
      `  - Blockers: ${
        report.currentCycle.blockers?.length
          ? report.currentCycle.blockers.join(", ")
          : "none"
      }`
    );
  }

  bodyLines.push(
    "",
    "—",
    "This email was generated automatically by Value Steward’s weekly report loop."
  );

  await transporter.sendMail({
    from,
    to,
    subject,
    text: bodyLines.join("\n"),
  });
}
