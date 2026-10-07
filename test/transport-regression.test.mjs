import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dgram from "node:dgram";
import { Resolver } from "node:dns/promises";
import { pinnedHttpsFetch as rawPinnedFetch, resolveFallbackAddresses } from "../lib/transport.js";
const pinnedHttpsFetch = (url, init, address) => rawPinnedFetch(url, init, address, { proxyPolicy: "direct" });

async function bounded(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test operation did not settle")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function httpFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://anysearch.test:${server.address().port}/v1/search`;
}

test("pinned transport rejects a truncated response instead of hanging", async (t) => {
  const url = await httpFixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": "1000" });
    response.write("{");
    setTimeout(() => response.destroy(), 10);
  });
  await assert.rejects(
    () => bounded(pinnedHttpsFetch(url, { method: "POST" }, "127.0.0.1").then(response => response.text())),
    error => error.code === "ECONNRESET",
  );
});

test("pinned transport settles after cancellation during response reading", async (t) => {
  let responseStarted;
  const started = new Promise(resolve => responseStarted = resolve);
  const url = await httpFixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": "1000" });
    response.write("{");
    responseStarted();
  });
  const controller = new AbortController();
  const pending = pinnedHttpsFetch(url, { signal: controller.signal }, "127.0.0.1").then(response => response.text());
  await bounded(started);
  controller.abort();
  await assert.rejects(() => bounded(pending), error => error.name === "AbortError");
});

test("pinned transport supports null-body HTTP statuses", async (t) => {
  for (const status of [204, 205, 304]) {
    const url = await httpFixture(t, (_request, response) => {
      response.writeHead(status);
      response.end();
    });
    const result = await bounded(pinnedHttpsFetch(url, {}, "127.0.0.1"));
    assert.equal(result.status, status);
    assert.equal(result.body, null);
  }
});

test("pinned transport catches Response construction errors", async (t) => {
  const url = await httpFixture(t, (_request, response) => {
    response.writeHead(700);
    response.end("invalid status");
  });
  await assert.rejects(() => bounded(pinnedHttpsFetch(url, {}, "127.0.0.1")), RangeError);
});

test("already aborted DNS lookup makes no outbound request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    () => resolveFallbackAddresses("anysearch.test", async () => { calls++; }, controller.signal),
    error => error.name === "AbortError",
  );
  assert.equal(calls, 0);
});

async function dnsFixture(t) {
  const udp = dgram.createSocket("udp4");
  await new Promise(resolve => udp.bind(0, "127.0.0.1", resolve));
  const original = Resolver.prototype.setServers;
  const resolvers = [];
  Resolver.prototype.setServers = function() {
    resolvers.push(this);
    return original.call(this, [`127.0.0.1:${udp.address().port}`]);
  };
  t.after(async () => {
    Resolver.prototype.setServers = original;
    for (const resolver of resolvers) resolver.cancel();
    await new Promise(resolve => udp.close(resolve));
  });
  return udp;
}

test("DNS fallback cancels UDP lookup when the caller stops", async (t) => {
  const udp = await dnsFixture(t);
  const controller = new AbortController();
  const started = new Promise(resolve => udp.once("message", resolve));
  const pending = resolveFallbackAddresses("anysearch.test", async () => {
    throw new TypeError("fixture DoH unavailable");
  }, controller.signal);
  await bounded(started);
  controller.abort();
  await assert.rejects(() => bounded(pending), error => error.name === "AbortError");
});

test("DNS fallback bounds a nonresponding UDP resolver", async (t) => {
  await dnsFixture(t);
  const result = await bounded(resolveFallbackAddresses("anysearch.test", async () => {
    throw new TypeError("fixture DoH unavailable");
  }), 4000);
  assert.deepEqual(result, []);
});
