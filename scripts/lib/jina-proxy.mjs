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
 * Fetch a URL through the Jina proxy with an AbortController timeout, so a slow
 * or hanging Jina request can never stall a crawler run until the global job
 * timeout. Returns the raw `Response`. Used by dedicated crawlers that fetch
 * outside the shared `fetchWithTimeout` chokepoint (discovery / single-page).
 */
export async function fetchViaJina(targetUrl, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const { url, headers } = jinaProxiedRequest(targetUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Jina answers HTTP 200 even when it could not actually serve the target page:
 * an upstream failure (target unreachable from Jina, a challenge/error page, or
 * a rate-limit notice) comes back as a 200 with a non-target body. `res.ok` is
 * then `true` and the downstream parser silently receives a non-job page → 0
 * links/roles → a graceful skip that is indistinguishable from "the source is
 * genuinely empty" (#1422 item 1). This inspects a proxied 200 body and returns
 * a short human-readable reason string when it does NOT look like a real target
 * page (so the caller can log an explicit "200-but-not-target" warning), or
 * `null` when the body looks like a genuine page.
 *
 * Conservative by design — it only flags a body that is empty / suspiciously
 * short or that carries an unambiguous Jina/WAF error-or-challenge marker, so a
 * real (if unusual) target page is never misclassified. Detection is advisory:
 * callers log and continue (the downstream parser still yields 0 and skips), it
 * never blocks publishing data.
 */
export function detectJinaErrorBody(body, { minLength = 200 } = {}) {
  const text = typeof body === 'string' ? body : '';
  const trimmed = text.trim();
  if (!trimmed) return 'empty body';
  if (trimmed.length < minLength) {
    return `body too short (${trimmed.length} < ${minLength} chars)`;
  }
  // Unambiguous "this is not the target page" markers: Jina's own
  // failure-to-fetch envelope and the standard WAF/anti-bot challenge banners a
  // proxied fetch can still land on. Kept narrow to avoid false positives on a
  // real jobs page.
  const lower = trimmed.toLowerCase();
  const ERROR_MARKERS = [
    'failed to fetch the target url',
    'target url returned error',
    'this site can’t be reached',
    "this site can't be reached",
    'just a moment...',
    'attention required!',
    'checking your browser before accessing',
    'enable javascript and cookies to continue',
  ];
  const hit = ERROR_MARKERS.find((m) => lower.includes(m));
  return hit ? `error/challenge marker: "${hit}"` : null;
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