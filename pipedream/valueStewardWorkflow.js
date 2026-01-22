// This file is meant to be COPY-PASTED into a Pipedream Node.js step.
// Expected env vars: ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_BASE_URL, GITHUB_TOKEN.

import { runTick } from "../core/tick.js";

export default defineComponent({
  async run({ steps, $ }) {
    const alpacaConfig = {
      keyId: process.env.ALPACA_API_KEY,
      secretKey: process.env.ALPACA_API_SECRET,
      baseUrl: process.env.ALPACA_BASE_URL,
    };

    const githubToken = process.env.GITHUB_TOKEN;

    const { policy, result } = await runTick({
      alpacaConfig,
      githubToken,
    });

    console.log("Value Steward executed:", { policy, result });

    return { policy, result };
  },
});
