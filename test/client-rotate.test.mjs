import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AnySearchClient, AnySearchClientError } from "../lib/client.js";
import { KeyPool } from "../lib/keys.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okSearch() {
  return jsonResponse(200, {
    code: 0,
    message: "success",
    data: {
      results: [{ title: "ok", url: "https://example.com/" }],
      metadata: { total_results: 1, search_time_ms: 1 },
    },
  });
}

test("402 on first key retries second key in the same request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  await writeFile(path.join(dir, "keys"), "k1\nk2\n", { mode: 0o600 });
  const pool = new KeyPool({
    keysPath: path.join(dir, "keys"),
    statePath: path.join(dir, "state.json"),
  });
  const auths = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const auth = init.headers.authorization;
    auths.push(auth);
    if (auth === "Bearer k1") return jsonResponse(402, { code: -1, message: "quota" });
    return okSearch();
  };
  try {
    const client = new AnySearchClient({ pool, baseURL: "https://api.anysearch.com" });
    const result = await client.search({ query: "test", maxResults: 1 });
    assert.equal(result.results[0].url, "https://example.com/");
    assert.deepEqual(auths, ["Bearer k1", "Bearer k2"]);
    assert.equal((await pool.current()).index, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one request stops after a full lap of 402", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  await writeFile(path.join(dir, "keys"), "k1\nk2\n", { mode: 0o600 });
  const pool = new KeyPool({
    keysPath: path.join(dir, "keys"),
    statePath: path.join(dir, "state.json"),
  });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(402, { code: -1, message: "quota" });
  };
  try {
    const client = new AnySearchClient({ pool, baseURL: "https://api.anysearch.com" });
    await assert.rejects(
      () => client.search({ query: "test" }),
      (error) => error instanceof AnySearchClientError && error.httpStatus === 402,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch failed on first attempt retries the same key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  await writeFile(path.join(dir, "keys"), "k1\nk2\n", { mode: 0o600 });
  const pool = new KeyPool({
    keysPath: path.join(dir, "keys"),
    statePath: path.join(dir, "state.json"),
  });
  let calls = 0;
  const client = new AnySearchClient({
    pool,
    baseURL: "https://api.anysearch.com",
    transportHooks: {
      retryDelayMs: 0,
      extraAttempts: 1,
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return okSearch();
      },
      resolveFallbackAddresses: async () => {
        throw new Error("fallback should not run");
      },
    },
  });
  const result = await client.search({ query: "test" });
  assert.equal(result.results[0].url, "https://example.com/");
  assert.equal(calls, 2);
  assert.equal((await pool.current()).index, 0);
});

test("exhausted fetch failed surfaces the network cause", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  await writeFile(path.join(dir, "keys"), "k1\n", { mode: 0o600 });
  const pool = new KeyPool({
    keysPath: path.join(dir, "keys"),
    statePath: path.join(dir, "state.json"),
  });
  const failure = new TypeError("fetch failed");
  failure.cause = { code: "ECONNRESET", address: "179.255.102.224" };
  const client = new AnySearchClient({
    pool,
    baseURL: "https://api.anysearch.com",
    transportHooks: {
      retryDelayMs: 0,
      extraAttempts: 1,
      fetch: async () => {
        throw failure;
      },
      resolveFallbackAddresses: async () => [],
    },
  });
  await assert.rejects(
    () => client.search({ query: "test" }),
    (error) => error instanceof AnySearchClientError
      && error.message.includes("TypeError: fetch failed")
      && error.message.includes("ECONNRESET")
      && error.message.includes("179.255.102.224"),
  );
});

test("401 does not rotate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  await writeFile(path.join(dir, "keys"), "k1\nk2\n", { mode: 0o600 });
  const pool = new KeyPool({
    keysPath: path.join(dir, "keys"),
    statePath: path.join(dir, "state.json"),
  });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(401, { code: -1, message: "bad key" });
  };
  try {
    const client = new AnySearchClient({ pool, baseURL: "https://api.anysearch.com" });
    await assert.rejects(() => client.search({ query: "test" }));
    assert.equal(calls, 1);
    assert.equal((await pool.current()).index, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
