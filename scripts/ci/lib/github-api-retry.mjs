/**
 * Bounded retry for idempotent GitHub API reads.
 *
 * GitHub Actions occasionally returns a gateway/server response for a valid
 * read. Retry only the explicit transient HTTP classes; authentication,
 * permission, malformed-request, command-timeout and malformed-payload errors
 * remain terminal so callers keep their fail-closed behaviour.
 */
export const GITHUB_API_TRANSIENT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export const GITHUB_API_TRANSIENT_RETRIES = 2;
export const GITHUB_API_TRANSIENT_RETRY_BASE_MS = 1000;

function sleepSync(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorChainText(error) {
  const texts = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    texts.push(String(current?.message ?? ''));
    texts.push(String(current?.stderr ?? ''));
  }
  return texts.join('\n');
}

/**
 * Classify only idempotent GitHub API transport/server failures as retryable.
 * Auth, permission, not-found and malformed-request failures stay terminal.
 */
export function isTransientGithubApiError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (GITHUB_API_TRANSIENT_RETRY_STATUSES.has(status)) return true;
  const text = errorChainText(error);
  return /\bHTTP\s+(?:408|425|429|500|502|503|504)\b/i.test(text)
    || /\b(?:Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(text);
}

/**
 * Synchronous bounded retry for read-only GitHub API calls.
 *
 * `sleep` is injectable so callers can test the retry contract without
 * waiting; production uses a linear 1s/2s backoff and rethrows the final
 * failure.
 */
export function withTransientGithubApiRetry(operation, {
  retries = GITHUB_API_TRANSIENT_RETRIES,
  baseDelayMs = GITHUB_API_TRANSIENT_RETRY_BASE_MS,
  sleep = sleepSync,
  onRetry,
} = {}) {
  const maxRetries = Number.isInteger(retries) ? Math.max(0, retries) : GITHUB_API_TRANSIENT_RETRIES;
  const retryBaseMs = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : GITHUB_API_TRANSIENT_RETRY_BASE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isTransientGithubApiError(error) || attempt >= maxRetries) throw error;
      const retryNumber = attempt + 1;
      const delayMs = retryBaseMs * retryNumber;
      onRetry?.({ attempt: retryNumber, maxRetries, delayMs, error });
      sleep(delayMs);
    }
  }
}
