/**
 * Shared retry utilities for 9router
 *
 * Provides jitter, abort-aware sleep, and retry wrappers to prevent
 * thundering herd and improve resilience across all request paths.
 */

/**
 * Add jitter to a delay to prevent thundering herd.
 *
 * @param {number} delayMs - Base delay in milliseconds
 * @param {object} [opts] - Options
 * @param {number} [opts.cap] - Maximum delay in ms (default: delayMs)
 * @param {'full'|'equal'} [opts.mode='full'] - Jitter mode:
 *   - 'full': random between 0 and delayMs (max spread)
 *   - 'equal': random between delayMs/2 and delayMs (guarantees minimum wait)
 * @returns {number} Jittered delay in milliseconds
 */
export function addJitter(delayMs, opts = {}) {
  const { cap = delayMs, mode = 'full' } = opts;
  const capped = Math.min(delayMs, cap);

  if (mode === 'equal') {
    // Guarantee at least 50% of the delay
    return (capped / 2) + (Math.random() * capped / 2);
  }

  // Full jitter: random between 0 and capped
  return Math.random() * capped;
}

/**
 * Sleep that respects abort signals.
 * Resolves immediately with { aborted: true } if signal fires during wait.
 *
 * @param {number} ms - Duration in milliseconds
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<{ aborted: boolean }>}
 */
export function abortableSleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve({ aborted: true });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve({ aborted: false });
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve({ aborted: true });
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Execute an async function with retry logic.
 *
 * @param {Function} fn - Async function to execute. Receives { attempt, signal }.
 * @param {object} opts - Retry options
 * @param {number} [opts.maxRetries=2] - Max retry attempts (0 = no retry)
 * @param {Function} [opts.shouldRetry] - (error, attempt) => boolean
 * @param {Function} [opts.getDelay] - (attempt, error) => ms before jitter
 * @param {number} [opts.baseDelay=1000] - Base delay in ms (used if getDelay not provided)
 * @param {number} [opts.maxDelay=30000] - Cap on delay in ms
 * @param {number} [opts.backoffFactor=2] - Exponential multiplier
 * @param {'full'|'equal'} [opts.jitter='full'] - Jitter mode
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @param {string} [opts.name='retry'] - Name for error messages
 * @param {Function} [opts.onRetry] - (attempt, delay, error) => void callback
 * @returns {Promise<{ result: any, attempts: number, totalRetryMs: number }>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 2,
    shouldRetry = () => true,
    getDelay,
    baseDelay = 1000,
    maxDelay = 30_000,
    backoffFactor = 2,
    jitter = 'full',
    signal,
    name = 'retry',
    onRetry,
  } = opts;

  let lastError;
  let totalRetryMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort before each attempt
    if (signal?.aborted) {
      const err = new Error(`${name}: aborted before attempt ${attempt}`);
      err.code = 'ABORT_ERR';
      err.name = 'AbortError';
      err.attempts = attempt;
      err.totalRetryMs = totalRetryMs;
      throw err;
    }

    try {
      const result = await fn({ attempt, signal });
      return { result, attempts: attempt + 1, totalRetryMs };
    } catch (error) {
      lastError = error;

      // Don't retry abort errors
      if (error.name === 'AbortError' || signal?.aborted) {
        error.attempts = attempt + 1;
        error.totalRetryMs = totalRetryMs;
        throw error;
      }

      // Check if we should retry
      if (attempt >= maxRetries || !shouldRetry(error, attempt)) {
        error.attempts = attempt + 1;
        error.totalRetryMs = totalRetryMs;
        throw error;
      }

      // Calculate delay
      const rawDelay = getDelay
        ? getDelay(attempt, error)
        : baseDelay * Math.pow(backoffFactor, attempt);

      const jitteredDelay = addJitter(rawDelay, { cap: maxDelay, mode: jitter });

      onRetry?.(attempt + 1, jitteredDelay, error);

      const { aborted } = await abortableSleep(jitteredDelay, signal);
      if (aborted) {
        const err = new Error(`${name}: aborted during retry delay`);
        err.code = 'ABORT_ERR';
        err.name = 'AbortError';
        err.attempts = attempt + 1;
        err.totalRetryMs = totalRetryMs;
        throw err;
      }

      totalRetryMs += jitteredDelay;
    }
  }

  // Should never reach here, but TypeScript/linters need it
  lastError.attempts = maxRetries + 1;
  lastError.totalRetryMs = totalRetryMs;
  throw lastError;
}

/**
 * Convenience: wrap a fetch call with retry.
 * Retries on network errors and configurable status codes.
 *
 * @param {string|URL} url - URL to fetch
 * @param {RequestInit} fetchOpts - Fetch options
 * @param {object} retryOpts - Retry options (extends withRetry opts)
 * @param {number[]} [retryOpts.retryOnStatus=[502,503,504]] - Status codes to retry
 * @param {Function} [retryOpts.fetch=globalThis.fetch] - Fetch implementation
 * @param {object} [retryOpts.log] - Logger with debug/warn methods
 * @returns {Promise<{ result: Response, attempts: number, totalRetryMs: number }>}
 */
export async function fetchWithRetry(url, fetchOpts = {}, retryOpts = {}) {
  const {
    retryOnStatus = [502, 503, 504],
    fetch: fetchFn = globalThis.fetch,
    log,
    ...rest
  } = retryOpts;

  const urlStr = typeof url === 'string' ? url : url.toString();
  const hostname = new URL(urlStr).hostname;

  return withRetry(
    async ({ signal }) => {
      const resp = await fetchFn(url, { ...fetchOpts, signal: fetchOpts.signal || signal });

      if (retryOnStatus.includes(resp.status)) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        err.response = resp;
        throw err;
      }

      return resp;
    },
    {
      shouldRetry: (err) => {
        // Retry on specified status codes
        if (err.status && retryOnStatus.includes(err.status)) return true;

        // Retry on network errors
        if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' ||
            err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_SOCKET' ||
            err.code === 'ECONNREFUSED' || err.type === 'system') {
          return true;
        }

        return false;
      },
      name: `fetch:${hostname}`,
      onRetry: (attempt, delay, err) => {
        const delayS = (delay / 1000).toFixed(1);
        const msg = err.status ? `${err.status}` : err.code || err.message;
        log?.debug?.('RETRY', `${hostname} ${msg} - retry ${attempt} after ${delayS}s`);
      },
      ...rest,
    }
  );
}
