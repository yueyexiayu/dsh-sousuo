import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AnySearchClient, AnySearchClientError } from "../lib/client.js";
import { ANYSEARCH_HTTP_TIMEOUT_MS } from "../lib/limits.js";

const successBody = JSON.stringify({ code: 0, message: "success", data: {
  results: [{ title: "fixture result", url: "https://example.com/" }],
  metadata: { total_results: 1, search_time_ms: 1 },
} });

async function serverFixture(t, handler) {
  const server = http.createServer((request, response) => {
    request.resume();
    handler(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function interruptedError(t, response, status) {
  response.writeHead(status, { "content-type": "application/json", "content-length": "10000", "retry-after": "600" });
  response.flushHeaders();
  response.write("{");
  const timer = setTimeout(() => response.destroy(), 20);
  t.after(() => clearTimeout(timer));
}

function poolFixture() {
  let index = 0;
  let rotations = 0;
  return {
    current: async () => ({ key: `fixture-key-${index}`, index, count: 2 }),
    snapshot: async () => [index, (index + 1) % 2].map(n => ({ key: `fixture-key-${n}`, index: n, count: 2 })),
    advance: async (previous) => {
      assert.equal(previous, index);
      index = (index + 1) % 2;
      rotations++;
    },
    rotations: () => rotations,
  };
}

function client(baseURL, pool, transportHooks = {}) {
  return new AnySearchClient({ baseURL, pool, transportHooks: { proxyPolicy: 'direct', extraAttempts: 1, retryDelayMs: 0, ...transportHooks } });
}

for (const status of [401, 429]) {
  test(`interrupted HTTP ${status} body preserves status and retry-after without retrying`, { timeout: 5000 }, async (t) => {
    let calls = 0;
    const baseURL = await serverFixture(t, (_request, response) => {
      calls++;
      if (calls === 1) return interruptedError(t, response, status);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(successBody);
    });
    const pool = poolFixture();
    await assert.rejects(() => client(baseURL, pool).search({ query: "fixture" }, AbortSignal.timeout(2000)), error => {
      assert.ok(error instanceof AnySearchClientError);
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryAfter, "600");
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(pool.rotations(), 0);
  });
}

test("interrupted HTTP 402 body rotates to the next key instead of retrying the depleted key", { timeout: 5000 }, async (t) => {
  const keysUsed = [];
  const baseURL = await serverFixture(t, (request, response) => {
    keysUsed.push(request.headers.authorization);
    if (request.headers.authorization === "Bearer fixture-key-0") return interruptedError(t, response, 402);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(successBody);
  });
  const pool = poolFixture();
  const result = await client(baseURL, pool).search({ query: "fixture" }, AbortSignal.timeout(2000));
  assert.equal(result.results[0].title, "fixture result");
  assert.deepEqual(keysUsed, ["Bearer fixture-key-0", "Bearer fixture-key-1"]);
  assert.equal(pool.rotations(), 1);
});

test("interrupted HTTP 402 bodies stop after one complete key rotation", { timeout: 5000 }, async (t) => {
  const keysUsed = [];
  const baseURL = await serverFixture(t, (request, response) => {
    keysUsed.push(request.headers.authorization);
    interruptedError(t, response, 402);
  });
  const pool = poolFixture();
  await assert.rejects(() => client(baseURL, pool).search({ query: "fixture" }, AbortSignal.timeout(2000)), error => {
    assert.ok(error instanceof AnySearchClientError);
    assert.equal(error.httpStatus, 402);
    return true;
  });
  assert.deepEqual(keysUsed, ["Bearer fixture-key-0", "Bearer fixture-key-1"]);
  assert.equal(pool.rotations(), 2);
});

for (const status of [401, 402, 429]) {
  test(`caller cancellation takes precedence over HTTP ${status} while reading its body`, { timeout: 5000 }, async (t) => {
    let calls = 0;
    const baseURL = await serverFixture(t, (_request, response) => {
      calls++;
      response.writeHead(status, { "content-type": "application/json", "content-length": "10000" });
      response.write("{");
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    let arrived;
    const headersArrived = new Promise(resolve => { arrived = resolve; });
    const pool = poolFixture();
    const pending = client(baseURL, pool, { fetch: async (url, init) => {
      const response = await fetch(url, init);
      arrived();
      return response;
    } }).search({ query: "fixture" }, controller.signal);
    const rejected = assert.rejects(pending, error => error instanceof AnySearchClientError && error.kind === "aborted");
    await headersArrived;
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
    assert.equal(pool.rotations(), 0);
  });
}

test("the HTTP deadline takes precedence over a stalled 402 body without rotating", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let arrived;
  const headersArrived = new Promise(resolve => { arrived = resolve; });
  const pool = poolFixture();
  const pending = client("https://fixture.invalid", pool, { fetch: async (_url, init) => {
    calls++;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
    } });
    arrived();
    return new Response(body, { status: 402 });
  } }).search({ query: "fixture" });
  const rejected = assert.rejects(pending, error => {
    assert.ok(error instanceof AnySearchClientError);
    assert.match(error.message, new RegExp(`timed out after ${ANYSEARCH_HTTP_TIMEOUT_MS} ms`));
    assert.equal(error.httpStatus, undefined);
    return true;
  });
  await headersArrived;
  t.mock.timers.tick(ANYSEARCH_HTTP_TIMEOUT_MS);
  await rejected;
  assert.equal(calls, 1);
  assert.equal(pool.rotations(), 0);
});
