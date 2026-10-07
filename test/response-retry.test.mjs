import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AnySearchClient, AnySearchClientError } from "../lib/client.js";
import { fetchWithFailover } from "../lib/transport.js";

const successBody = JSON.stringify({
  code: 0,
  message: "success",
  data: {
    results: [{ title: "fixture result", url: "https://example.com/" }],
    metadata: { total_results: 1, search_time_ms: 1 },
  },
});

function trackedResponse(t, status, { final = false } = {}) {
  let cancellations = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: `fixture ${status}` })));
      if (final) controller.close();
    },
    cancel() { cancellations += 1; },
  });
  const response = new Response(body, { status });
  t.after(async () => {
    if (!body.locked) await body.cancel().catch(() => undefined);
  });
  return { response, cancellations: () => cancellations };
}

for (const status of [502, 503, 504]) {
  test(`discarded HTTP ${status} response is cancelled before the successful retry`, async (t) => {
    const failed = trackedResponse(t, status);
    let calls = 0;
    const response = await fetchWithFailover("https://fixture.invalid/v1/search", {}, {
      retryDelayMs: 0,
      extraAttempts: 1,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return failed.response;
        assert.equal(failed.cancellations(), 1, "release the previous response before another request");
        return new Response("success");
      },
      resolveFallbackAddresses: async () => { throw new Error("no DNS fallback expected"); },
    });
    assert.equal(await response.text(), "success");
    assert.equal(calls, 2);
    assert.equal(failed.cancellations(), 1);
  });
}

test("multiple system and pinned retries release old responses while the final error body remains readable", async (t) => {
  const discarded = [502, 503, 504].map(status => trackedResponse(t, status));
  const final = trackedResponse(t, 503, { final: true });
  let systemCalls = 0;
  let pinnedCalls = 0;
  const response = await fetchWithFailover("https://fixture.invalid/v1/search", {}, {
    proxyPolicy: 'direct',
    retryDelayMs: 0,
    extraAttempts: 1,
    fetch: async () => discarded[systemCalls++].response,
    resolveFallbackAddresses: async () => ["203.0.113.10", "203.0.113.11"],
    pinnedFetch: async () => pinnedCalls++ === 0 ? discarded[2].response : final.response,
  });
  assert.equal(systemCalls, 2);
  assert.equal(pinnedCalls, 2);
  assert.deepEqual(discarded.map(value => value.cancellations()), [1, 1, 1]);
  assert.equal(final.cancellations(), 0);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: "fixture 503" });
});

async function httpFixture(t, handler) {
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

function interruptBody(t, response) {
  response.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
  response.flushHeaders();
  response.write("{");
  const timer = setTimeout(() => response.destroy(), 20);
  t.after(() => clearTimeout(timer));
}

function client(baseURL, transportHooks = {}) {
  return new AnySearchClient({
    baseURL,
    pool: { snapshot: async () => [{ key: "fixture-only", index: 0, count: 1 }] },
    transportHooks: { proxyPolicy: 'direct', retryDelayMs: 0, extraAttempts: 1, ...transportHooks },
  });
}

test("a system fetch body interrupted after HTTP 200 retries and accepts the next complete response", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const baseURL = await httpFixture(t, (_request, response) => {
    calls += 1;
    if (calls === 1) return interruptBody(t, response);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(successBody);
  });
  const result = await client(baseURL).search({ query: "fixture" }, AbortSignal.timeout(2000));
  assert.equal(result.results[0].title, "fixture result");
  assert.equal(calls, 2);
});

test("all interrupted response bodies report a network failure rather than invalid JSON", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const baseURL = await httpFixture(t, (_request, response) => {
    calls += 1;
    interruptBody(t, response);
  });
  await assert.rejects(() => client(baseURL).search({ query: "fixture" }, AbortSignal.timeout(2000)), error => {
    assert.ok(error instanceof AnySearchClientError);
    assert.match(error.message, /request failed/);
    assert.doesNotMatch(error.message, /invalid JSON/);
    return true;
  });
  assert.equal(calls, 2);
});

test("a complete response containing malformed JSON fails without retrying", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const baseURL = await httpFixture(t, (_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{ malformed fixture }");
  });
  await assert.rejects(() => client(baseURL).search({ query: "fixture" }, AbortSignal.timeout(2000)), error => {
    assert.ok(error instanceof AnySearchClientError);
    assert.match(error.message, /invalid JSON/);
    return true;
  });
  assert.equal(calls, 1);
});

test("cancelling while reading the response body stops without retrying", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const baseURL = await httpFixture(t, (_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
    response.write("{");
  });
  let headersArrived;
  const arrived = new Promise(resolve => { headersArrived = resolve; });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = client(baseURL, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      headersArrived();
      return response;
    },
  }).search({ query: "fixture" }, controller.signal);
  const rejected = assert.rejects(pending, error => error instanceof AnySearchClientError && error.kind === "aborted");
  await arrived;
  controller.abort();
  await rejected;
  assert.equal(calls, 1);
});

test("interrupted system response bodies continue to the IPv4 fallback", { timeout: 5000 }, async (t) => {
  let calls = 0;
  let lookups = 0;
  const localURL = await httpFixture(t, (_request, response) => {
    calls += 1;
    if (calls <= 2) return interruptBody(t, response);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(successBody);
  });
  const baseURL = localURL.replace("127.0.0.1", "fixture.invalid");
  const result = await client(baseURL, {
    fetch: (url, init) => fetch(url.replace("fixture.invalid", "127.0.0.1"), init),
    resolveFallbackAddresses: async hostname => {
      lookups += 1;
      assert.equal(hostname, "fixture.invalid");
      return ["127.0.0.1"];
    },
  }).search({ query: "fixture" }, AbortSignal.timeout(2000));
  assert.equal(result.results[0].title, "fixture result");
  assert.equal(calls, 3);
  assert.equal(lookups, 1);
});

test("cancellation during the retry delay releases the retained HTTP error response", { timeout: 5000 }, async (t) => {
  const failed = trackedResponse(t, 503);
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchWithFailover("https://fixture.invalid/v1/search", { signal: controller.signal }, {
    extraAttempts: 1,
    retryDelayMs: 20000,
    fetch: async () => { calls += 1; return failed.response; },
    resolveFallbackAddresses: async () => { throw new Error("DNS must not run after cancellation"); },
  });
  const rejected = assert.rejects(pending, error => error.name === "AbortError");
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(calls, 1);
  assert.equal(failed.cancellations(), 1);
});

test("cancellation during DNS releases the retained HTTP error response", { timeout: 5000 }, async (t) => {
  const failed = trackedResponse(t, 504);
  const controller = new AbortController();
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  let pinnedCalls = 0;
  const pending = fetchWithFailover("https://fixture.invalid/v1/search", { signal: controller.signal }, {
    proxyPolicy: 'direct',
    extraAttempts: 0,
    fetch: async () => failed.response,
    resolveFallbackAddresses: async (_hostname, _fetch, signal) => {
      lookupStarted();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      return ["127.0.0.1"];
    },
    pinnedFetch: async () => { pinnedCalls += 1; throw new Error("no request after cancellation"); },
  });
  const rejected = assert.rejects(pending, error => error.name === "AbortError");
  await started;
  controller.abort();
  await rejected;
  assert.equal(pinnedCalls, 0);
  assert.equal(failed.cancellations(), 1);
});

test("an unfinished HTTP 503 connection closes after the successful retry", { timeout: 5000 }, async (t) => {
  let calls = 0;
  let abandonedClosed;
  const closed = new Promise(resolve => { abandonedClosed = resolve; });
  const baseURL = await httpFixture(t, (_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.on("close", abandonedClosed);
      response.writeHead(503, { "content-type": "application/json" });
      response.write("{");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(successBody);
  });
  const result = await client(baseURL).search({ query: "fixture" }, AbortSignal.timeout(2000));
  assert.equal(result.results[0].title, "fixture result");
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("discarded HTTP connection stayed open")), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(calls, 2);
});
