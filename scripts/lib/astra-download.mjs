import {
  fetchWithRetry,
  httpFetchWithRetry,
  RETRYABLE_STATUS,
} from "./transient-fetch.mjs";

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The body may already be locked or aborted; the retry still owns the
    // next attempt and must not be blocked by cleanup of the old response.
  }
}

/**
 * Run one complete ASTRA download attempt under a single timeout. The shared
 * HTTP helper deliberately stops its timer at the headers; this wrapper keeps
 * a caller-owned signal armed through the consumer's body read and retries the
 * whole GET when that read fails or stalls.
 */
export async function fetchAstraDownload(
  url,
  options = {},
  { timeout = 30_000, label = String(url), retries, retryBaseMs } = {},
  consume,
) {
  if (typeof consume !== "function") {
    throw new TypeError("fetchAstraDownload requires a response consumer");
  }
  const timeoutMs = Number(timeout);
  if (!(timeoutMs > 0)) {
    throw new RangeError("fetchAstraDownload timeout must be positive");
  }

  return fetchWithRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Disable the inner retry loop: this outer attempt owns both the
        // header phase and the response-body phase, so a body failure restarts
        // exactly one complete GET instead of multiplying retry budgets.
        const response = await httpFetchWithRetry(
          url,
          { ...options, signal: controller.signal },
          { retries: 0, timeout: 0, label },
        );
        if (!response.ok) {
          const error = new Error(`ASTRA GET ${response.status} for ${url}`);
          error.status = response.status;
          error.response = response;
          error.retryable = RETRYABLE_STATUS.has(response.status);
          await cancelResponseBody(response);
          throw error;
        }
        try {
          return await consume(response);
        } catch (error) {
          await cancelResponseBody(response);
          throw error;
        }
      } finally {
        clearTimeout(timer);
      }
    },
    {
      label,
      ...(Number.isFinite(retries) ? { retries } : {}),
      ...(Number.isFinite(retryBaseMs) ? { retryBaseMs } : {}),
    },
  );
}
