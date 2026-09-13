/**
 * Shared guard for XML/RSS feed endpoints hosted on a vendor career site.
 *
 * A decommissioned ATS can answer `301 → a corporate marketing page` instead
 * of returning a feed. `fetch` follows that redirect silently, so handing the
 * resulting HTML to XMLValidator reports malformed XML rather than the real
 * source outage. Keep that distinction explicit and let crawler-template.mjs
 * preserve the existing indexed slice for this source-level condition.
 */

/** Thrown when a feed endpoint answers from somewhere other than its own host. */
export class FeedEndpointUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedEndpointUnavailableError';
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
 * Fetch adapters and constructed test Responses may not expose an effective
 * URL. Missing redirect metadata is therefore accepted rather than invented
 * into a failure; the body-only guard covers callers that only receive text.
 *
 * @param {string} label
 * @param {string|string[]} expectedHosts
 * @param {string} effectiveUrl final URL after redirects (`res.url`)
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

/** An XML feed always opens with one of these, whatever the vendor. */
const XML_FEED_PROLOGUE_RE = /^\s*(?:<\?xml\b|<!DOCTYPE\s+(?:rss|feed|urlset)\b|<(?:rss|feed|urlset|channel)\b)/i;
const HTML_DOCUMENT_RE = /^\s*(?:<!DOCTYPE\s+html\b|<html\b)/i;

/**
 * Assert a body is a feed at all for callers that only receive response text.
 * Only an unambiguous HTML document is classified as a missing endpoint;
 * genuinely malformed XML continues through the caller's XML validator.
 *
 * @param {string} label
 * @param {string|string[]} expectedHosts
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
