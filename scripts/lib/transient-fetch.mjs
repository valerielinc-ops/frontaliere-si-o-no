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

/**
 * HTTP statuses that signal an IP-reputation WAF / anti-bot fence keyed on the
 * DATACENTER egress IP rather than on the request content — the same source
 * returns a normal 200/301 to a residential / Jina clean IP. The HTML fetch
 * helpers (`fetchHtml` in crawler-template + hospital-custom-html-helpers,
 * `fetchPage` in hirslanden) route these through the Jina Reader proxy as a
 * clean-IP fallback before giving up. Shared here (single source of truth) so
 * the three fetch sites can't drift — AGENTS.md #6.
 *
 * 404/410 (gone) and 401 (auth) are deliberately EXCLUDED: those are genuine,
 * content-level responses Jina cannot clear. 403 (forbidden/anti-bot), 406
 * (not-acceptable UA gate), 415 (unsupported-media-type WAF reply, #2025) and
 * 451 (legal block) are the observed IP-block class.
 */
export const WAF_IP_BLOCK_STATUS = new Set([403, 406, 415, 451]);

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
  // Undici wraps connector/lookup failures in `TypeError: fetch failed` and
  // keeps the real error under one or more `.cause` links. A public-network
  // policy rejection is deterministic, so it must win over the outer generic
  // TypeError; retrying it only repeats the forbidden DNS lookup and backoff.
  {
    const seen = new Set();
    let cause = err;
    while (cause && (typeof cause === 'object' || typeof cause === 'function') && !seen.has(cause)) {
      seen.add(cause);
      if (cause.code === 'ERR_PUBLIC_FETCH_POLICY') return false;
      cause = cause.cause;
    }
  }
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
  // This substring match is a DELIBERATE fallback, not an oversight: undici
  // does not guarantee a `.cause.code` on every "fetch failed" TypeError (a
  // vendor-wrapped rethrow, e.g. SuccessFactorsApiError below, can lose the
  // whole cause chain and keep only the message), so there is no stable
  // structured signal to prefer here. It IS a silent-drift risk — a future
  // Node/undici wording change on this exact path would slip past unnoticed
  // — which is why `tests/transient-fetch.test.ts` pins this literal wording
  // in a dedicated case: touching the regex below without updating that test
  // (and vice versa) is the signal that the coupling broke.
  if (err.name === 'TypeError' && /fetch failed|network|socket hang up/i.test(msg)) {
    return true;
  }
  // Generic message-level transient signals (Playwright navigation timeout,
  // wrapped client errors like SuccessFactorsApiError "network error: fetch
  // failed" that lose the original TypeError name when re-thrown). Same
  // wording-drift caveat as above applies here.
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

/**
 * Resilient `fetch` wrapper for one-shot data-refresh downloads (BAG/SECO/ISTAT/
 * FSO/PostHog/exchange-history…). A SINGLE transient network blip (DNS hiccup,
 * `UND_ERR_CONNECT_TIMEOUT`, `fetch failed`, socket reset) or a retryable HTTP
 * status (429/408/425/5xx) used to crash the whole scheduled run and auto-file a
 * priority:high "Workflow Failure" issue. This wraps the native `fetch` in the
 * shared exponential-backoff-with-jitter loop so transient failures self-heal,
 * while persistent errors (4xx other than 408/425/429, parse errors, a source
 * that is genuinely unreachable after all retries) still fail loudly.
 *
 * Behaviour preserved vs a raw `fetch(url, options)`:
 *   - returns the same `Response` object (caller still does `.text()`/`.json()`/
 *     `.arrayBuffer()`, inspects `.ok`/`.status`/`.headers` as before);
 *   - does NOT throw on a non-retryable non-ok status — the caller keeps its own
 *     `if (!res.ok) …` handling (e.g. graceful-degradation paths);
 *   - bounds the CONNECTION/HEADER phase with a per-attempt timeout (a stalled
 *     DNS/TLS/handshake aborts instead of blocking the run forever, and the
 *     abort is treated as transient) — but clears the timer the instant the
 *     response headers arrive, so the body read the caller runs afterwards
 *     (`.text()`/`.arrayBuffer()` on a multi-MB ZIP/XLSX) is NOT aborted
 *     mid-stream. Keeping an `AbortSignal.timeout` armed through the body read
 *     would abort a slow-but-healthy large download and throw an `AbortError`
 *     at the caller's `.arrayBuffer()` (outside its try/catch) → the very
 *     "Workflow Failure" crash this helper exists to prevent.
 *
 * Retryable HTTP statuses are surfaced as a thrown tagged error so the backoff
 * loop sees them; after the final attempt the real `Response` is returned so the
 * caller's own status handling runs unchanged.
 *
 * Env overrides (shared with fetchWithRetry):
 *   JOBS_CRAWLER_RETRIES, JOBS_CRAWLER_RETRY_BASE_MS
 *
 * @param {string|URL} url
 * @param {RequestInit} [options]  native fetch options (headers, method, body…)
 * @param {Object} [opts] — { retries, retryBaseMs, timeout, label }
 *   timeout: per-attempt abort timeout in ms (default 30000)
 * @returns {Promise<Response>}
 */
export async function httpFetchWithRetry(url, options = {}, opts = {}) {
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 30000;
  const label = opts.label || String(url);
  return fetchWithRetry(
    async () => {
      // Bound ONLY the connection/header phase, never the body read. We use a
      // manual AbortController + a timer we clear the instant `fetch` resolves
      // (response headers received) so a slow-but-healthy body stream — the
      // multi-MB BAG archive ZIP / regions XLSX read later via
      // `.arrayBuffer()`/`.text()` at the call site — is never aborted
      // mid-stream. `AbortSignal.timeout(timeout)` would stay armed through the
      // body read and crash the run on a legit large download. A caller-supplied
      // signal still takes precedence (left as-is, no extra timer).
      let res;
      if (options.signal || !(timeout > 0)) {
        res = await fetch(url, options);
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          res = await fetch(url, { ...options, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      }
      // Retryable HTTP status → throw a tagged transient error so the backoff
      // loop retries it. On the FINAL attempt fetchWithRetry re-throws this, so
      // we attach the Response to let the caller still inspect it if it catches.
      if (RETRYABLE_STATUS.has(res.status)) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} for ${label}`);
        err.status = res.status;
        err.retryable = true;
        err.response = res;
        throw err;
      }
      return res;
    },
    { ...opts, label },
  ).catch((err) => {
    // If the last failure was a retryable HTTP status, hand the real Response
    // back so the caller's own `if (!res.ok)` logic runs unchanged instead of
    // forcing every call site to special-case our thrown error.
    if (err && err.retryable === true && err.response) return err.response;
    throw err;
  });
}
