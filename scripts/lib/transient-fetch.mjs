/**
 * transient-fetch.mjs — Shared transient-failure classification + retry/backoff
 * for every dedicated job crawler / ATS client.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The recurring single-run "Crawler Failure" issues (#1304/#1306/#1307/#1309…)
 * were almost all TRANSIENT network blips — `fetch failed` / `ECONNRESET` /
 * `ETIMEDOUT` / `page.goto Timeout` / HTTP 429/5xx — that succeed on the very
 * next scheduled run. Each ATS client re-implemented (or omitted) its own
 * transient detection, so a blip in any un-hardened path crashed the crawler
 * (exit 1) and opened a priority:high issue on a SINGLE failed run.
 *
 * This module is the ONE place that decides "is this error worth retrying?"
 * and wraps an attempt in bounded exponential backoff + jitter. It is
 * dependency-free (Node stdlib only) so leaf clients can import it without
 * pulling the whole crawler-template / assemble-jobs-dataset graph.
 *
 * `crawler-template.mjs` re-exports these so its `fetchJson`/`fetchHtml`
 * behaviour is unchanged; the ATS clients (successfactors/jobup/…) import the
 * same primitives directly.
 */

/**
 * HTTP status codes worth retrying: rate-limiting (429), request timeout (408),
 * too-early (425) and the standard 5xx transient server/gateway failures.
 * Persistent client errors (400/401/403/404/410…) are NOT here — they must
 * fail fast (a 403 is anti-bot, a 404 means the source moved).
 */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a thrown fetch error is a transient network/timeout failure that is
 * worth retrying (DNS hiccup, connection reset, socket hang up, abort/timeout,
 * Playwright navigation timeout). Persistent failures (bad URL, 4xx) are not
 * transient and must fail fast.
 *
 * Recognised transient signals:
 *   - `err.retryable === true`            (caller-tagged, e.g. RETRYABLE_STATUS)
 *   - AbortError                          (our own timeout fired)
 *   - cause/code ∈ ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, EPIPE,
 *     ENETUNREACH, ENOTFOUND, UND_ERR_* (undici internal transient)
 *   - TypeError "fetch failed" / "network" / "socket hang up" (Node wraps
 *     network failures in a generic TypeError)
 *   - Playwright "page.goto: Timeout NNNms exceeded" / "Navigation timeout"
 *     (#1308 Kantonsspital Obwalden)
 */
export function isTransientFetchError(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.name === 'AbortError') return true; // request timed out
  // Caller may tag a status directly (HTTP path) instead of throwing a typed err.
  if (Number.isFinite(err.status) && RETRYABLE_STATUS.has(err.status)) return true;
  const code = err.cause?.code || err.code || '';
  if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|ENOTFOUND|UND_ERR_)/i.test(code)) {
    return true;
  }
  const msg = String(err.message || '');
  // Node's fetch wraps network failures in a generic TypeError "fetch failed".
  if (err.name === 'TypeError' && /fetch failed|network|socket hang up/i.test(msg)) {
    return true;
  }
  // Generic message-level transient signals (Playwright navigation timeout,
  // wrapped client errors like SuccessFactorsApiError "network error: fetch
  // failed" that lose the original TypeError name when re-thrown).
  if (/fetch failed|socket hang up|network error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    return true;
  }
  if (/page\.goto|navigation timeout|Timeout \d+ ?ms exceeded/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Whether a thrown fetch error is a CONNECTION-LEVEL failure: the runner's
 * egress could not reach the server at all (DNS/socket/abort/network), so NO
 * HTTP response was ever received. This is the only class the Jina egress
 * fallback may rescue — it re-fetches the same URL through a clean IP.
 *
 * Crucially this EXCLUDES HTTP error statuses (4xx/5xx). Those mean the server
 * DID respond (the egress works); a persistent 503/500 is a real server-side
 * failure, and re-routing it through Jina would just make an extra request that
 * cannot help (and corrupts the "exactly N attempts" contract — see
 * tests/crawler-fetch-retry.test.ts "exhausts retries … after persistent 503").
 * HTTP errors in this codebase are always thrown with a finite `err.status`
 * (RETRYABLE_STATUS path), so the presence of `err.status` is the discriminator.
 */
export function isConnectionLevelFetchError(err) {
  if (!err) return false;
  // A response was received (HTTP error status tagged by the caller) → NOT a
  // connection-level failure, even though it may be a retryable 5xx.
  if (Number.isFinite(err.status)) return false;
  return isTransientFetchError(err);
}

/**
 * Run an async fetch operation with exponential backoff + jitter on transient
 * failures (429/5xx, network errors, timeouts). 4xx and other persistent
 * errors fail fast. Defaults: 3 retries → backoff 1s/2s/4s (+ jitter).
 *
 * Env overrides (so CI can tune without code change):
 *   JOBS_CRAWLER_RETRIES        — max retries (default 3)
 *   JOBS_CRAWLER_RETRY_BASE_MS  — base backoff ms (default 1000)
 *
 * @param {() => Promise<T>} attemptFn — performs one fetch attempt
 * @param {Object} [opts] — { retries, retryBaseMs, label, isTransient }
 * @returns {Promise<T>}
 */
export async function fetchWithRetry(attemptFn, opts = {}) {
  const pick = (override, envVal, fallback) => {
    if (Number.isFinite(override)) return override;
    const env = Number(envVal);
    return Number.isFinite(env) ? env : fallback;
  };
  const maxRetries = Math.max(0, pick(opts.retries, process.env.JOBS_CRAWLER_RETRIES, 3));
  const baseMs = Math.max(0, pick(opts.retryBaseMs, process.env.JOBS_CRAWLER_RETRY_BASE_MS, 1000));
  const transient = typeof opts.isTransient === 'function' ? opts.isTransient : isTransientFetchError;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await attemptFn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !transient(err)) throw err;
      const delay = baseMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * baseMs);
      if (opts.label) {
        console.warn(
          `[fetchWithRetry] ${opts.label}: transient failure (${String(err?.message || err)}), `
          + `retry ${attempt + 1}/${maxRetries} in ${delay + jitter}ms`,
        );
      }
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}
