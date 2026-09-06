/**
 * Shared guard for XML/RSS feed endpoints hosted on a vendor career site.
 *
 * Why this exists (#7847): every feed parser in this repo hands the response
 * body straight to `XMLValidator.validate()`. When a vendor takes its ATS
 * offline the host does NOT answer 404 — it answers `301 → the corporate
 * marketing page`, and `fetch` follows that redirect silently. The parser then
 * validates an HTML document as XML and reports
 * `XML parse failed: char '&' is not expected`, which describes the marketing
 * page's inline scripts instead of the fact that the feed endpoint is gone.
 * Observed live on `careers.nordangliaeducation.com`, whose whole host (feed,
 * search and job-detail paths alike) redirects to
 * `https://www.nordangliaeducation.com/careers`.
 *
 * Two things follow from that, and both are this module's job:
 *
 * 1. **Name the real fact.** A response that did not come back from the feed's
 *    own host is not malformed XML; it is a missing endpoint. The diagnosis is
 *    the measure, and a wrong measure gets corrected (VISION.md D2).
 * 2. **Don't de-index, don't cry wolf every run.** Nothing in this repo can
 *    make a decommissioned vendor host serve a feed again, so hard-failing the
 *    crawler files a "Crawler Failure" issue on every wave for a condition no
 *    diff can fix. Errors carrying `feedEndpointUnavailable` are therefore
 *    soft-exited by `crawler-template.mjs` (pipeline catch + `exitCrawlerOnError`)
 *    exactly like a connection-level failure: existing slice preserved, run
 *    green, and persistence still surfaces through the crawler-health monitor
 *    (3 consecutive zero-job runs → broken issue, deduplicated by title).
 *
 * This is deliberately NARROW: it fires only when the response demonstrably did
 * not come from the feed — the effective URL left the feed's host, or the body
 * is an HTML document. An HTTP error status and genuinely malformed XML keep
 * failing loudly through the callers' existing paths.
 */

/** Thrown when a feed endpoint answers from somewhere other than its own host. */
export class FeedEndpointUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedEndpointUnavailableError';
    // Read by crawler-template.mjs (pipeline catch + exitCrawlerOnError).
    this.feedEndpointUnavailable = true;
  }
}

function hostOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function expectedHostSet(expectedHosts) {
  return new Set(
    (Array.isArray(expectedHosts) ? expectedHosts : [expectedHosts])
      .map((host) => String(host || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Assert a feed response came back from the feed's own host.
 *
 * An unparseable or empty `effectiveUrl` is treated as "no redirect evidence"
 * and passes: `Response` objects built by tests (and some fetch adapters) do
 * not expose `.url`, and inventing a failure from missing metadata would be a
 * new false positive.
 *
 * @param {string} label            crawler-facing label used in the message
 * @param {string|string[]} expectedHosts  host(s) the feed legitimately answers from
 * @param {string} effectiveUrl     final URL after redirects (`res.url`)
 * @throws {FeedEndpointUnavailableError}
 */
export function assertFeedEndpointHost(label, expectedHosts, effectiveUrl) {
  const actualHost = hostOf(effectiveUrl);
  if (!actualHost) return;
  const allowed = expectedHostSet(expectedHosts);
  if (allowed.size === 0 || allowed.has(actualHost)) return;
  throw new FeedEndpointUnavailableError(
    `[${label}] feed endpoint redirected off ${[...allowed].join('/')} to ${actualHost} `
    + '— the vendor feed is unavailable, keeping the indexed slice',
  );
}

/** An XML feed body always opens with one of these, whatever the vendor. */
const XML_FEED_PROLOGUE_RE = /^\s*(?:<\?xml\b|<!DOCTYPE\s+(?:rss|feed|urlset)\b|<(?:rss|feed|urlset|channel)\b)/i;
const HTML_DOCUMENT_RE = /^\s*(?:<!DOCTYPE\s+html\b|<html\b)/i;

/**
 * Assert a feed body is a feed at all, for callers that only ever see the
 * response TEXT (`fetchHtml()` returns a string, so `res.url` is not
 * observable). An HTML document here means the request was answered by a
 * marketing/maintenance page — the same missing-endpoint fact
 * `assertFeedEndpointHost` catches from the redirect chain.
 *
 * Deliberately narrow: only a body that is unambiguously an HTML DOCUMENT
 * fails. Anything that opens like XML — including genuinely malformed XML —
 * flows through to the caller's XML validation and keeps failing loudly there.
 *
 * @param {string} label
 * @param {string|string[]} expectedHosts  host(s) named in the message
 * @param {string} body
 * @throws {FeedEndpointUnavailableError}
 */
export function assertFeedBodyLooksLikeXml(label, expectedHosts, body) {
  const text = typeof body === 'string' ? body : '';
  if (!HTML_DOCUMENT_RE.test(text) || XML_FEED_PROLOGUE_RE.test(text)) return;
  const allowed = [...expectedHostSet(expectedHosts)].join('/');
  throw new FeedEndpointUnavailableError(
    `[${label}] feed endpoint ${allowed ? `on ${allowed} ` : ''}answered with an HTML document `
    + 'instead of an XML feed — the vendor feed is unavailable, keeping the indexed slice',
  );
}
