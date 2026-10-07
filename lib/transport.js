/** Transport retries and public-DNS fallback for AnySearch HTTP calls. */
import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  MAX_RESPONSE_BYTES,
  NETWORK_DOH_TIMEOUT_MS,
  NETWORK_RETRY_DELAY_MS,
  NETWORK_RETRY_EXTRA_ATTEMPTS,
} from "./limits.js";

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const RETRYABLE_STATUS = new Set([502, 503, 504]);

const DOH_URLS = [
  (host) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
  (host) => `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
  (host) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=A`,
];

const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "223.5.5.5"];

/** Format a fetch/undici failure so the model-visible error includes the syscall code. */
export function describeNetworkError(error) {
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const bits = [];
  collectNetworkFacts(error, bits, new Set());
  return bits.length > 0 ? `${base} (${bits.join(" ")})` : base;
}

/** Whether a thrown transport error should be retried or failed over. */
export function isRetryableFetchFailure(error, signal) {
  if (signal?.aborted === true) return false;
  if (isAbortError(error)) return false;
  if (error instanceof DOMException && error.name === "TimeoutError") return false;
  const code = networkCode(error);
  if (["UND_ERR_RESPONSE_REDIRECTED", "ANYSEARCH_RESPONSE_TOO_LARGE", "ANYSEARCH_PROXY_REQUIRED", "ANYSEARCH_UNSUPPORTED_ENCODING"].includes(code)) return false;
  if (code !== undefined && RETRYABLE_CODES.has(code)) return true;
  return error instanceof TypeError;
}

/** Retry connection and optional response reading within the same DNS failover budget. */
export async function fetchWithFailover(url, init, hooks = {}, readResponse = response => response) {
  const fetchImpl = hooks.fetch ?? ((input, start) => globalThis.fetch(input, start));
  const extraAttempts = hooks.extraAttempts ?? NETWORK_RETRY_EXTRA_ATTEMPTS;
  const retryDelayMs = hooks.retryDelayMs ?? NETWORK_RETRY_DELAY_MS;
  const resolveAddresses = hooks.resolveFallbackAddresses ?? resolveFallbackAddresses;
  const pinnedFetch = hooks.pinnedFetch ?? pinnedHttpsFetch;
  const dohFetch = hooks.dohFetch ?? ((input, start) => globalThis.fetch(input, start));
  const signal = init.signal;
  const systemAttempts = 1 + extraAttempts;

  let lastError;
  let lastRetryableResponse;
  let returnedLastResponse = false;

  const discardPrevious = async () => {
    if (lastRetryableResponse === undefined) return;
    const previous = lastRetryableResponse;
    // Retain the last HTTP status if later attempts fail before returning headers.
    lastRetryableResponse = new Response(null, {
      status: previous.status, statusText: previous.statusText, headers: previous.headers,
    });
    await cancelResponse(previous);
  };

  try {
    for (let attempt = 0; attempt < systemAttempts; attempt += 1) {
      if (signal?.aborted === true) throw abortedError(signal);
      if (attempt > 0) await delay(retryDelayMs, signal);
      await discardPrevious();
      let response;
      try {
        response = await fetchImpl(url, init);
        if (!RETRYABLE_STATUS.has(response.status)) return await readResponse(response);
        lastRetryableResponse = response;
      } catch (error) {
        await cancelResponse(response);
        if (response !== undefined && !response.ok && !RETRYABLE_STATUS.has(response.status)) throw error;
        if (!isRetryableFetchFailure(error, signal)) throw error;
        lastError = error;
      }
    }

    const hostname = new URL(url).hostname;
    // Never bypass a configured proxy with public DNS or a direct pinned socket.
    // Tests with mocked transports must explicitly choose proxyPolicy: "direct".
    if (net.isIP(hostname) === 0 && (hooks.proxyPolicy === "direct" || !usesEnvironmentProxy(url))) {
      // DNS can stall until the deadline. Release a retained streaming error
      // body before waiting for it, while preserving the headers/status clone.
      await discardPrevious();
      const addresses = await resolveAddresses(hostname, dohFetch, signal);
      for (const address of addresses) {
        if (signal?.aborted === true) throw abortedError(signal);
        await discardPrevious();
        let response;
        try {
          response = await pinnedFetch(url, init, address, { proxyPolicy: hooks.proxyPolicy ?? "environment" });
          if (!RETRYABLE_STATUS.has(response.status)) return await readResponse(response);
          lastRetryableResponse = response;
        } catch (error) {
          await cancelResponse(response);
          if (response !== undefined && !response.ok && !RETRYABLE_STATUS.has(response.status)) throw error;
          if (!isRetryableFetchFailure(error, signal)) throw error;
          lastError = error;
        }
      }
    }

    if (lastRetryableResponse !== undefined) {
      const result = await readResponse(lastRetryableResponse);
      returnedLastResponse = true;
      return result;
    }
    throw lastError ?? new TypeError("fetch failed");
  } finally {
    if (!returnedLastResponse) await cancelResponse(lastRetryableResponse);
  }
}

async function cancelResponse(response) {
  try {
    // Cancellation starts synchronously; do not await an untrusted stream's
    // cancellation promise (which could defeat the request deadline).
    void response?.body?.cancel()?.catch(() => undefined);
  } catch {
    // A consumed or already errored body has no remaining reader to cancel here.
  }
}

/** A records from DoH, then Node recursive resolvers if DoH is blocked. */
export async function resolveFallbackAddresses(hostname, fetchImpl = globalThis.fetch, signal) {
  const unique = new Set();
  for (const makeUrl of DOH_URLS) {
    if (signal?.aborted === true) throw abortedError(signal);
    try {
      for (const ip of await resolveDoH(makeUrl(hostname), fetchImpl, signal)) unique.add(ip);
      if (unique.size > 0) return [...unique];
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error);
    }
  }
  const resolver = new Resolver({ timeout: NETWORK_DOH_TIMEOUT_MS, tries: 1 });
  const timeout = AbortSignal.timeout(NETWORK_DOH_TIMEOUT_MS);
  const lookupSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const cancel = () => resolver.cancel();
  try {
    if (signal?.aborted === true) throw abortedError(signal);
    lookupSignal.addEventListener("abort", cancel, { once: true });
    resolver.setServers(PUBLIC_DNS_SERVERS);
    for (const ip of await resolver.resolve4(hostname)) unique.add(ip);
  } catch (error) {
    if (signal?.aborted === true) throw abortedError(signal, error);
    // A failed/budget-exhausted last resort leaves the original fetch error visible.
  } finally {
    lookupSignal.removeEventListener("abort", cancel);
  }
  return [...unique];
}

/**
 * Conservative environment-proxy policy, independent of NODE_USE_ENV_PROXY.
 * A configured proxy forbids direct failover even if the current fetch ignores it.
 * Only the common Node/undici NO_PROXY subset permits direct fallback: *, exact
 * host[:port], and dot/wildcard subdomain suffixes (not their bare apex).
 * IP ranges/CIDR and ambiguous patterns intentionally keep the proxy policy.
 */
export function usesEnvironmentProxy(url, env = process.env) {
  const u = new URL(url);
  const proxy = u.protocol === "https:"
    ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY
    : env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;
  if (!proxy) return false;
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const bypass = env.no_proxy !== undefined ? env.no_proxy : env.NO_PROXY ?? "";
  for (const raw of bypass.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (entry === "*" || entry === host || entry === `${host}:${port}`) return false;
    if (entry.startsWith(".") && host.endsWith(entry)) return false;
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return false;
  }
  return true;
}

function responseTooLarge(maxBytes) {
  return Object.assign(new Error(`AnySearch response exceeds the ${maxBytes} byte limit`), {
    code: "ANYSEARCH_RESPONSE_TOO_LARGE", maxBytes,
  });
}

/** Bound decoded response bytes before UTF-8/JSON parsing; cancel on every failure. */
export async function readResponseJSON(response, { signal, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a nonnegative safe integer");
  if (signal?.aborted === true) {
    void cancelResponse(response);
    throw abortedError(signal);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void cancelResponse(response);
    throw responseTooLarge(maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return JSON.parse("");
  let aborted;
  const onAbort = () => {
    aborted = abortedError(signal);
    // Web-stream cancellation closes pending reads immediately, independently
    // of whether the source's cancel() promise eventually settles.
    void reader.cancel(aborted).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let total = 0;
  try {
    // A fixed buffer also bounds bookkeeping for millions of tiny chunks.
    // Retaining a chunks array or racing each read against one never-settled
    // abort promise would otherwise grow memory with the number of chunks.
    const bytes = new Uint8Array(maxBytes);
    if (signal?.aborted === true) onAbort();
    while (true) {
      const { done, value } = await reader.read();
      if (aborted) throw aborted;
      if (done) break;
      if (total + value.byteLength > maxBytes) throw responseTooLarge(maxBytes);
      bytes.set(value, total);
      total += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total)));
  } catch (error) {
    // Initiate cleanup, but an arbitrary stream's stalled cancel() must not
    // make the caller's cancellation/deadline or permanent size error hang.
    void reader.cancel(error).catch(() => undefined);
    throw aborted ?? error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Headers settle immediately; a bounded, backpressured body retains HTTP status on failure. */
export function pinnedHttpsFetch(url, init, address, { proxyPolicy = "environment", maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return Promise.reject(new RangeError("maxBytes must be a nonnegative safe integer"));
  if (init.signal?.aborted === true) return Promise.reject(abortedError(init.signal));
  if (proxyPolicy !== "direct" && usesEnvironmentProxy(url)) {
    return Promise.reject(Object.assign(new Error("AnySearch direct fallback is disabled for a proxied target"), { code: "ANYSEARCH_PROXY_REQUIRED" }));
  }
  const u = new URL(url);
  const lib = u.protocol === "http:" ? http : https;
  // Never use the NODE_USE_ENV_PROXY global agents: lookup must really pin the IP.
  const agent = new lib.Agent({ keepAlive: false, proxyEnv: {} });
  const headers = { ...init.headers, "accept-encoding": "identity" };
  if (headers.host === undefined && headers.Host === undefined) headers.host = u.host;
  const family = net.isIP(address) === 6 ? 6 : 4;
  return new Promise((resolve, reject) => {
    let finished = false;
    let delivered = false;
    let response;
    let controller;
    let req;
    const cleanup = () => {
      init.signal?.removeEventListener("abort", onAbort);
      agent.destroy();
    };
    const fail = error => {
      if (finished) return;
      finished = true;
      if (delivered) controller?.error(error);
      else reject(error);
      response?.destroy();
      req?.destroy();
      cleanup();
    };
    const onAbort = () => fail(abortedError(init.signal));
    try {
      req = lib.request({
        agent,
        hostname: u.hostname,
        servername: u.hostname,
        port: u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: init.method ?? "GET",
        headers,
        lookup(_hostname, options, callback) {
          if (options && options.all === true) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      }, res => {
        response = res;
        let bytes = 0;
        const nullBody = (init.method ?? "GET").toUpperCase() === "HEAD" || [204, 205, 304].includes(res.statusCode);
        const stream = nullBody ? null : new ReadableStream({
          start(value) { controller = value; },
          pull() { if (!finished) res.resume(); },
          cancel() {
            if (finished) return;
            finished = true;
            res.destroy();
            req.destroy();
            cleanup();
          },
        });
        res.on("data", chunk => {
          if (finished) return;
          bytes += chunk.byteLength;
          if (bytes > maxBytes) { fail(responseTooLarge(maxBytes)); return; }
          if (controller) {
            controller.enqueue(chunk);
            if (controller.desiredSize <= 0) res.pause();
          }
        });
        res.on("error", fail);
        res.on("aborted", () => fail(responseInterrupted()));
        res.on("close", () => { if (!res.complete) fail(responseInterrupted()); });
        res.on("end", () => {
          if (finished) return;
          finished = true;
          controller?.close();
          cleanup();
        });
        res.pause();
        try {
          const headerList = [];
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) headerList.push([key, item]);
          }
          const result = new Response(stream, { status: res.statusCode ?? 0, headers: headerList });
          delivered = true;
          resolve(result);
          const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
          if (!nullBody && encoding !== "" && encoding !== "identity") {
            // A server ignoring Accept-Encoding: identity must not feed
            // compressed bytes to JSON.parse or bypass the decoded-size cap.
            fail(Object.assign(new Error("AnySearch pinned response uses an unsupported content encoding"), {
              code: "ANYSEARCH_UNSUPPORTED_ENCODING",
            }));
          } else if (Number(res.headers["content-length"]) > maxBytes) fail(responseTooLarge(maxBytes));
          else if (nullBody) res.resume();
        } catch (error) { fail(error); }
      });
      req.on("error", fail);
      init.signal?.addEventListener("abort", onAbort, { once: true });
      if (init.signal?.aborted === true) { onAbort(); return; }
      if (init.body !== undefined) req.write(init.body);
      req.end();
    } catch (error) { fail(error); }
  });
}

function responseInterrupted() {
  return Object.assign(new Error("AnySearch response ended before the body was complete"), { code: "ECONNRESET" });
}

async function resolveDoH(url, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(NETWORK_DOH_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/dns-json" },
    signal: combined,
  });
  if (!response.ok) {
    await cancelResponse(response);
    throw new TypeError(`DoH HTTP ${response.status}`);
  }
  const payload = await readResponseJSON(response, { signal: combined });
  return ipv4FromDoH(payload);
}

function ipv4FromDoH(payload) {
  if (typeof payload !== "object" || payload === null || !Array.isArray(payload.Answer)) return [];
  const ips = [];
  for (const answer of payload.Answer) {
    if (answer && answer.type === 1 && typeof answer.data === "string" && net.isIP(answer.data) === 4) {
      ips.push(answer.data);
    }
  }
  return ips;
}

function networkCode(error) {
  if (error === null || typeof error !== "object") return undefined;
  if (typeof error.code === "string") return error.code;
  const cause = error.cause;
  if (cause !== null && typeof cause === "object") {
    if (typeof cause.code === "string") return cause.code;
    if (Array.isArray(cause.errors)) {
      for (const inner of cause.errors) {
        const code = networkCode(inner);
        if (code !== undefined) return code;
      }
    }
  }
  return undefined;
}

function collectNetworkFacts(error, bits, seen) {
  if (error === null || typeof error !== "object" || seen.has(error)) return;
  seen.add(error);
  for (const key of ["code", "syscall", "hostname", "address"]) {
    const value = error[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      if (!bits.includes(text)) bits.push(text);
    }
  }
  if ("cause" in error) collectNetworkFacts(error.cause, bits, seen);
}

function delay(ms, signal) {
  if (ms <= 0) {
    if (signal?.aborted === true) return Promise.reject(abortedError(signal));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortedError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortedError(signal, fallback) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (isAbortError(fallback)) return fallback;
  return new DOMException("Aborted", "AbortError");
}
