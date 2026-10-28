const DEFAULT_TIMEOUT_MS = (() => {
  const value = Number(process.env.GSC_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return 30_000;
  return Math.min(Math.floor(value), 120_000);
})();

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error instanceof TypeError;
}

/**
 * GSC can abort a Search Analytics request at the transport boundary. Retry
 * transient failures, but keep the timeout and attempt count bounded so a
 * partial snapshot is never mistaken for a complete one.
 *
 * The optional third argument is injectable for unit tests; production callers
 * use the defaults and still receive a real timeout.
 */
export async function fetchGsc(
  url,
  init = {},
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleepImpl = sleep,
  } = {},
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!isRetryableStatus(response.status)) {
        return response;
      }

      if (attempt === attempts) {
        if (response.body?.cancel) await response.body.cancel();
        throw new Error(`GSC request failed after ${attempts} attempts: HTTP ${response.status}`);
      }

      // Release a retryable response body before opening the next request.
      if (response.body?.cancel) await response.body.cancel();
      lastError = new Error(`GSC request returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === attempts) {
        if (error?.name === 'TimeoutError') {
          throw new Error(`GSC request timed out after ${timeoutMs} ms`, { cause: error });
        }
        throw error;
      }
    }

    await sleepImpl(retryDelayMs * 2 ** (attempt - 1));
  }

  throw lastError || new Error('GSC request failed without a response');
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_ATTEMPTS, DEFAULT_RETRY_DELAY_MS };
