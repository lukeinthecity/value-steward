import test from "node:test";
import assert from "node:assert/strict";

import { createAlpacaRestClient } from "../core/alpacaRestClient.js";

// fetchImpl is injected so these tests never hit the real Alpaca API.

const CREDS = { keyId: "test-key", secretKey: "test-secret" };

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { impl, calls };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("throws immediately when credentials are missing", () => {
  const originalKey = process.env.ALPACA_API_KEY_ID;
  const originalSecret = process.env.ALPACA_SECRET_KEY;
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_SECRET_KEY;
  try {
    assert.throws(
      () => createAlpacaRestClient({}),
      /ALPACA_API_KEY_ID and ALPACA_SECRET_KEY/,
    );
  } finally {
    if (originalKey !== undefined) process.env.ALPACA_API_KEY_ID = originalKey;
    if (originalSecret !== undefined)
      process.env.ALPACA_SECRET_KEY = originalSecret;
  }
});

test("getAccount hits /v2/account with auth headers and returns the body", async () => {
  const account = { equity: "1000.50", cash: "250.00", status: "ACTIVE" };
  const { impl, calls } = fakeFetch(() => jsonResponse(account));
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example",
    fetchImpl: impl,
  });

  const result = await client.getAccount();

  assert.deepEqual(result, account);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://paper.example/v2/account");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers["APCA-API-KEY-ID"], "test-key");
  assert.equal(calls[0].options.headers["APCA-API-SECRET-KEY"], "test-secret");
});

test("getClock hits /v2/clock and returns the body", async () => {
  const clock = { is_open: true, next_open: "t1", next_close: "t2" };
  const { impl, calls } = fakeFetch(() => jsonResponse(clock));
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example",
    fetchImpl: impl,
  });

  const result = await client.getClock();

  assert.deepEqual(result, clock);
  assert.equal(calls[0].url, "https://paper.example/v2/clock");
});

test("getPositions hits /v2/positions and returns the array", async () => {
  const positions = [{ symbol: "SPY", qty: "1", market_value: "500.00" }];
  const { impl, calls } = fakeFetch(() => jsonResponse(positions));
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example",
    fetchImpl: impl,
  });

  const result = await client.getPositions();

  assert.deepEqual(result, positions);
  assert.equal(calls[0].url, "https://paper.example/v2/positions");
});

test("trailing slash on baseUrl does not double up in the request URL", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ is_open: false }));
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example/",
    fetchImpl: impl,
  });

  await client.getClock();

  assert.equal(calls[0].url, "https://paper.example/v2/clock");
});

test("non-2xx responses fail closed with the status code", async () => {
  const { impl } = fakeFetch(() =>
    jsonResponse({ message: "forbidden" }, { ok: false, status: 403 }),
  );
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example",
    fetchImpl: impl,
  });

  await assert.rejects(client.getAccount(), /HTTP 403/);
});

test("non-object account body fails closed", async () => {
  const { impl } = fakeFetch(() => jsonResponse(null));
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example",
    fetchImpl: impl,
  });

  await assert.rejects(client.getAccount(), /non-object body/);
});

test("non-array positions body fails closed", async () => {
  const { impl } = fakeFetch(() => jsonResponse({ unexpected: true }));
  const client = createAlpacaRestClient({
    ...CREDS,
    baseUrl: "https://paper.example",
    fetchImpl: impl,
  });

  await assert.rejects(client.getPositions(), /non-array body/);
});
