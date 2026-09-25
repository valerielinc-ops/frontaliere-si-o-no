/**
 * Guards for feed endpoints that silently redirect to a vendor's marketing
 * or maintenance page when the ATS is unavailable.
 *
 * A feed parser must not describe that page as XML/selector drift: it did not
 * observe the source at all. The error is deliberately soft-exitable by the
 * crawler template so an unavailable vendor cannot de-index the last slice or
 * turn every scheduled run into a crawler-failure issue.
 */

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
 * Assert that a response's effective URL is still on the feed host.
 * Missing URL metadata is tolerated because some test/fetch adapters omit it.
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

const XML_FEED_PROLOGUE_RE = /^\s*(?:<\?xml\b|<!DOCTYPE\s+(?:rss|feed|urlset)\b|<(?:rss|feed|urlset|channel)\b)/i;
const HTML_DOCUMENT_RE = /^\s*(?:<!DOCTYPE\s+html\b|<html\b)/i;

/**
 * Assert that a response body is plausibly an XML feed when redirect metadata
 * is unavailable. Malformed XML still belongs to the caller's XML validator.
 */
export function assertFeedBodyLooksLikeXml(label, expectedHosts, body) {
  const text = typeof body === 'string' ? body : '';
  if (!HTML_DOCUMENT_RE.test(text) || XML_FEED_PROLOGUE_RE.test(text)) return;

  const allowed = [...expectedHostSet(expectedHosts)].join('/');
  throw new FeedEndpointUnavailableError(
    `[${label}] feed endpoint${allowed ? ` on ${allowed}` : ''} answered with an HTML document `
      + 'instead of an XML feed — the vendor feed is unavailable, keeping the indexed slice',
  );
}
