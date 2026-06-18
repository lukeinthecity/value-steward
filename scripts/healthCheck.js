import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import { sendHealthEmail } from "../core/emailNotifications.js";
import { buildHealthSnapshot, shouldSendHealthEmail } from "../core/healthStatus.js";
import { markHealthEmailSent } from "../core/stewardState.js";
import { maybeSendHealthAlert } from "../core/pushTriggers.js";

function printIssues(issues) {
  if (!issues.length) {
    console.log("- issues: none");
    return;
  }
  console.log(`- issues: ${issues.length}`);
  for (const issue of issues) {
    console.log(`  - ${issue.code}: ${issue.message}`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const sendEmail = args.has("--email");

  const snapshot = await buildHealthSnapshot();
  console.log("[health] snapshot");
  console.log(`- generated_at=${snapshot.generated_at}`);
  console.log(`- exchange_date=${snapshot.exchange_date}`);
  console.log(`- market_open=${snapshot.market_open}`);
  console.log(`- tick_age_hours=${snapshot.tick?.age_hours ?? "n/a"}`);
  console.log(`- tick_artifact_age_hours=${snapshot.artifacts?.latest_tick?.age_hours ?? "n/a"}`);
  console.log(`- portfolio_artifact_age_hours=${snapshot.artifacts?.portfolio?.age_hours ?? "n/a"}`);
  console.log(`- world_age_hours=${snapshot.world?.age_hours ?? "n/a"}`);
  console.log(`- scorecard_days=${snapshot.scorecard?.trading_days ?? 0}`);
  printIssues(snapshot.issues ?? []);

  // Push a (de-duped) health alert whenever issues are present — independent of
  // the email path, so it fires on the hourly cron run.
  const pushResult = await maybeSendHealthAlert({ snapshot });
  if (pushResult.reason !== "no_issues" && pushResult.reason !== "deduped") {
    console.log(`[health] push alert: ${pushResult.reason}`);
  }

  if (!sendEmail) return;

  const decision = shouldSendHealthEmail({
    agentState: null,
    snapshot,
  });

  if (!decision.send) {
    console.log(`[health] email suppressed (${decision.reason}).`);
    return;
  }

  await sendHealthEmail({ health: snapshot, reason: decision.reason });
  await markHealthEmailSent();
  console.log("[health] email sent.");
}

// Only run when executed directly (cron/CLI), never on import.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("[health] failed:", err?.message ?? err);
    process.exit(1);
  });
}
