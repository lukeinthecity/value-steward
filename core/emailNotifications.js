import nodemailer from "nodemailer";

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
export async function sendLessonEmail({ policy, result, training, worldContext }) {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    EMAIL_TO,
  } = process.env;

  if (
    !SMTP_HOST ||
    !SMTP_PORT ||
    !SMTP_USER ||
    !SMTP_PASS ||
    !EMAIL_FROM ||
    !EMAIL_TO
  ) {
    console.warn(
      "[ValueSteward] Email config incomplete, skipping lesson email."
    );
    return;
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

  const subject = `Value Steward update: policy v${policy.version} (risk ${policy.risk_level.toFixed(
    3
  )})`;

  const metrics = training.metrics ?? {};
  const bodyLines = [
    "Value Steward Daily Lesson",
    "",
    `Ran at: ${result.ranAt}`,
    `Market open at snapshot: ${result.marketOpen}`,
    "",
    "Policy:",
    `- Version: ${policy.version}`,
    `- Mode: ${policy.mode}`,
    `- Old risk level: ${training.oldRisk ?? policy.risk_level}`,
    `- New risk level: ${training.newRisk ?? policy.risk_level}`,
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
    "",
    "World Context:",
  ];

  if (!worldContext) {
    bodyLines.push(
      "- Status: no digest available (pipeline not run yet)."
    );
  } else {
    const macroView = worldContext.macro_view ?? null;
    const macroScore = macroView?.macro_score;
    const macroLabel = macroView?.macro_label;
    const macroLine =
      macroScore !== null && macroScore !== undefined
        ? `${Number(macroScore).toFixed(2)} (${macroLabel ?? "n/a"})`
        : "n/a (no tags yet)";

    const tags = worldContext.tags ?? {};
    const macroTags = [
      `macro_risk=${formatTag(tags.macro_risk)}`,
      `recession_fear=${formatTag(tags.recession_fear)}`,
      `rate_hawkishness=${formatTag(tags.rate_hawkishness)}`,
    ].join(", ");

    bodyLines.push(
      `- Date: ${worldContext.date ?? "n/a"}`,
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

    if (worldContext.summary) {
      bodyLines.push("", "Macro digest summary:", worldContext.summary);
    }
  }

  bodyLines.push(
    "",
    "—",
    "This email was generated automatically by Value Steward’s EOD lesson loop."
  );

  const mailOptions = {
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: bodyLines.join("\n"),
  };

  await transporter.sendMail(mailOptions);
}

function formatTag(value) {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toFixed(2);
}
