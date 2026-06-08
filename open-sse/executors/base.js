import { HTTP_STATUS, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { addJitter, abortableSleep } from "../utils/retry.js";
import { dbg } from "../utils/debugLog.js";
import { decompressResponse } from "../utils/decompress.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    // Default Accept-Encoding to prevent zstd (undici doesn't decompress it)
    if (!headers["Accept-Encoding"] && !headers["accept-encoding"]) {
      headers["Accept-Encoding"] = "gzip, deflate, br";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  // Override in subclass for async credential preparation before execute
  async preExecute(credentials) {
    return credentials;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    if (!credentials.expiresAt) return false;
    const expiresAtMs = new Date(credentials.expiresAt).getTime();
    return expiresAtMs - Date.now() < 5 * 60 * 1000;
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, clientHeaders = {} }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Allow subclass to fetch/refresh credentials asynchronously before sending
    credentials = await this.preExecute(credentials);

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    const tryRetry = async (urlIndex, statusKey, reason) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      retryAttemptsByUrl[urlIndex]++;
      // Equal jitter: random between delayMs/2 and delayMs to prevent thundering herd
      const jitteredDelay = addJitter(delayMs, { mode: 'equal' });
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${(jitteredDelay / 1000).toFixed(1)}s`);
      const { aborted } = await abortableSleep(jitteredDelay, signal);
      if (aborted) {
        const err = new Error("Aborted during retry");
        err.name = "AbortError";
        throw err;
      }
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      // Ensure stream parameter is set in the body for providers that require it
      if (stream !== undefined && transformedBody.stream === undefined) {
        transformedBody.stream = stream;
      }
      const headers = this.buildHeaders(credentials, stream);
      // Merge forwardable client headers under provider headers:
      // clientHeaders go in first, then provider-specific headers override on conflict,
      // ensuring 9router's auth, Content-Type, and Accept always win.
      const mergedHeaders = Object.keys(clientHeaders).length > 0
        ? { ...clientHeaders, ...headers }
        : headers;

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within FETCH_CONNECT_TIMEOUT_MS
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), FETCH_CONNECT_TIMEOUT_MS);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${FETCH_CONNECT_TIMEOUT_MS}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers: mergedHeaders,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        // Decompress response if undici left it compressed (zstd/br/gzip/deflate)
        const decompressed = await decompressResponse(response);

        return { response: decompressed, url, headers: mergedHeaders, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
