/**
 * live-link-check.mjs — shared live-URL liveness check + bounded-concurrency
 * runner.
 *
 * Extracted from scripts/check-journalist-article-links.mjs (issue #3174) so
 * scripts/send-job-alerts.mjs (issue #3172) can reuse the EXACT same
 * liveness semantics for its own pre-send dead-link preflight, instead of a
 * hand-rolled duplicate that would drift from this one over time (AGENTS.md
 * sibling-pattern rule: a HEAD/405-fallback/timeout construct copy-pasted
 * into a second file is exactly the kind of thing that silently diverges).
 *
 * checkLink() semantics (unchanged from the original journalist-article
 * version): HEAD request; if the origin rejects HEAD with 405/501 (some
 * static hosts / edge configs do this), fall back to a ranged GET
 * (`Range: bytes=0-0`) and accept 200 or 206. Any network error, abort, or
 * non-ok status → false ("not live"). No retry — callers that need
 * protection against a *systemic* false-negative (e.g. an outbound network
 * blip on OUR side making every check fail) must add their own fail-open
 * guard around the aggregate result; this helper only reports per-URL
 * liveness.
 */

export const DEFAULT_LIVE_CHECK_TIMEOUT_MS = 8_000;

/** HEAD-check a single URL; falls back to a ranged GET if the origin rejects
 * HEAD (some static hosts / edge configs return 405/501 for it). Never
 * throws — resolves `false` on any non-ok status, network error, or timeout.
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @param {object} [opts]
 * @param {boolean} [opts.cacheBust=false] Append a unique `_=<ts>` query param
 *   so the check reads the ORIGIN, defeating any edge/proxy cache. Used by the
 *   deploy-time deep-sample propagation gate (wait-for-pages-propagation.mjs),
 *   where a cached 200 must not mask an origin propagation hole. The default
 *   (false) keeps the send-job-alerts preflight semantics: there the EDGE
 *   response is exactly what the email recipient will hit, so the cache layer
 *   must stay in the loop.
 * @param {Record<string,string>} [opts.headers] Extra request headers (e.g.
 *   User-Agent / Cache-Control) merged into both the HEAD and the fallback GET.
 */
export async function checkLink(url, timeoutMs = DEFAULT_LIVE_CHECK_TIMEOUT_MS, opts = {}) {
  const { cacheBust = false, headers = {} } = opts;
  const target = cacheBust ? `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}` : url;
  try {
    const res = await fetch(target, {
      method: 'HEAD',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 405 || res.status === 501) {
      const getRes = await fetch(target, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return getRes.ok || getRes.status === 206;
    }
    return res.ok;
  } catch {
    return false;
  }
}

/** Run `worker(item, index)` over `items` with at most `concurrency` in
 * flight. Returns results in the same order as `items`. */
export async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function run() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return results;
}
