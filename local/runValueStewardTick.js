import "dotenv/config";
import Alpaca from "@alpacahq/alpaca-trade-api";
import {
  runTick,
  trainPolicyFromHistory,
  loadWorldContextFromGitHub,
  sendLessonEmail,
} from "../core/valueStewardAgent.js";

async function main() {
  const alpacaConfig = {
    keyId: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_API_SECRET,
    baseUrl: process.env.ALPACA_BASE_URL,
  };

  const githubToken = process.env.GITHUB_TOKEN;
  const alpaca = new Alpaca(alpacaConfig);

  const clock = await alpaca.getClock();
  const marketOpen = !!clock.is_open;

  const { policy, result } = await runTick({
    alpaca,
    githubToken,
    marketOpen,
    clock,
  });

  const worldContext =
    (await loadWorldContextFromGitHub(githubToken).catch((err) => {
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

  const training = await trainPolicyFromHistory({
    githubToken,
    minHistory: 10,
    equityDeltaThreshold: 0,
    maxStep: 0.01,
    minRisk: 0.1,
    maxRisk: 0.9,
    worldContext: resultWithWorld.worldContext ?? worldContext,
  });

  if (training && training.updated) {
    try {
      await sendLessonEmail({
        policy,
        result: resultWithWorld,
        training,
        worldContext: resultWithWorld.worldContext ?? worldContext,
      });
    } catch (err) {
      console.error(
        "[ValueSteward] Failed to send lesson email:",
        err?.message ?? err
      );
    }
  }

  console.log("Value Steward executed (local):", {
    policy,
    result: resultWithWorld,
    training,
  });
}

main().catch((err) => {
  console.error("Fatal error in local tick:", err?.stack ?? err);
  process.exit(1);
});
