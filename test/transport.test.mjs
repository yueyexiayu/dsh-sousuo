import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  describeNetworkError,
  fetchWithFailover,
  isRetryableFetchFailure,
  pinnedHttpsFetch,
  resolveFallbackAddresses,
} from "../lib/transport.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("describeNetworkError includes cause code", () => {
  const error = new TypeError("fetch failed");
  error.cause = { code: "ECONNRESET", syscall: "connect", address: "179.255.102.224" };
  assert.match(describeNetworkError(error), /TypeError: fetch failed \(ECONNRESET connect 179\.255\.102\.224\)/);
});

test("isRetryableFetchFailure accepts TypeError fetch failed", () => {
  assert.equal(isRetryableFetchFailure(new TypeError("fetch failed")), true);
  assert.equal(isRetryableFetchFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isRetryableFetchFailure(new DOMException("Aborted", "AbortError")), false);
  const redirected = new TypeError("fetch failed");
  redirected.cause = { code: "UND_ERR_RESPONSE_REDIRECTED" };
  assert.equal(isRetryableFetchFailure(redirected), false);
});

test("fetchWithFailover retries a TypeError then succeeds", async () => {
  const calls = [];
  const response = jsonResponse(200, { ok: true });
  const result = await fetchWithFailover("https://api.anysearch.com/v1/search", { method: "POST" }, {
    retryDelayMs: 0,
    extraAttempts: 1,
    fetch: async () => {
      calls.push("fetch");
      if (calls.length === 1) throw new TypeError("fetch failed");
      return response;
    },
    resolveFallbackAddresses: async () => {
      throw new Error("fallback should not run");
    },
  });
  assert.equal(result, response);
  assert.deepEqual(calls, ["fetch", "fetch"]);
});

test("fetchWithFailover pins public-DNS IPs after system fetch keeps failing", async () => {
  const calls = [];
  const pinned = jsonResponse(200, { ok: true });
  const result = await fetchWithFailover("https://api.anysearch.com/v1/search", { method: "POST" }, {
    retryDelayMs: 0,
    extraAttempts: 1,
    fetch: async () => {
      calls.push("fetch");
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    },
    resolveFallbackAddresses: async (hostname) => {
      calls.push(`resolve:${hostname}`);
      return ["203.0.113.10", "203.0.113.11"];
    },
    pinnedFetch: async (_url, _init, address) => {
      calls.push(`pin:${address}`);
      if (address === "203.0.113.10") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return pinned;
    },
  });
  assert.equal(result, pinned);
  assert.deepEqual(calls, [
    "fetch",
    "fetch",
    "resolve:api.anysearch.com",
    "pin:203.0.113.10",
    "pin:203.0.113.11",
  ]);
});

test("fetchWithFailover retries HTTP 503 then returns success", async () => {
  const statuses = [];
  const result = await fetchWithFailover("https://api.anysearch.com/v1/search", { method: "GET" }, {
    retryDelayMs: 0,
    extraAttempts: 1,
    fetch: async () => {
      const status = statuses.length === 0 ? 503 : 200;
      statuses.push(status);
      return jsonResponse(status, { ok: status === 200 });
    },
    resolveFallbackAddresses: async () => {
      throw new Error("fallback should not run");
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(statuses, [503, 200]);
});

test("fetchWithFailover does not retry a redirect TypeError", async () => {
  let calls = 0;
  const redirected = new TypeError("fetch failed");
  redirected.cause = { code: "UND_ERR_RESPONSE_REDIRECTED" };
  await assert.rejects(
    () => fetchWithFailover("https://api.anysearch.com/v1/search", { method: "POST" }, {
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        throw redirected;
      },
    }),
    redirected,
  );
  assert.equal(calls, 1);
});

test("resolveFallbackAddresses reads A records from DoH JSON", async () => {
  const ips = await resolveFallbackAddresses("api.anysearch.com", async () => jsonResponse(200, {
    Answer: [
      { type: 5, data: "cn.gtm.anysearch.com." },
      { type: 1, data: "65.9.126.9" },
      { type: 1, data: "65.9.126.80" },
    ],
  }));
  assert.deepEqual(ips, ["65.9.126.9", "65.9.126.80"]);
});

test("pinnedHttpsFetch connects by overridden lookup", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host: request.headers.host, url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await pinnedHttpsFetch(
      `http://anysearch.test:${port}/v1/search`,
      { method: "POST", headers: { accept: "application/json" }, body: "{}" },
      "127.0.0.1",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.url, "/v1/search");
    assert.equal(body.host, `anysearch.test:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
