// core/alpacaRestClient.js
// Minimal read-only Alpaca REST client replacing @alpacahq/alpaca-trade-api on
// the Node side (see docs/ALPACA_NODE_SDK_MAINTENANCE.txt). Python remains
// authoritative for all trade execution; this client only mirrors the three
// read endpoints the JS side ever used.

const DEFAULT_BASE_URL = "https://paper-api.alpaca.markets";
const DEFAULT_TIMEOUT_MS = 15000;

export function createAlpacaRestClient({
  keyId,
  secretKey,
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const resolvedKeyId = keyId ?? process.env.ALPACA_API_KEY_ID;
  const resolvedSecretKey = secretKey ?? process.env.ALPACA_SECRET_KEY;
  const resolvedBaseUrl = (
    baseUrl ??
    process.env.ALPACA_PAPER_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  if (!resolvedKeyId || !resolvedSecretKey) {
    throw new Error(
      "Alpaca REST client requires ALPACA_API_KEY_ID and ALPACA_SECRET_KEY.",
    );
  }

  async function requestJson(path) {
    const response = await fetchImpl(`${resolvedBaseUrl}${path}`, {
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": resolvedKeyId,
        "APCA-API-SECRET-KEY": resolvedSecretKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Alpaca REST GET ${path} failed: HTTP ${response.status}`,
      );
    }
    return response.json();
  }

  async function requestObject(path) {
    const body = await requestJson(path);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(`Alpaca REST GET ${path} returned a non-object body.`);
    }
    return body;
  }

  return {
    async getClock() {
      return requestObject("/v2/clock");
    },
    async getAccount() {
      return requestObject("/v2/account");
    },
    async getPositions() {
      const body = await requestJson("/v2/positions");
      if (!Array.isArray(body)) {
        throw new Error(
          "Alpaca REST GET /v2/positions returned a non-array body.",
        );
      }
      return body;
    },
  };
}
