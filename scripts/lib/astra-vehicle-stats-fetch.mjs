const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export const ASTRA_FETCH_RETRY_ATTEMPTS = 3;
export const ASTRA_FETCH_RETRY_BASE_DELAY_MS = 2_000;

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function errorCode(error) {
  return error?.cause?.code || error?.code || "";
}

export function describeFetchError(error) {
  return [
    error?.name,
    error?.message,
    errorCode(error),
    error?.cause?.message,
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(": ");
}

export function isRetryableFetchError(error) {
  return (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    error instanceof TypeError ||
    RETRYABLE_NETWORK_CODES.has(errorCode(error))
  );
}

function isRetryableResponse(response) {
  return RETRYABLE_HTTP_STATUSES.has(response.status) || response.status >= 500;
}

/**
 * Retry only transport/transient upstream failures. The request factory is
 * evaluated for every attempt so timeout signals are never reused after an
 * aborted request.
 */
export async function fetchWithRetry(
  url,
  requestOptions,
  {
    attempts = ASTRA_FETCH_RETRY_ATTEMPTS,
    baseDelayMs = ASTRA_FETCH_RETRY_BASE_DELAY_MS,
    fetchImpl = fetch,
    sleepImpl = wait,
    onRetry = () => {},
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("fetchWithRetry attempts must be a positive integer");
  }

  let method = requestOptions?.method || "GET";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      const options =
        typeof requestOptions === "function" ? requestOptions() : requestOptions;
      method = options?.method || method;
      response = await fetchImpl(url, options);
    } catch (error) {
      if (!isRetryableFetchError(error) || attempt === attempts) {
        throw new Error(
          `ASTRA ${method} ${url} failed after ${attempt} attempt(s): ${describeFetchError(error)}`,
          { cause: error },
        );
      }

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await onRetry({
        attempt,
        attempts,
        delayMs,
        reason: describeFetchError(error),
      });
      await sleepImpl(delayMs);
      continue;
    }

    if (!isRetryableResponse(response) || attempt === attempts) return response;

    try {
      await response.body?.cancel();
    } catch {
      // The response is already being discarded; preserve the retry decision.
    }
    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    await onRetry({
      attempt,
      attempts,
      delayMs,
      reason: `HTTP ${response.status}`,
    });
    await sleepImpl(delayMs);
  }

  throw new Error(`ASTRA ${method} ${url} failed without a response`);
}
