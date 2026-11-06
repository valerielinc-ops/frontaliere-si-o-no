import { fetchHtml, fetchHtmlWithCookies } from './crawler-template.mjs';
import { rescueHtmlIfChallenged } from './jina-proxy.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;
const LISTING_CARD_MARKER = 'vacancy__render';
const APLUS_COMPANY_ID = '34990';
const APLUS_EMPTY_MARKER_RE = /(?:no vacancies available|nessun annuncio disponibile)/i;

function isAplusAccessPage(html = '') {
  return /<title[^>]*>\s*Inrecruiting\s*\|\s*access\b/i.test(html)
    || /<h[1-6][^>]*>\s*login to your account\b/i.test(html);
}

function extractAplusCsrf(html = '') {
  const token = html.match(/CSRFToken=([^&"'\s]+)/i)?.[1] || '';
  const hash = html.match(/CSRFHash=([^&"'\s]+)/i)?.[1] || '';
  if (!token || !hash) return null;
  return {
    token: decodeURIComponent(token),
    hash: decodeURIComponent(hash),
  };
}

function cookieHeader(cookieJar) {
  if (!(cookieJar instanceof Map) || cookieJar.size === 0) return '';
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * InRecruiting's A++ career route currently redirects to the login page, but
 * its public career-page AJAX endpoint still returns the published vacancy
 * cards. The CSRF pair is emitted by the same public response and is not an
 * authentication credential; keep the request tied to that page/session.
 */
async function fetchAplusAjaxListing({ listingUrl, html, cookieJar, userAgent, timeoutMs, fetchImpl = fetch }) {
  const csrf = extractAplusCsrf(html);
  if (!csrf) {
    console.warn('⚠️ A++ access page did not expose the CSRF pair needed for its public vacancy endpoint');
    return null;
  }

  const endpoint = new URL('/app.php', listingUrl);
  endpoint.search = new URLSearchParams({
    opmode: 'guest',
    module: 'newcareer',
    ajax: '1',
    IdAzienda: APLUS_COMPANY_ID,
    CSRFToken: csrf.token,
    CSRFHash: csrf.hash,
    lang: /\/it(?:\/|$)/i.test(listingUrl) ? 'it' : 'en',
  }).toString();
  const body = new URLSearchParams({
    act1: 'vacancyListCareer',
    section: '',
    order: 'name',
    page: '1',
    country: '',
    region: '',
    function: '',
    project: '',
    text: '',
    division: '',
    company: '',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgent,
        Referer: listingUrl,
        'X-Requested-With': 'XMLHttpRequest',
        ...(cookieHeader(cookieJar) ? { Cookie: cookieHeader(cookieJar) } : {}),
      },
      body: body.toString(),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      console.warn(`⚠️ A++ public vacancy endpoint returned HTTP ${response.status}`);
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.warn('⚠️ A++ public vacancy endpoint returned malformed JSON');
      return null;
    }
    if (payload?.success !== true || typeof payload.data !== 'string') {
      console.warn('⚠️ A++ public vacancy endpoint returned an invalid payload');
      return null;
    }
    if (!payload.data.includes(LISTING_CARD_MARKER) && !APLUS_EMPTY_MARKER_RE.test(payload.data)) {
      console.warn('⚠️ A++ public vacancy endpoint returned no recognized vacancy or empty-board marker');
      return null;
    }
    return payload.data;
  } catch (error) {
    console.warn(`⚠️ A++ public vacancy endpoint failed: ${error?.message || error}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
      const html = await fetchHtmlWithCookies(url, { timeoutMs, cookieJar, headers });
      // The cookie-aware transport deliberately returns successful responses
      // as-is, so detail pages also need the shared 200-but-challenge rescue.
      // A WAF challenge on a detail URL otherwise reaches the parser as a
      // title-less page and drops the live vacancy.
      if (url !== listingUrl) {
        return rescueHtmlIfChallenged(html, url, { timeoutMs });
      }
      // Keep fetchHtml's existing 200-but-challenge rescue for the listing:
      // a WAF challenge can be an HTTP-success response, so it does not enter
      // the catch branch even though the parser would see zero cards.
      if (url === listingUrl && !html.includes(LISTING_CARD_MARKER)) {
        if (isAplusAccessPage(html)) {
          const ajaxListing = await fetchAplusAjaxListing({
            listingUrl,
            html,
            cookieJar,
            userAgent,
            timeoutMs,
          });
          if (ajaxListing) {
            console.log('✅ A++ vacancy cards discovered through the public InRecruiting AJAX listing');
            return ajaxListing;
          }
        }
        console.warn(`⚠️ A++ listing session returned no vacancy card marker for ${url}; retrying through shared HTML rescue`);
        return fetchHtml(url, { timeoutMs, headers });
      }
      return html;
    } catch (sessionError) {
      console.warn(
        `⚠️ A++ session fetch failed for ${url}: ${sessionError?.message || sessionError}; retrying through shared HTML rescue`,
      );
      return fetchHtml(url, { timeoutMs, headers });
    }
  };
}
