import "dotenv/config";
import Alpaca from "@alpacahq/alpaca-trade-api";
import { runTick } from "../core/tick.js";
import { trainPolicyFromHistoryLocal } from "../core/localTrainer.js";
import { sendLessonEmail } from "../core/emailNotifications.js";
import { loadAgentState, saveAgentState } from "../core/agentState.js";
import { loadLatestWorldContext } from "../world/loadLatestWorldContext.js";

async function fetchLastOrder(alpaca) {
  try {
    const orders = await alpaca.getOrders({
      status: "all",
      limit: 1,
      direction: "desc",
    });
    if (Array.isArray(orders) && orders.length) {
      const order = orders[0];
      return {
        id: order.id ?? null,
        symbol: order.symbol ?? null,
        side: order.side ?? null,
        status: order.status ?? null,
        qty: order.qty ?? null,
        notional: order.notional ?? null,
        type: order.type ?? null,
        time_in_force: order.time_in_force ?? null,
        submitted_at: order.submitted_at ?? null,
        filled_at: order.filled_at ?? null,
        filled_avg_price: order.filled_avg_price ?? null,
      };
    }
  } catch (err) {
    console.warn(
      "[ValueSteward] Failed to fetch last order:",
      err?.message ?? err
    );
  }
  return null;
}

function getExchangeTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return {
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function getExchangeDateString(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isWithinEodWindow(hour, minute, windowMinutes) {
  const closeMinutes = 16 * 60;
  const nowMinutes = hour * 60 + minute;
  return Math.abs(nowMinutes - closeMinutes) <= windowMinutes;
}

function getWorldContextAgeMinutes(worldContext) {
  if (!worldContext?.generated_at) return null;
  const ts = Date.parse(worldContext.generated_at);
  if (Number.isNaN(ts)) return null;
  return (Date.now() - ts) / 60000;
}

function describeWorldContext(worldContext) {
  if (!worldContext) return "none";
  const date = worldContext.date ?? "unknown";
  const generatedAt = worldContext.generated_at ?? "unknown";
  const macroLabel = worldContext.macro_view?.macro_label ?? "unknown";
  const macroScore = worldContext.macro_view?.macro_score ?? null;
  const sources = Array.isArray(worldContext.sources_used)
    ? worldContext.sources_used.length
    : null;
  const rawCount = worldContext.raw_count ?? null;
  const ageMinutes = getWorldContextAgeMinutes(worldContext);
  const macroScoreText =
    typeof macroScore === "number" ? macroScore.toFixed(2) : "n/a";
  const sourcesText = sources !== null ? sources : "n/a";
  const rawText = rawCount !== null ? rawCount : "n/a";
  const ageText =
    typeof ageMinutes === "number" ? ageMinutes.toFixed(1) : "n/a";
  return `date=${date} generated_at=${generatedAt} age_min=${ageText} macro=${macroLabel} score=${macroScoreText} sources=${sourcesText} raw=${rawText}`;
}

async function main() {
  const alpacaConfig = {
    keyId: process.env.ALPACA_API_KEY || process.env.ALPACA_API_KEY_ID,
    secretKey: process.env.ALPACA_API_SECRET || process.env.ALPACA_SECRET_KEY,
    baseUrl: process.env.ALPACA_BASE_URL || process.env.ALPACA_PAPER_BASE_URL,
  };

  const alpaca = new Alpaca(alpacaConfig);
  const clock = await alpaca.getClock();
  const marketOpen = !!clock.is_open;

  const { policy, result } = await runTick({
    alpacaConfig,
    marketOpen,
    clock,
  });

  const worldContext =
    (await loadLatestWorldContext().catch((err) => {
      console.error(
        "[world] failed to load latest world context:",
        err?.message ?? err
      );
      return null;
    })) ?? null;

  const resultWithWorld = {
    ...result,
    worldContext: result.worldContext ?? worldContext,
  };
  const worldUsed = resultWithWorld.worldContext ?? null;
  const worldAgeMinutes = getWorldContextAgeMinutes(worldUsed);
  console.log(`[VS] world_context_used ${describeWorldContext(worldUsed)}`);

  const lastOrder = await fetchLastOrder(alpaca);

  const { hour, minute } = getExchangeTimeParts();
  const exchangeDate = getExchangeDateString();
  const windowMinutes = Number(process.env.VS_EMAIL_EOD_WINDOW_MINUTES ?? 5);
  const inEodWindow = isWithinEodWindow(hour, minute, windowMinutes);
  const isFinalDecision = inEodWindow;
  if (isFinalDecision) {
    console.log(
      `[VS] final_decision_tick true (EOD window ±${windowMinutes}m)`
    );
  }
  resultWithWorld.finalDecision = isFinalDecision;
  resultWithWorld.worldContextAgeMinutes =
    typeof worldAgeMinutes === "number" ? Number(worldAgeMinutes.toFixed(2)) : null;

  const training = await trainPolicyFromHistoryLocal({
    minHistory: 10,
    equityDeltaThreshold: 0,
    maxStep: 0.01,
    minRisk: 0.1,
    maxRisk: 0.9,
    worldContext: resultWithWorld.worldContext ?? worldContext,
  });

  if (training) {
    const emailEnabled = !["0", "false", "no", "off"].includes(
      String(process.env.VS_EMAIL_POLICY_UPDATES ?? "true").toLowerCase()
    );
    const eodOnly = !["0", "false", "no", "off"].includes(
      String(process.env.VS_EMAIL_EOD_ONLY ?? "true").toLowerCase()
    );

    if (!emailEnabled) {
      console.log(
        "[ValueSteward] Lesson email disabled (VS_EMAIL_POLICY_UPDATES=false)."
      );
    } else {
      let shouldSendSummary = isFinalDecision;
      let agentState = null;
      if (shouldSendSummary) {
        agentState = await loadAgentState();
        const lastSummaryDate = agentState.last_eod_email_date ?? null;
        if (lastSummaryDate === exchangeDate) {
          shouldSendSummary = false;
          console.log(
            "[ValueSteward] EOD summary already sent for",
            exchangeDate
          );
        }
      }

      const shouldSendUpdate = training.updated && !eodOnly;

      if (shouldSendSummary || shouldSendUpdate) {
        try {
          const policyForEmail = training.newPolicy ?? policy;
          await sendLessonEmail({
            policy: policyForEmail,
            result: resultWithWorld,
            training,
            worldContext: resultWithWorld.worldContext ?? worldContext,
            emailMode: shouldSendSummary ? "summary" : "update",
            lastOrder,
          });
          console.log(
            shouldSendSummary
              ? "[ValueSteward] EOD summary email sent."
              : "[ValueSteward] Lesson email sent."
          );
          if (shouldSendSummary) {
            const updated = agentState ?? (await loadAgentState());
            updated.last_eod_email_date = exchangeDate;
            await saveAgentState(updated);
          }
        } catch (err) {
          console.error(
            "[ValueSteward] Failed to send lesson email:",
            err?.message ?? err
          );
        }
      }
    }
  }

  console.log("Value Steward executed (local):", {
    policy,
    result: resultWithWorld,
    training,
    finalDecision: isFinalDecision,
    worldContextAgeMinutes:
      typeof worldAgeMinutes === "number" ? Number(worldAgeMinutes.toFixed(2)) : null,
  });
}

main().catch((err) => {
  console.error("Fatal error in local tick:", err?.stack ?? err);
  process.exit(1);
});
