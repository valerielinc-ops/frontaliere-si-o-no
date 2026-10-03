import { fetchHtml, fetchHtmlWithCookies } from './crawler-template.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Build a page fetcher for the A++ InRecruiting tenant.
 *
 * InRecruiting can set a session cookie while serving the career page and
 * require that same session (plus a same-site referrer) on vacancy details.
 * Native fetch does not retain cookies across separate requests, so fetching
 * the listing and then each detail independently can turn a live tenant into
 * an all-details-failed zero-result run. Keep one jar for the whole crawler
 * process; if the session path itself is unavailable, fall back to the shared
 * fetchHtml rescue path (including the clean-egress Jina fallback for 403s and
 * connection-level failures).
 *
 * @param {{ listingUrl: string, userAgent: string }} options
 * @returns {(url: string, timeoutMs?: number) => Promise<string>}
 */
export function createAplusPageFetcher({ listingUrl, userAgent }) {
  const cookieJar = new Map();

  return async function fetchAplusPage(
    url,
    timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  ) {
    const headers = {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': userAgent,
      ...(url !== listingUrl ? {
        Referer: listingUrl,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      } : {}),
    };

    try {
      return await fetchHtmlWithCookies(url, { timeoutMs, cookieJar, headers });
    } catch (sessionError) {
      console.warn(
        `⚠️ A++ session fetch failed for ${url}: ${sessionError?.message || sessionError}; retrying through shared HTML rescue`,
      );
      return fetchHtml(url, { timeoutMs, headers });
    }
  };
}
