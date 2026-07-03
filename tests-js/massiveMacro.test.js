import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function importMassiveMacro() {
  const moduleUrl = `${pathToFileURL(path.join(repoRoot, "world", "massiveMacro.js")).href}?v=${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

test("fetchMassiveMacroContext returns unavailable without an API key", async () => {
  const { fetchMassiveMacroContext, summarizeMassiveMacroContext } =
    await importMassiveMacro();

  const macro = await fetchMassiveMacroContext({ env: {} });

  assert.equal(macro.status, "unavailable");
  assert.equal(macro.reason, "missing_api_key");
  assert.equal(
    summarizeMassiveMacroContext(macro),
    "Massive macro unavailable (missing_api_key)",
  );
});

test("fetchMassiveMacroContext returns unavailable when provider returns no rows", async () => {
  const { fetchMassiveMacroContext, summarizeMassiveMacroContext } =
    await importMassiveMacro();

  const emptyClient = {
    async getFedV1TreasuryYields() {
      return { results: [] };
    },
    async getFedV1Inflation() {
      return { results: [] };
    },
    async getFedV1InflationExpectations() {
      return { results: [] };
    },
    async getFedV1LaborMarket() {
      return { results: [] };
    },
  };

  const macro = await fetchMassiveMacroContext({
    client: emptyClient,
    env: { MASSIVE_API_KEY: "test-key" },
  });

  assert.equal(macro.status, "unavailable");
  assert.equal(macro.reason, "no_data");
  assert.equal(
    summarizeMassiveMacroContext(macro),
    "Massive macro unavailable (no_data)",
  );
});

test("fetchMassiveMacroContext normalizes latest economic series", async () => {
  const { fetchMassiveMacroContext, summarizeMassiveMacroContext } =
    await importMassiveMacro();

  const client = {
    async getFedV1TreasuryYields() {
      return {
        results: [
          {
            date: "2026-03-19",
            yield_2_year: 4.1,
            yield_10_year: 3.95,
            yield_30_year: 4.3,
            yield_3_month: 4.45,
          },
        ],
      };
    },
    async getFedV1Inflation() {
      return {
        results: [
          {
            date: "2026-02-01",
            cpi_year_over_year: 3.2,
            cpi_core: 3.4,
            pce: 2.8,
            pce_core: 2.9,
          },
        ],
      };
    },
    async getFedV1InflationExpectations() {
      return {
        results: [
          {
            date: "2026-03-01",
            market_5_year: 2.4,
            market_10_year: 2.3,
            forward_years_5_to_10: 2.2,
            model_1_year: 2.7,
          },
        ],
      };
    },
    async getFedV1LaborMarket() {
      return {
        results: [
          {
            date: "2026-02-01",
            unemployment_rate: 4.1,
            labor_force_participation_rate: 62.6,
            avg_hourly_earnings: 35.12,
            job_openings: 8100,
          },
        ],
      };
    },
  };

  const macro = await fetchMassiveMacroContext({
    client,
    env: { MASSIVE_API_KEY: "test-key" },
  });

  assert.equal(macro.status, "ok");
  assert.equal(macro.treasury_yields.date, "2026-03-19");
  assert.equal(macro.treasury_yields.yield_2_year, 4.1);
  assert.equal(macro.treasury_yields.yield_10_year, 3.95);
  assert.ok(Math.abs(macro.treasury_yields.curve_10y_2y_bps + 15) < 0.001);
  assert.equal(macro.inflation.cpi_year_over_year, 3.2);
  assert.equal(macro.inflation_expectations.market_5_year, 2.4);
  assert.equal(macro.labor_market.unemployment_rate, 4.1);
  assert.match(summarizeMassiveMacroContext(macro), /UST 2Y=4.10 10Y=3.95/);
});

test("fetchMassiveMacroContext returns soft error on client failure", async () => {
  const { fetchMassiveMacroContext, summarizeMassiveMacroContext } =
    await importMassiveMacro();

  const client = {
    async getFedV1TreasuryYields() {
      throw new Error("403 Forbidden");
    },
    async getFedV1Inflation() {
      return { results: [] };
    },
    async getFedV1InflationExpectations() {
      return { results: [] };
    },
    async getFedV1LaborMarket() {
      return { results: [] };
    },
  };

  const macro = await fetchMassiveMacroContext({
    client,
    env: { MASSIVE_API_KEY: "test-key" },
  });

  assert.equal(macro.status, "error");
  assert.equal(macro.reason, "request_failed");
  assert.match(String(macro.error), /403 Forbidden/);
  assert.equal(
    summarizeMassiveMacroContext(macro),
    "Massive macro unavailable (request_failed)",
  );
});
