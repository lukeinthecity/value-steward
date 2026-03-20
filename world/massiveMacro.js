import { restClient } from "@massive.com/client-js";

function latestResult(response) {
  return Array.isArray(response?.results) && response.results.length
    ? response.results[0]
    : null;
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveMassiveConfig(env = process.env) {
  return {
    apiKey: String(env.MASSIVE_API_KEY || "").trim(),
    baseUrl: String(env.MASSIVE_REST_URL || "https://api.massive.com").trim(),
  };
}

export function createMassiveRestClient(apiKey, baseUrl) {
  return restClient(apiKey, baseUrl);
}

export function summarizeMassiveMacroContext(massiveMacro) {
  if (!massiveMacro || massiveMacro.status !== "ok") {
    const reason = massiveMacro?.reason || massiveMacro?.error || "unavailable";
    return `Massive macro unavailable (${reason})`;
  }

  const yields = massiveMacro.treasury_yields ?? {};
  const inflation = massiveMacro.inflation ?? {};
  const expectations = massiveMacro.inflation_expectations ?? {};
  const labor = massiveMacro.labor_market ?? {};

  const parts = [
    yields.yield_2_year !== null && yields.yield_10_year !== null
      ? `UST 2Y=${yields.yield_2_year?.toFixed(2)} 10Y=${yields.yield_10_year?.toFixed(2)}`
      : null,
    yields.curve_10y_2y_bps !== null
      ? `curve_10y_2y=${yields.curve_10y_2y_bps?.toFixed(1)}bp`
      : null,
    inflation.cpi_year_over_year !== null
      ? `CPI YoY=${inflation.cpi_year_over_year?.toFixed(2)}%`
      : null,
    expectations.market_5_year !== null && expectations.market_10_year !== null
      ? `breakeven 5Y=${expectations.market_5_year?.toFixed(2)}% 10Y=${expectations.market_10_year?.toFixed(2)}%`
      : null,
    labor.unemployment_rate !== null
      ? `unemployment=${labor.unemployment_rate?.toFixed(2)}%`
      : null,
  ].filter(Boolean);

  return parts.length ? parts.join(" | ") : "Massive macro available";
}

export async function fetchMassiveMacroContext({ client, env = process.env } = {}) {
  const { apiKey, baseUrl } = resolveMassiveConfig(env);
  const fetchedAt = new Date().toISOString();

  if (!apiKey) {
    return {
      provider: "massive",
      status: "unavailable",
      reason: "missing_api_key",
      fetched_at: fetchedAt,
      treasury_yields: null,
      inflation: null,
      inflation_expectations: null,
      labor_market: null,
    };
  }

  const massive = client ?? createMassiveRestClient(apiKey, baseUrl);

  try {
    const [treasuryResponse, inflationResponse, expectationsResponse, laborResponse] =
      await Promise.all([
        massive.getFedV1TreasuryYields({ limit: 1, sort: "desc" }),
        massive.getFedV1Inflation({ limit: 1, sort: "desc" }),
        massive.getFedV1InflationExpectations({ limit: 1, sort: "desc" }),
        massive.getFedV1LaborMarket({ limit: 1, sort: "desc" }),
      ]);

    const treasury = latestResult(treasuryResponse);
    const inflation = latestResult(inflationResponse);
    const expectations = latestResult(expectationsResponse);
    const labor = latestResult(laborResponse);

    if (!treasury && !inflation && !expectations && !labor) {
      return {
        provider: "massive",
        status: "unavailable",
        reason: "no_data",
        fetched_at: fetchedAt,
        treasury_yields: null,
        inflation: null,
        inflation_expectations: null,
        labor_market: null,
      };
    }

    const yield2y = parseNumber(treasury?.yield_2_year);
    const yield10y = parseNumber(treasury?.yield_10_year);

    return {
      provider: "massive",
      status: "ok",
      reason: null,
      fetched_at: fetchedAt,
      treasury_yields: {
        date: treasury?.date ?? null,
        yield_2_year: yield2y,
        yield_10_year: yield10y,
        yield_30_year: parseNumber(treasury?.yield_30_year),
        yield_3_month: parseNumber(treasury?.yield_3_month),
        curve_10y_2y_bps:
          yield2y !== null && yield10y !== null
            ? (yield10y - yield2y) * 100
            : null,
      },
      inflation: {
        date: inflation?.date ?? null,
        cpi_year_over_year: parseNumber(inflation?.cpi_year_over_year),
        cpi_core: parseNumber(inflation?.cpi_core),
        pce: parseNumber(inflation?.pce),
        pce_core: parseNumber(inflation?.pce_core),
      },
      inflation_expectations: {
        date: expectations?.date ?? null,
        market_5_year: parseNumber(expectations?.market_5_year),
        market_10_year: parseNumber(expectations?.market_10_year),
        forward_years_5_to_10: parseNumber(expectations?.forward_years_5_to_10),
        model_1_year: parseNumber(expectations?.model_1_year),
      },
      labor_market: {
        date: labor?.date ?? null,
        unemployment_rate: parseNumber(labor?.unemployment_rate),
        labor_force_participation_rate: parseNumber(
          labor?.labor_force_participation_rate
        ),
        avg_hourly_earnings: parseNumber(labor?.avg_hourly_earnings),
        job_openings: parseNumber(labor?.job_openings),
      },
    };
  } catch (err) {
    return {
      provider: "massive",
      status: "error",
      reason: "request_failed",
      error: err?.message ?? String(err),
      fetched_at: fetchedAt,
      treasury_yields: null,
      inflation: null,
      inflation_expectations: null,
      labor_market: null,
    };
  }
}
