/** Transport retries and public-DNS fallback for AnySearch HTTP calls. */
import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
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
  if (code === "UND_ERR_RESPONSE_REDIRECTED") return false;
  if (code !== undefined && RETRYABLE_CODES.has(code)) return true;
  return error instanceof TypeError;
}

/** fetch() with one extra system-DNS retry, then DoH/public DNS IP pinning. */
export async function fetchWithFailover(url, init, hooks = {}) {
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

  for (let attempt = 0; attempt < systemAttempts; attempt += 1) {
    if (signal?.aborted === true) throw abortedError(signal);
    if (attempt > 0) await delay(retryDelayMs, signal);
    try {
      const response = await fetchImpl(url, init);
      if (!RETRYABLE_STATUS.has(response.status)) return response;
      lastRetryableResponse = response;
    } catch (error) {
      if (!isRetryableFetchFailure(error, signal)) throw error;
      lastError = error;
    }
  }

  const hostname = new URL(url).hostname;
  if (net.isIP(hostname) === 0) {
    const addresses = await resolveAddresses(hostname, dohFetch, signal);
    for (const address of addresses) {
      if (signal?.aborted === true) throw abortedError(signal);
      try {
        const response = await pinnedFetch(url, init, address);
        if (!RETRYABLE_STATUS.has(response.status)) return response;
        lastRetryableResponse = response;
      } catch (error) {
        if (!isRetryableFetchFailure(error, signal)) throw error;
        lastError = error;
      }
    }
  }

  if (lastRetryableResponse !== undefined) return lastRetryableResponse;
  throw lastError ?? new TypeError("fetch failed");
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
  try {
    const resolver = new Resolver();
    resolver.setServers(PUBLIC_DNS_SERVERS);
    for (const ip of await resolver.resolve4(hostname)) unique.add(ip);
  } catch {
    // Public UDP DNS is a last resort; empty means the caller rethrows the fetch error.
  }
  return [...unique];
}

/** HTTPS/HTTP request pinned to one resolved address, SNI still the original hostname. */
export function pinnedHttpsFetch(url, init, address) {
  const u = new URL(url);
  const lib = u.protocol === "http:" ? http : https;
  const headers = { ...init.headers, "accept-encoding": "identity" };
  if (headers.host === undefined && headers.Host === undefined) headers.host = u.host;
  const family = net.isIP(address) === 6 ? 6 : 4;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      servername: u.hostname,
      port: u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port),
      path: `${u.pathname}${u.search}`,
      method: init.method ?? "GET",
      headers,
      signal: init.signal,
      lookup(_hostname, options, callback) {
        if (options && options.all === true) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const headerList = [];
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) headerList.push([key, item]);
          } else {
            headerList.push([key, value]);
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 0,
          headers: headerList,
        }));
      });
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
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
  if (!response.ok) throw new TypeError(`DoH HTTP ${response.status}`);
  const payload = await response.json();
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
