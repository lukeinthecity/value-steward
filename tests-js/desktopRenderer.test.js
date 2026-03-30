import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererSource = fs.readFileSync(path.join(repoRoot, "desktop", "renderer.js"), "utf8");

function buildDom() {
  return new JSDOM(
    `<!doctype html>
    <body>
      <div id="guardian-meter"><div class="meter-fill"></div><div class="data-mono"></div></div>
      <div id="scout-meter"><div class="meter-fill"></div><div class="data-mono"></div></div>
      <div id="world-summary"></div>
      <div id="hud-exposure"></div>
      <div id="hud-equity"></div>
      <div id="hud-baseline"></div>
      <div id="intent-feed"></div>
      <div id="portfolio-positions"></div>
      <button id="refresh-data"></button>
      <div id="action-grid"></div>
      <div id="news-ticker"></div>
      <div id="next-tick"></div>
      <div id="tick-meta"></div>
      <div id="secret-status"></div>
      <div id="secret-storage-hint"></div>
      <button id="save-secrets"></button>
      <input id="conf-alpaca-id" />
      <input id="conf-alpaca-secret" />
      <input id="conf-gemini-key" />
      <input id="conf-smtp-pass" />
      <input id="conf-massive-key" />
      <div class="topbar"></div>
      <div id="fullscreen-trigger"></div>
    </body>`,
    { runScripts: "outside-only" }
  );
}

test("renderer prefers current portfolio artifacts and renders secret status without exposing values", async () => {
  const dom = buildDom();
  const { window } = dom;

  window.valueSteward = {
    loadDashboardData: async () => ({
      state: {
        current_mode: "LIVE",
        trading_enabled: true,
        last_run_at: "2026-03-20T15:59:37.786240+00:00",
      },
      portfolio: {
        updated_at: "2026-03-20T15:59:37.786240+00:00",
        snapshot: {
          timestamp: "2026-03-20T15:59:37.658491+00:00",
          cash: 99944.45,
          equity: 99976.0,
          risk_exposure_pct: 0.00031558623069536686,
        },
        positions: [
          { symbol: "CUB", market_value: 5.01 },
          { symbol: "WMB", market_value: 5.0 },
        ],
      },
      latestTick: {
        generated_at: "2026-03-19T19:55:15.338804Z",
        result: {
          positions: [
            { symbol: "CUB", marketValue: 5.0, side: "long", unrealizedPl: 0.01, unrealizedPlPc: 0.002 },
            { symbol: "WMB", marketValue: 5.0, side: "long", unrealizedPl: -0.02, unrealizedPlPc: -0.004 },
          ],
        },
      },
      world: {
        macro_view: { macro_label: "calm", macro_score: 0.1 },
        final_regime: {
          final_label: "stressed",
          final_score: 0.7,
          divergence: true,
          source: "scout_more_cautious",
          fusion_reason: "scout_more_cautious",
        },
        scout_score: 0.7,
        scout_label: "stressed",
        summary: "summary",
        scout_thesis: "A cautious macro thesis.",
        scout_headlines: ["Headline one", "Headline two"],
      },
      history: {
        ranAt: "2026-03-19T19:55:15.338804Z",
        equity: 100000,
        cash: 84000,
        grossExposure: 16000,
        positions: [{ symbol: "SPY", marketValue: 1.5, side: "long", unrealizedPl: 0, unrealizedPlPc: 0 }],
      },
      intents: [
        {
          timestamp: "2026-03-18T19:30:16.921812Z",
          action_type: "BUY",
          symbol: "CUB",
        },
        {
          timestamp: "2026-03-19T19:40:12.000000Z",
          action_type: "BUY",
          symbol: "WMB",
        },
      ],
      secretStatus: {
        storageAvailable: true,
        secrets: {
          ALPACA_API_KEY_ID: { configured: true, source: "secure_store" },
          ALPACA_SECRET_KEY: { configured: true, source: ".env_fallback" },
          GOOGLE_GENAI_API_KEY: { configured: false, source: null },
          SMTP_PASS: { configured: false, source: null },
          MASSIVE_API_KEY: { configured: true, source: "secure_store" },
        },
      },
    }),
    runAction: async () => ({ output: "" }),
    setSecrets: async () => ({ storageAvailable: true, secrets: {} }),
    clearSecret: async () => ({ storageAvailable: true, secrets: {} }),
  };

  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  vm.runInContext(rendererSource, dom.getInternalVMContext());

  await new Promise((resolve) => setTimeout(resolve, 0));

  const rendered = [...window.document.querySelectorAll("#portfolio-positions .position-card strong")].map(
    (node) => node.textContent
  );
  const portfolioText = window.document.querySelector("#portfolio-positions").textContent;
  const tickerText = window.document.querySelector("#news-ticker").textContent;
  const worldSummaryText = window.document.querySelector("#world-summary").textContent;
  const secretStatusText = window.document.querySelector("#secret-status").textContent;

  assert.deepEqual(rendered, ["CUB", "WMB"]);
  assert.equal(portfolioText.includes("SPY"), false);
  assert.equal(portfolioText.includes("$0.01 (0.20%)"), true);
  assert.equal(portfolioText.includes("-$0.02 (-0.40%)"), true);
  assert.equal(portfolioText.includes("Held Since"), true);
  assert.equal(portfolioText.includes("3/18/2026"), true);
  assert.equal(portfolioText.includes("3/19/2026"), true);
  assert.equal(window.document.querySelector("#hud-equity").textContent.includes("$99,976.00"), true);
  assert.equal(worldSummaryText.includes("System Regime: STRESSED"), true);
  assert.equal(worldSummaryText.includes("System Logic:"), true);
  assert.equal(worldSummaryText.includes("Deterministic: CALM"), true);
  assert.equal(worldSummaryText.includes("Probabilistic: STRESSED"), true);
  assert.equal(worldSummaryText.includes("Logic Status: Divergent"), true);
  assert.equal(worldSummaryText.includes("Fusion Reason: Probabilistic view more cautious"), true);
  assert.equal(
    worldSummaryText.includes("Baseline: Deterministic signals classified conditions as Calm."),
    true
  );
  assert.equal(
    worldSummaryText.includes("Overlay: Probabilistic signals classified conditions as Stressed."),
    true
  );
  assert.equal(
    worldSummaryText.includes("Resolution: The two reasoning modes diverged, so the system resolved to Stressed because probabilistic view more cautious."),
    true
  );
  assert.equal(
    worldSummaryText.includes("Decision Impact: By EOD, Value Steward may keep deployment constrained and reject lower-conviction buys."),
    true
  );
  assert.equal(window.document.querySelector("#tick-meta").textContent.includes("03/20/2026"), true);
  assert.equal(tickerText.includes("Headline one"), true);
  assert.equal(tickerText.includes(" // "), true);
  assert.equal(secretStatusText.includes("Stored securely"), true);
  assert.equal(secretStatusText.includes("Using .env fallback"), true);
  assert.equal(secretStatusText.includes("Missing"), true);
  assert.equal(secretStatusText.includes("test-key"), false);
  const clearButtons = [...window.document.querySelectorAll("#secret-status .secret-clear")];
  assert.equal(clearButtons[0].disabled, false);
  assert.equal(clearButtons[1].disabled, true);
  assert.equal(window.document.querySelector("#save-secrets").disabled, false);
  assert.equal(typeof window.__VS_RENDERER_TEST__.computeTickerTravelWidth, "function");
  assert.equal(window.__VS_RENDERER_TEST__.computeTickerTravelWidth({ scrollWidth: 960 }), 320);
  assert.equal(window.__VS_RENDERER_TEST__.normalizeTickerOffset(-640, 320), 0);

  window.document.querySelector("#conf-alpaca-id").value = "abc";
  window.document.querySelector("#conf-gemini-key").value = "xyz";
  const updates = JSON.parse(JSON.stringify(window.__VS_RENDERER_TEST__.collectSecretUpdates()));
  assert.deepEqual(updates, {
    ALPACA_API_KEY_ID: "abc",
    GOOGLE_GENAI_API_KEY: "xyz",
  });
});
