import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync, brotliCompressSync } from "node:zlib";
import {
  fetchWithFailover, isRetryableFetchFailure, pinnedHttpsFetch,
  readResponseJSON, usesEnvironmentProxy,
} from "../lib/transport.js";

const run = promisify(execFile);
const moduleURL = new URL("../lib/transport.js", import.meta.url).href;
const direct = { proxyPolicy: "direct" };

async function fixture(t, handler) {
  const server = http.createServer((request, response) => { request.resume(); handler(request, response); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, port: server.address().port, url: `http://fixture.invalid:${server.address().port}/v1/search` };
}

function tooLarge(error) { return error.code === "ANYSEARCH_RESPONSE_TOO_LARGE"; }

// Tests explicitly declare direct policy; parent DSH proxy variables cannot alter mocks.
test("bounded JSON handles split UTF-8 at exactly the byte limit", async () => {
  const bytes = new TextEncoder().encode('{"text":"中文"}');
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 10)); c.enqueue(bytes.slice(10)); c.close(); } });
  assert.deepEqual(await readResponseJSON(new Response(stream), { maxBytes: bytes.length }), { text: "中文" });
});

test("bounded JSON handles many tiny chunks without retaining per-chunk buffers", async () => {
  const data = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(10000) }));
  let offset = 0;
  const response = new Response(new ReadableStream({
    pull(c) {
      if (offset === data.length) c.close();
      else c.enqueue(data.subarray(offset, ++offset));
    },
  }));
  assert.deepEqual(await readResponseJSON(response, { maxBytes: data.length }), { text: "x".repeat(10000) });
});

test("bounded JSON rejects advertised oversized bodies and cancels without reading", async () => {
  let cancelled = 0;
  const stream = new ReadableStream({ cancel() { cancelled++; } });
  await assert.rejects(() => readResponseJSON(new Response(stream, { headers: { "content-length": "100" } }), { maxBytes: 10 }), tooLarge);
  assert.equal(cancelled, 1);
});

test("bounded JSON limits chunked bytes rather than characters and releases its reader", async () => {
  let cancelled = 0;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('"中文中文"')); }, cancel() { cancelled++; } });
  const response = new Response(stream);
  await assert.rejects(() => readResponseJSON(response, { maxBytes: 8 }), tooLarge);
  assert.equal(cancelled, 1);
  assert.equal(response.body.locked, false);
  assert.equal(isRetryableFetchFailure(Object.assign(new TypeError("large"), { code: "ANYSEARCH_RESPONSE_TOO_LARGE" })), false);
});

test("bounded JSON cancellation settles even a body that does not observe the signal", async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123])); }, cancel() { cancelled++; } }));
  const pending = readResponseJSON(response, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, error => error.name === "AbortError");
  assert.equal(cancelled, 1);
  assert.equal(response.body.locked, false);
});

test("a stalled stream cancellation cannot suppress the caller abort or size failure", async () => {
  const make = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(100)); },
    cancel() { return new Promise(() => undefined); },
  }));
  const controller = new AbortController();
  const pending = readResponseJSON(make(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, error => error.name === "AbortError");
  await assert.rejects(() => readResponseJSON(make(), { maxBytes: 64 }), tooLarge);
});

test("bounded JSON preserves complete malformed JSON as a non-retryable parse failure", async () => {
  await assert.rejects(() => readResponseJSON(new Response("{")), SyntaxError);
  assert.equal(isRetryableFetchFailure(new SyntaxError("invalid JSON")), false);
});

for (const status of [401, 402, 429]) {
  test(`pinned interrupted ${status} retains headers and causes no transport retry`, async t => {
    let calls = 0;
    const { url } = await fixture(t, (_req, res) => {
      calls++;
      res.writeHead(status, { "content-length": "1000", "retry-after": "600" });
      res.write("{");
      setTimeout(() => res.destroy(), 20);
    });
    const result = await fetchWithFailover(url, {}, {
      ...direct, extraAttempts: 0,
      fetch: async () => { throw new TypeError("fixture system DNS failure"); },
      resolveFallbackAddresses: async () => ["127.0.0.1", "127.0.0.1"],
    }, async response => {
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "600");
      await assert.rejects(() => readResponseJSON(response), error => error.code === "ECONNRESET");
      // Like the client's error-status-first callback, failed error detail cannot
      // override status. The actual client/rotation integration has separate tests.
      return response.status;
    });
    assert.equal(result, status);
    assert.equal(calls, 1);
  });
}

test("an error-status body callback failure cannot trigger another pinned request", async t => {
  let calls = 0;
  const { url } = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(401, { "content-length": "1000" });
    res.write("{");
    setTimeout(() => res.destroy(), 20);
  });
  await assert.rejects(() => fetchWithFailover(url, {}, {
    ...direct, extraAttempts: 0,
    fetch: async () => { throw new TypeError("fixture system failure"); },
    resolveFallbackAddresses: async () => ["127.0.0.1", "127.0.0.1"],
  }, readResponseJSON), error => error.code === "ECONNRESET");
  assert.equal(calls, 1);
});

test("pinned headers are available before a stalled body, and cancellation closes the socket", async t => {
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  const { url } = await fixture(t, (_req, res) => {
    res.on("close", closed);
    res.writeHead(429, { "retry-after": "600" });
    res.flushHeaders();
  });
  const response = await pinnedHttpsFetch(url, {}, "127.0.0.1", direct);
  assert.equal(response.status, 429);
  await response.body.cancel();
  await connectionClosed;
});

for (const advertised of [true, false]) {
  test(`pinned ${advertised ? "declared" : "chunked"} oversized body errors without losing status`, async t => {
    const { url } = await fixture(t, (_req, res) => {
      res.writeHead(200, advertised ? { "content-length": "100" } : {});
      res.end("x".repeat(100));
    });
    const response = await pinnedHttpsFetch(url, {}, "127.0.0.1", { ...direct, maxBytes: 64 });
    assert.equal(response.status, 200);
    await assert.rejects(() => response.text(), tooLarge);
  });
}

for (const [encoding, compress] of [["gzip", gzipSync], ["br", brotliCompressSync]]) {
  test(`pinned rejects noncompliant ${encoding} without decoding, retrying or losing error status`, async t => {
    const expanded = Buffer.from(JSON.stringify({ text: "x".repeat(20000) }));
    const compressed = compress(expanded);
    assert.ok(compressed.byteLength < 256 && expanded.byteLength > 256);
    let status = 200;
    let requests = 0;
    const accepted = [];
    const { url } = await fixture(t, (req, res) => {
      requests++;
      accepted.push(req.headers["accept-encoding"]);
      res.writeHead(status, { "content-encoding": encoding, "retry-after": "600", "content-length": compressed.byteLength });
      res.end(compressed);
    });
    const pinned = (input, init, address, options) => pinnedHttpsFetch(input, init, address, { ...options, maxBytes: 256 });
    for (status of [200, 401, 402, 429]) {
      const response = await pinned(url, {}, "127.0.0.1", direct);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "600");
      await assert.rejects(() => readResponseJSON(response, { maxBytes: 256 }), error => error.code === "ANYSEARCH_UNSUPPORTED_ENCODING");
    }
    assert.deepEqual(accepted, ["identity", "identity", "identity", "identity"]);
    const before = requests;
    status = 200;
    await assert.rejects(() => fetchWithFailover(url, {}, {
      ...direct, extraAttempts: 0,
      fetch: async () => { throw new TypeError("fixture system failure"); },
      resolveFallbackAddresses: async () => ["127.0.0.1", "127.0.0.1"],
      pinnedFetch: pinned,
    }, response => readResponseJSON(response, { maxBytes: 256 })), error => error.code === "ANYSEARCH_UNSUPPORTED_ENCODING");
    assert.equal(requests, before + 1);
    assert.equal(isRetryableFetchFailure(Object.assign(new TypeError("encoding"), { code: "ANYSEARCH_UNSUPPORTED_ENCODING" })), false);
  });
}

test("a discarded streaming error socket closes before waiting for fallback DNS", { timeout: 2000 }, async t => {
  let requests = 0;
  let notifyClosed;
  const socketClosed = new Promise(resolve => { notifyClosed = resolve; });
  const { url } = await fixture(t, (req, res) => {
    requests++;
    if (requests === 1) {
      req.socket.once("close", notifyClosed);
      res.writeHead(503, { "retry-after": "600" });
      res.write("{");
    } else res.end('{"ok":true}');
  });
  let dnsWaits = 0;
  const result = await fetchWithFailover(url, {}, {
    ...direct, extraAttempts: 0,
    fetch: (input, init) => pinnedHttpsFetch(input, init, "127.0.0.1", direct),
    resolveFallbackAddresses: async () => {
      dnsWaits++;
      let timer;
      try {
        await Promise.race([socketClosed, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("retained response socket stayed open during DNS")), 500);
        })]);
      } finally { clearTimeout(timer); }
      return ["127.0.0.1"];
    },
  }, readResponseJSON);
  assert.deepEqual(result, { ok: true });
  assert.equal(dnsWaits, 1);
  assert.equal(requests, 2);
});

test("shared default 5,000,000-byte ceiling applies to both JSON and native pinned bodies", async t => {
  const body = "x".repeat(5_000_001);
  await assert.rejects(() => readResponseJSON(new Response(body)), error => tooLarge(error) && error.maxBytes === 5_000_000);
  const { url } = await fixture(t, (_req, res) => { res.writeHead(200); res.end(body); });
  const response = await pinnedHttpsFetch(url, {}, "127.0.0.1", direct);
  await assert.rejects(() => response.text(), error => tooLarge(error) && error.maxBytes === 5_000_000);
});

test("oversized JSON does not retry system fetch or public DNS", async () => {
  let calls = 0;
  let lookups = 0;
  await assert.rejects(() => fetchWithFailover("https://fixture.invalid", {}, {
    ...direct, extraAttempts: 3,
    fetch: async () => { calls++; return new Response("x".repeat(100)); },
    resolveFallbackAddresses: async () => { lookups++; return []; },
  }, response => readResponseJSON(response, { maxBytes: 64 })), tooLarge);
  assert.equal(calls, 1);
  assert.equal(lookups, 0);
});

test("conservative proxy policy understands common bypass rules but not IP ranges/apex dot rules", () => {
  const proxy = { HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" };
  assert.equal(usesEnvironmentProxy("http://host.invalid", proxy), true);
  assert.equal(usesEnvironmentProxy("https://host.invalid", {}), false);
  for (const NO_PROXY of ["*", "host.invalid", "host.invalid:80", ".invalid", "*.invalid"]) {
    assert.equal(usesEnvironmentProxy("http://host.invalid", { ...proxy, NO_PROXY }), false, NO_PROXY);
  }
  assert.equal(usesEnvironmentProxy("http://host.invalid", { ...proxy, NO_PROXY: ".host.invalid" }), true);
  assert.equal(usesEnvironmentProxy("http://host.invalid", { ...proxy, NO_PROXY: "host.invalid:81" }), true);
  assert.equal(usesEnvironmentProxy("http://127.0.0.1", { ...proxy, NO_PROXY: "127.0.0.0-127.0.0.255" }), true);
});

async function child(source, proxyPort, NO_PROXY = "") {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `import {fetchWithFailover,pinnedHttpsFetch,readResponseJSON,usesEnvironmentProxy} from ${JSON.stringify(moduleURL)};${source}`], {
    env: {
      // execPath is Electron in the desktop matrix; retain its Node-only mode
      // without inheriting production proxy values or any unrelated secrets.
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY,
    },
    timeout: 5000,
  });
  return JSON.parse(stdout);
}

test("proxy subprocess retains the parent runtime including Electron Node mode", async () => {
  const runtime = await child(`console.log(JSON.stringify({execPath:process.execPath,node:process.versions.node,electron:process.versions.electron,runAsNode:process.env.ELECTRON_RUN_AS_NODE}));`, 1);
  assert.equal(runtime.execPath, process.execPath);
  assert.equal(runtime.node, process.versions.node);
  assert.equal(runtime.electron, process.versions.electron);
  assert.equal(runtime.runAsNode, process.env.ELECTRON_RUN_AS_NODE);
});

for (const protocol of ["http:", "https:"]) {
  test(`Node24 ${protocol} configured proxy is retained and public DNS never runs`, async t => {
    let proxyCalls = 0;
    const { server, port } = await fixture(t, (_req, res) => {
      proxyCalls++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"fixture":"proxy"}');
    });
    server.on("connect", (_req, socket) => {
      proxyCalls++;
      // Node24 fetch/undici tunnels HTTP too; its native http agent instead
      // sends an absolute-form HTTP request. Support both local fixture routes.
      if (protocol === "http:") {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.once("data", () => socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 19\r\nConnection: close\r\n\r\n{\"fixture\":\"proxy\"}"));
      } else socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    const result = await child(`
      let lookups=0;
      const url=${JSON.stringify(`${protocol}//fixture.invalid:12345/v1/search`)};
      let status;
      try { const response=await fetchWithFailover(url,{signal:AbortSignal.timeout(2000)},{extraAttempts:0,resolveFallbackAddresses:async()=>{lookups++;throw new Error('unexpected DNS');}}); status=response.status;await response.body?.cancel(); }
      catch { status='proxy-error'; }
      console.log(JSON.stringify({lookups,status,proxied:usesEnvironmentProxy(url)}));
    `, port);
    assert.equal(result.lookups, 0);
    assert.equal(result.proxied, true);
    assert.equal(proxyCalls, 1);
    assert.equal(result.status, protocol === "http:" ? 503 : "proxy-error");
  });
}

test("Node24 NO_PROXY exact host bypasses native/fetch proxy; pinned direct agent honors its IP", async t => {
  let proxyCalls = 0;
  let targetCalls = 0;
  const proxy = await fixture(t, (_req, res) => { proxyCalls++; res.writeHead(502); res.end(); });
  const target = await fixture(t, (_req, res) => { targetCalls++; res.end('{"fixture":"target"}'); });
  const result = await child(`
    import http from 'node:http';
    const url=${JSON.stringify(`http://localhost:${target.port}/v1/search`)};
    const native=await new Promise((resolve,reject)=>{http.get(url,res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});
    const fetched=await fetch(url);await fetched.body.cancel();
    const pinned=await pinnedHttpsFetch(url,{},'127.0.0.1');
    const body=await readResponseJSON(pinned);
    console.log(JSON.stringify({native,fetchStatus:fetched.status,pinnedStatus:pinned.status,body,proxied:usesEnvironmentProxy(url)}));
  `, proxy.port, "localhost");
  assert.equal(result.proxied, false);
  assert.equal(result.native, 200);
  assert.equal(result.fetchStatus, 200);
  assert.equal(result.pinnedStatus, 200);
  assert.deepEqual(result.body, { fixture: "target" });
  assert.equal(proxyCalls, 0);
  assert.equal(targetCalls, 3);
});

test("Node24 pinned HTTPS NO_PROXY connects directly with hostname/SNI retained", async t => {
  let hello;
  const started = new Promise(resolve => { hello = resolve; });
  const sockets = new Set();
  const target = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", data => { hello(data); socket.destroy(); });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => target.close(resolve)); });
  let proxyCalls = 0;
  const proxy = await fixture(t, (_req, res) => { proxyCalls++; res.writeHead(502); res.end(); });
  const result = await child(`
    const url=${JSON.stringify(`https://fixture.invalid:${target.address().port}/`)};
    let code;try{await pinnedHttpsFetch(url,{signal:AbortSignal.timeout(2000)},'127.0.0.1');}catch(e){code=e.code;}
    console.log(JSON.stringify({code,proxied:usesEnvironmentProxy(url)}));
  `, proxy.port, "fixture.invalid");
  const bytes = await started;
  assert.ok(bytes.includes(Buffer.from("fixture.invalid")), "TLS ClientHello retains original SNI");
  assert.equal(result.proxied, false);
  assert.equal(result.code, "ECONNRESET");
  assert.equal(proxyCalls, 0);
});
