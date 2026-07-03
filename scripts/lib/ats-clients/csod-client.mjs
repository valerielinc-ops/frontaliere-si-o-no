/**
 * Cornerstone OnDemand (CSOD) ATS — Shared client.
 *
 * Pipeline:
 *
 *   tenant host + career site id → GET career portal page (SPA shell)
 *     ↓
 *   extract embedded JWT ("token":"eyJ...") + Set-Cookie session cookies +
 *   cloud API base ("cloud":"https://eu-fra.api.csod.com/")
 *     ↓
 *   POST {cloudApiBase}rec-job-search/external/jobs (Bearer auth, paginated)
 *     ↓
 *   raw requisition objects, yielded as-is (per-company parser normalizes)
 *
 * CSOD career sites are React SPAs — the static portal HTML carries no job
 * listing, only a bootstrap config object with a short-lived JWT used to
 * call CSOD's own cloud search API. This module centralizes:
 *
 * - Token + cookie + cloud-API-base acquisition (`acquireCsodToken`)
 * - Paginated authenticated search (`searchCsodJobs`)
 * - One-shot orchestration with automatic 401 re-auth retry (`fetchCsodJobs`)
 *
 * Extracted from the first production implementation (Groupe Mutuel,
 * `scripts/update-groupe-mutuel-jobs.mjs`) so the second CSOD tenant
 * (Chopard) does not duplicate the auth/pagination logic — see AGENTS.md
 * sibling-pattern rule (##6): a literal construct duplicated across 2 files
 * must move to one shared module, so drift is impossible by construction.
 * Groupe Mutuel's own inline implementation is left untouched (surgical
 * scope — not a drive-by refactor of a working production crawler).
 *
 * does NOT replace per-company parsers — those still own company-specific
 * concerns (canton inference, sector tagging, employment-type heuristics,
 * address fallback, slug building).
 */

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_CLOUD_API_BASE = 'https://eu-fra.api.csod.com/';
const DEFAULT_USER_AGENT =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

export class CsodApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'CsodApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Build the public CSOD career-portal URL for a tenant.
 *
 * @param {string} tenantHost e.g. 'chopard.csod.com'
 * @param {string|number} careerSiteId e.g. 1
 * @param {string} companyParam CSOD `c=` query param (usually the brand slug)
 * @param {string} cultureName e.g. 'en-US', 'fr-FR'
 * @returns {string}
 */
export function buildCsodCareerUrl(tenantHost, careerSiteId, companyParam, cultureName = 'en-US') {
  return `https://${tenantHost}/ux/ats/careersite/${careerSiteId}/home?c=${encodeURIComponent(companyParam)}&lang=${cultureName}`;
}

/**
 * Acquire the JWT bearer token, session cookies, and cloud API base URL
 * from a CSOD career portal page. The token is short-lived and embedded
 * directly in the SPA bootstrap HTML.
 *
 * @param {string} careerUrl Full CSOD career portal URL (see buildCsodCareerUrl).
 * @param {{ timeoutMs?: number, userAgent?: string, acceptLanguage?: string }} [opts]
 * @returns {Promise<{ token: string, cookies: string, cloudApiBase: string }|null>}
 */
export async function acquireCsodToken(careerUrl, opts = {}) {
  const {
    timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    userAgent = DEFAULT_USER_AGENT,
    acceptLanguage = 'en-US,en;q=0.9',
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(careerUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': acceptLanguage,
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    console.warn(`⚠️ CSOD: failed to fetch career portal ${careerUrl}: ${err.message}`);
    return null;
  }

  if (!response.ok) {
    console.warn(`⚠️ CSOD: career portal returned HTTP ${response.status} for ${careerUrl}`);
    return null;
  }

  const setCookieHeaders = response.headers.getSetCookie?.() || [];
  const cookieString = setCookieHeaders.map((c) => c.split(';')[0]).join('; ');

  const html = await response.text();

  let tokenMatch = html.match(/"token"\s*:\s*"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
  if (!tokenMatch) {
    tokenMatch = html.match(/["']token["']\s*:\s*["'](eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["']/);
  }
  if (!tokenMatch) {
    tokenMatch = html.match(/Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  }
  if (!tokenMatch) {
    console.warn('⚠️ CSOD: failed to extract JWT token from career portal HTML — format may have changed.');
    return null;
  }

  const token = tokenMatch[1];
  const cloudMatch = html.match(/"cloud"\s*:\s*"(https?:\/\/[^"]+)"/);
  const cloudApiBase = cloudMatch?.[1] || DEFAULT_CLOUD_API_BASE;

  return { token, cookies: cookieString, cloudApiBase };
}

async function fetchWithAuth(url, token, cookies, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        ...(cookies ? { Cookie: cookies } : {}),
        ...options.headers,
      },
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    console.warn(`⚠️ CSOD: fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Search a CSOD career site for all job requisitions using the paginated
 * cloud API. Returns `null` (instead of an array) when the token has
 * expired (HTTP 401) — caller should re-acquire and retry once.
 *
 * @param {string} cloudApiBase e.g. 'https://eu-fra.api.csod.com/'
 * @param {string} token Bearer JWT from acquireCsodToken().
 * @param {string} cookies Cookie header string from acquireCsodToken().
 * @param {Object} params
 * @param {string|number} params.careerSiteId
 * @param {number} [params.cultureId] CSOD locale id (e.g. 1 = en-US).
 * @param {string} [params.cultureName] e.g. 'en-US'.
 * @param {string} [params.referer] Referer header (career portal origin).
 * @param {number} [params.pageSize]
 * @param {number} [params.maxPages]
 * @param {number} [params.timeoutMs]
 * @param {string} [params.userAgent]
 * @returns {Promise<any[]|null>}
 */
export async function searchCsodJobs(cloudApiBase, token, cookies, params = {}) {
  const {
    careerSiteId,
    cultureId = 1,
    cultureName = 'en-US',
    referer = '',
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    timeoutMs,
    userAgent,
  } = params;

  const allJobs = [];
  let pageNumber = 1;
  let retries = 0;

  const apiBase = cloudApiBase.endsWith('/') ? cloudApiBase : `${cloudApiBase}/`;
  const searchUrl = `${apiBase}rec-job-search/external/jobs`;

  while (pageNumber <= maxPages) {
    const body = JSON.stringify({
      careerSiteId: Number(careerSiteId),
      careerSitePageId: Number(careerSiteId),
      pageNumber,
      pageSize,
      cultureId,
      searchText: '',
      cultureName,
      states: [],
      countryCodes: [],
      cities: [],
      placeID: '',
      radius: null,
      postingsWithinDays: null,
      customFieldCheckboxKeys: [],
      customFieldDropdowns: [],
      customFieldRadios: [],
    });

    const response = await fetchWithAuth(searchUrl, token, cookies, {
      method: 'POST',
      body,
      timeoutMs,
      userAgent,
      headers: {
        'csod-accept-language': cultureName,
        ...(referer ? { Referer: referer } : {}),
      },
    });

    if (!response) {
      console.warn('⚠️ CSOD: no response from cloud search API');
      break;
    }

    if (response.status === 401) {
      return null; // signal: token expired, caller should re-acquire
    }

    if (!response.ok) {
      console.warn(`⚠️ CSOD: search API returned HTTP ${response.status}`);
      if (retries < 2) {
        retries++;
        await new Promise((r) => setTimeout(r, 2000 * retries));
        continue;
      }
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      console.warn(`⚠️ CSOD: failed to parse JSON response: ${err.message}`);
      break;
    }

    const innerData = data?.data || data;
    const jobs = Array.isArray(innerData?.requisitions)
      ? innerData.requisitions
      : Array.isArray(data?.requisitions)
        ? data.requisitions
        : Array.isArray(innerData?.data)
          ? innerData.data
          : [];

    if (!Array.isArray(jobs)) {
      console.warn('⚠️ CSOD: unexpected response shape — no requisitions array found');
      break;
    }

    allJobs.push(...jobs);

    const total = innerData?.totalCount || data?.total || data?.totalCount || 0;
    if (total > 0 && allJobs.length >= total) break;
    if (jobs.length < pageSize) break;
    if (jobs.length === 0) break;

    pageNumber++;
    retries = 0;
    await new Promise((r) => setTimeout(r, 500));
  }

  return allJobs;
}

/**
 * One-shot orchestration: acquire a CSOD token, run the paginated search,
 * and transparently retry once (re-acquiring the token) on a 401.
 *
 * @param {string} tenantHost e.g. 'chopard.csod.com'
 * @param {string|number} careerSiteId
 * @param {Object} [options]
 * @param {string} [options.companyParam] CSOD `c=` query param (defaults to tenant subdomain).
 * @param {number} [options.cultureId]
 * @param {string} [options.cultureName]
 * @param {string} [options.referer]
 * @param {number} [options.pageSize]
 * @param {number} [options.maxPages]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.userAgent]
 * @returns {Promise<any[]>} Raw requisition objects (empty array on failure).
 */
export async function fetchCsodJobs(tenantHost, careerSiteId, options = {}) {
  const {
    companyParam = String(tenantHost || '').split('.')[0],
    cultureId = 1,
    cultureName = 'en-US',
    referer = `https://${tenantHost}/`,
    pageSize,
    maxPages,
    timeoutMs,
    userAgent,
  } = options;

  const careerUrl = buildCsodCareerUrl(tenantHost, careerSiteId, companyParam, cultureName);

  let auth = await acquireCsodToken(careerUrl, { timeoutMs, userAgent });
  if (!auth) return [];

  let jobs = await searchCsodJobs(auth.cloudApiBase, auth.token, auth.cookies, {
    careerSiteId,
    cultureId,
    cultureName,
    referer,
    pageSize,
    maxPages,
    timeoutMs,
    userAgent,
  });

  if (jobs === null) {
    // Token expired mid-search — re-acquire once and retry from page 1.
    auth = await acquireCsodToken(careerUrl, { timeoutMs, userAgent });
    if (!auth) return [];
    jobs = await searchCsodJobs(auth.cloudApiBase, auth.token, auth.cookies, {
      careerSiteId,
      cultureId,
      cultureName,
      referer,
      pageSize,
      maxPages,
      timeoutMs,
      userAgent,
    });
  }

  return Array.isArray(jobs) ? jobs : [];
}
