/**
 * Jina Reader egress proxy for IP-blocked crawler sources.
 *
 * Some career sites (e.g. cambiavalute.ch, #1363/#1417) sit behind a WAF that
 * serves a challenge / empty page to GitHub Actions datacenter IPs, even when
 * the UA + headers are a perfect browser match — the block is on the egress IP
 * reputation, which no header tweak can fix. The jobs ARE reachable from a
 * residential / clean IP.
 *
 * Jina Reader (https://r.jina.ai) fetches a URL with a real browser from its own
 * (non-blocked) IP pool and, with `X-Return-Format: html`, returns the raw HTML.
 * Routing the blocked host's requests through it transparently yields the real
 * page so the existing parsers work unchanged. Free, no key required for the
 * handful of requests a dedicated crawler makes per run (an optional
 * `JINA_API_KEY` raises the rate limit if ever needed).
 *
 * Opt-in only: the shared crawler applies this when `JOBS_CRAWLER_FETCH_PROXY`
 * lists the request's host, so the default path for the other ~400 crawlers is
 * completely untouched.
 */

export const JINA_READER_BASE = 'https://r.jina.ai/';

/** Build the Jina-proxied request (URL + headers) for a target URL. */
export function jinaProxiedRequest(targetUrl) {
  const headers = {
    // Return the page's raw HTML (not Jina's default markdown) so downstream
    // HTML/JSON-LD parsers see exactly what a direct fetch would have returned.
    'X-Return-Format': 'html',
  };
  const key = (process.env.JINA_API_KEY || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: `${JINA_READER_BASE}${targetUrl}`, headers };
}

/**
 * Does `url`'s host match any entry in the comma-separated `listCsv`
 * (`JOBS_CRAWLER_FETCH_PROXY`)? Matches the host exactly or as a subdomain.
 */
export function hostMatchesProxyList(url, listCsv) {
  if (!listCsv) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return String(listCsv)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((h) => host === h || host.endsWith(`.${h}`));
}