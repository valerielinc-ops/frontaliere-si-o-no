#!/usr/bin/env node
/**
 * SuccessFactors ATS client — shared abstraction for SAP SuccessFactors career sites.
 *
 *   careerUrl  ─►  detectSuccessFactorsKind  ─►  'odata-api' │ 'html-career' │ 'html-jobreq' │ null
 *                                                       │
 *                  ┌────────────────────────────────────┼────────────────────────────────────┐
 *                  ▼                                    ▼                                    ▼
 *      buildSuccessFactorsApiUrl                 fetchHtmlCareer                    fetchHtmlJobReq
 *      ( OData v2 — needs auth )                 ( career5.successfactors.eu )      ( /sfcareer/jobreqcareer SPA )
 *                  │                                    │                                    │
 *                  ▼                                    ▼                                    ▼
 *      GET /odata/v2/JobRequisitionLocale         server-rendered HTML detail        SPA — Playwright required
 *                  │                                    │                                    │
 *                  └────────────────────────────────────┴────────────────────────────────────┘
 *                                                       ▼
 *                                       extractSuccessFactorsJobIdentity
 *                                                       ▼
 *                                              NormalizedJob
 *
 * Background — the 10 in-tree SF parsers split into THREE flavors:
 *
 *   1. **odata-api** —  api{N}.successfactors.com/odata/v2/JobRequisitionLocale
 *      Used by tenants that exposed (or proxied) their requisition feed. Requires
 *      Basic / OAuth-Bearer auth. No live in-tree consumer hits this directly today
 *      (most parsers gave up and used HTML). Documented for future migrations.
 *
 *   2. **html-career** — career5.successfactors.eu/career?company={tenant}&...
 *      Detail pages are server-rendered HTML; listing index is JS. Examples in repo:
 *      Giorgio Armani (`company=3397177P`), ALDI Suisse (`company=aldisuis`),
 *      Alpiq apply links (`company=Alpiq`), Bundesamt apply links (`company=bundesamtf`).
 *      Title format on detail page: `<title>Career Opportunities: {Title} ({reqId})</title>`
 *      Requisition input: `<input id="career_job_req_id" value="...">`.
 *
 *   3. **html-jobreq** — careers.{tenant}.com/Switzerland/job/... or
 *      careers.{tenant}.com/sfcareer/jobreqcareer (jobs2web-style overlay).
 *      Heineken Switzerland uses this (`/Switzerland/job/{slug}/{id}/`),
 *      SBB uses a thin SSR wrapper (`jobs.sbb.ch/v2/offene-stellen/{slug}/{uuid}`)
 *      with JSON-LD JobPosting + structured HTML sections.
 *      Mobiliar (`jobs.mobiliar.ch`) uses a sitemap-driven variant.
 *      Oerlikon uses Career Site Builder (`careers.oerlikon.com`) with an
 *      `/api/apply/v2/jobs` JSON sidecar.
 *
 * SPA-only fallbacks (Benteler `career.benteler.com`, Alpiq listing index):
 *   The listing page is fully JS-rendered with no server HTML. This client returns
 *   `null` (or yields nothing) for those — consumers MUST switch to
 *   `scripts/lib/ats-clients/playwright-runtime.mjs` for headless rendering.
 *
 * Public API:
 *   - {@link detectSuccessFactorsKind}
 *   - {@link buildSuccessFactorsApiUrl}
 *   - {@link fetchSuccessFactorsJobs}        (AsyncIterable<NormalizedJob>)
 *   - {@link parseSuccessFactorsPostedDate}
 *   - {@link extractSuccessFactorsJobIdentity}
 *   - {@link SuccessFactorsApiError}
 *   - {@link SuccessFactorsAuthError}
 *
 * This module is the thin transport + shape layer. Per-company concerns
 * (canton inference, sector tagging, employment-type heuristics, fallback prose,
 * AI-localization wiring) stay in the per-company parser.
 *
 * Existing in-tree consumers (NOT modified by this file):
 *   - scripts/lib/agroscope-job-parser.mjs        (Prospective.ch + SF apply links)
 *   - scripts/lib/aldi-suisse-job-parser.mjs      (career5 + jobs.aldi.ch SSR)
 *   - scripts/lib/alpiq-job-parser.mjs            (career5 apply + alpiq.com listing)
 *   - scripts/lib/benteler-job-parser.mjs         (SPA — Playwright)
 *   - scripts/lib/giorgio-armani-job-parser.mjs   (career5 detail HTML)
 *   - scripts/lib/heineken-ch-job-parser.mjs      (jobs2web search + detail)
 *   - scripts/lib/interdiscount-job-parser.mjs    (Prospective.ch + SF apply links)
 *   - scripts/lib/jumbo-job-parser.mjs            (Prospective.ch + SF apply links)
 *   - scripts/lib/mobiliar-job-parser.mjs         (sitemap + SSR detail)
 *   - scripts/lib/oerlikon-job-parser.mjs         (CSB + /api/apply/v2/jobs)
 *   - scripts/lib/prada-job-parser.mjs            (career5 detail HTML)
 *   - scripts/lib/rapelli-job-parser.mjs          (career5 detail HTML)
 *   - scripts/lib/sbb-job-parser.mjs              (SSR + JSON-LD)
 */

/* ── Errors ────────────────────────────────────────────────────────────── */

/**
 * Thrown when SF (any flavor) returns a non-2xx after retries, or when the
 * payload cannot be parsed.
 */
export class SuccessFactorsApiError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode HTTP status, or 0 for network/abort errors.
   * @param {object} [meta] Optional structured context (url, kind, body…).
   */
  constructor(message, statusCode = 0, meta = {}) {
    super(message);
    this.name = 'SuccessFactorsApiError';
    this.statusCode = statusCode;
    this.meta = meta;
  }
}

/**
 * Thrown for 401/403 — typically means missing OData credentials or anti-bot
 * fencing. Callers should back off and retry from a different runner.
 */
export class SuccessFactorsAuthError extends SuccessFactorsApiError {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {object} [meta]
   */
  constructor(message, statusCode, meta = {}) {
    super(message, statusCode, meta);
    this.name = 'SuccessFactorsAuthError';
  }
}

/* ── Constants ─────────────────────────────────────────────────────────── */

const DEFAULT_USER_AGENT = 'FrontaliereTicino-Bot/1.0';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_DELAY_MS = 2_000;
const DEFAULT_PAGE_SIZE = 100;

/** Hosts unambiguously belonging to SAP SuccessFactors. */
const SF_HOSTS = [
  'successfactors.eu',
  'successfactors.com',
  'sapsf.eu',
  'sapsf.com',
];

/* ── Detection ─────────────────────────────────────────────────────────── */

/**
 * Identify which SuccessFactors flavor a given career-site URL uses.
 *
 * @param {string} url Career-site URL (listing or detail).
 * @returns {'odata-api' | 'html-career' | 'html-jobreq' | null}
 *   - `'odata-api'`     OData v2 endpoint (api{N}.successfactors.com/odata/v2/...)
 *   - `'html-career'`   Server-rendered career5 / careerN page (`/career?company=...`)
 *   - `'html-jobreq'`   jobs2web / jobreqcareer-style SSR (e.g. `/sfcareer/jobreqcareer`,
 *                       `/Switzerland/job/...`, jobs.sbb.ch)
 *   - `null`            Not recognisable as SuccessFactors.
 */
export function detectSuccessFactorsKind(url) {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();

  // OData API: api{N}.successfactors.com/odata/v2/...
  if (/^api\d*\.successfactors\./.test(host) && path.startsWith('/odata/')) {
    return 'odata-api';
  }

  // career5/careerN.successfactors.eu/career?company=...
  // Also matches Bundesamt-style career74.sapsf.eu/career?company=...
  if (
    SF_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) &&
    (path === '/career' || path === '/careers' || path.startsWith('/career'))
  ) {
    if (/[?&]company=/i.test(search) || /[?&]career_job_req_id=/i.test(search)) {
      return 'html-career';
    }
    return 'html-career';
  }

  // jobs2web / SSR overlay paths
  if (/\/sfcareer\/jobreqcareer/i.test(path)) return 'html-jobreq';
  if (/\/talentcommunity\/apply\//i.test(path)) return 'html-jobreq';
  if (/\/(?:switzerland|schweiz|suisse|svizzera)\/job\//i.test(path)) {
    return 'html-jobreq';
  }
  // SBB-style: jobs.sbb.ch/v2/offene-stellen/{slug}/{uuid}
  if (host === 'jobs.sbb.ch' && /\/offene-stellen\//i.test(path)) {
    return 'html-jobreq';
  }
  // Heineken jobs2web: careers.theheinekencompany.com/.../search or /job/
  if (host.endsWith('theheinekencompany.com') && /\/(search|job)\b/i.test(path)) {
    return 'html-jobreq';
  }
  // Mobiliar SSR (uses SuccessFactors backend, plain /job/{slug}/{id}/ URLs)
  if (host === 'jobs.mobiliar.ch' && /\/job\/[^/]+\/\d+\/?$/i.test(path)) {
    return 'html-jobreq';
  }
  // Oerlikon CSB overlay
  if (host === 'careers.oerlikon.com') return 'html-jobreq';
  // HOCH Health Ostschweiz (KSSG group) — SF Career Site Builder
  if (host === 'jobs.h-och.ch') return 'html-jobreq';

  return null;
}

/* ── URL builder ───────────────────────────────────────────────────────── */

/**
 * Build a SuccessFactors API or career URL for a given tenant.
 *
 * @param {string} tenant
 *   For `'odata-api'`: SF subdomain prefix without the leading `api`
 *   (e.g. `'4'` → `api4.successfactors.com`) or a full host.
 *   For `'html-career'`: company code (e.g. `'aldisuis'`, `'3397177P'`,
 *   `'Alpiq'`, `'bundesamtf'`).
 * @param {'odata-api' | 'html-career' | 'html-jobreq'} kind
 * @param {object} [options]
 * @param {string} [options.host='career5.successfactors.eu']
 *   Host override for `'html-career'` (some tenants live on careerN.* with N≠5).
 * @param {string} [options.lang='en_GB']
 *   `selected_lang` query for `'html-career'` detail URLs.
 * @param {string} [options.jobReqId]
 *   When present, builds a detail-page URL (career detail / OData entity).
 * @param {object} [options.filters]
 *   Extra OData `$filter` predicates for `'odata-api'`. Joined with ` and `.
 * @param {number} [options.top=DEFAULT_PAGE_SIZE]
 * @param {number} [options.skip=0]
 * @param {string} [options.path]
 *   Required for `'html-jobreq'` (e.g. `'/Switzerland/search'`).
 *   The full URL is `https://{tenant}{path}` and `tenant` MUST be the host.
 * @returns {string}
 * @throws {TypeError} If parameters don't match the requested `kind`.
 */
export function buildSuccessFactorsApiUrl(tenant, kind, options = {}) {
  if (!tenant || typeof tenant !== 'string') {
    throw new TypeError('buildSuccessFactorsApiUrl: tenant must be a non-empty string');
  }
  if (!kind) throw new TypeError('buildSuccessFactorsApiUrl: kind is required');

  const t = tenant.trim();

  if (kind === 'odata-api') {
    const host = /successfactors\.com$/i.test(t)
      ? t
      : `api${t || '4'}.successfactors.com`;
    const top = Number.isFinite(options.top) ? options.top : DEFAULT_PAGE_SIZE;
    const skip = Number.isFinite(options.skip) ? options.skip : 0;
    if (options.jobReqId) {
      const safe = encodeURIComponent(String(options.jobReqId));
      return `https://${host}/odata/v2/JobRequisitionLocale('${safe}')?$format=json`;
    }
    const params = new URLSearchParams();
    params.set('$top', String(top));
    params.set('$skip', String(skip));
    params.set('$format', 'json');
    if (options.filters) {
      const list = Array.isArray(options.filters)
        ? options.filters
        : [options.filters];
      const joined = list.filter(Boolean).join(' and ');
      if (joined) params.set('$filter', joined);
    }
    return `https://${host}/odata/v2/JobRequisitionLocale?${params.toString()}`;
  }

  if (kind === 'html-career') {
    const host = options.host || 'career5.successfactors.eu';
    const lang = options.lang || 'en_GB';
    const company = encodeURIComponent(t);
    if (options.jobReqId) {
      const reqId = encodeURIComponent(String(options.jobReqId));
      return `https://${host}/career?career_ns=job_listing&company=${company}&navBarLevel=JOB_SEARCH&career_job_req_id=${reqId}&selected_lang=${lang}`;
    }
    return `https://${host}/career?company=${company}&career_ns=job_listing&navBarLevel=JOB_SEARCH&selected_lang=${lang}`;
  }

  if (kind === 'html-jobreq') {
    const host = t.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const path = options.path || '/';
    return `https://${host}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  throw new TypeError(`buildSuccessFactorsApiUrl: unknown kind '${kind}'`);
}

/* ── Date parser ───────────────────────────────────────────────────────── */

/**
 * Parse a posted-date value that came from any SuccessFactors flavor.
 * Accepts:
 *   - ISO 8601               → returned as-is (truncated to date)
 *   - `'DD.MM.YYYY'`         (German/French career sites — Heineken/SBB-IT)
 *   - `'DD/MM/YYYY'`
 *   - `'/Date(1234567890000)/'` (OData JSON serialization)
 *   - Unix epoch ms / s as number or numeric string
 *
 * @param {string|number} rawDate
 * @returns {string|null} ISO date `YYYY-MM-DD` or `null` on failure.
 */
export function parseSuccessFactorsPostedDate(rawDate) {
  if (rawDate == null) return null;

  // Numeric epoch
  if (typeof rawDate === 'number' && Number.isFinite(rawDate)) {
    const ms = rawDate < 1e12 ? rawDate * 1000 : rawDate;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const raw = String(rawDate).trim();
  if (!raw) return null;

  // /Date(1234567890000)/
  const odata = raw.match(/^\/Date\((-?\d+)\)\/?$/);
  if (odata) {
    const ms = Number(odata[1]);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
  }

  // Numeric string
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  // DD.MM.YYYY or DD/MM/YYYY
  const dotted = raw.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (dotted) {
    return `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`;
  }

  // ISO-ish — let Date deal with it
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* ── Identity extractor ────────────────────────────────────────────────── */

/**
 * @typedef {Object} SuccessFactorsJobIdentity
 * @property {string}      jobReqId   SF requisition ID (string).
 * @property {string}      slug       Kebab-case slug derived from title.
 * @property {string}      title      Whitespace-normalized title.
 * @property {string}      location   First location string available.
 * @property {string}      company    Company display name (passed by caller, fallback to tenant).
 * @property {string|null} postedAt   ISO date or null.
 * @property {string}      applyUrl   Best-effort apply URL.
 */

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Pull the canonical identity fields out of a raw job object (any flavor).
 * Inputs accepted:
 *   - OData entity     ({ jobReqId, jobTitle, location, postingStartDate, applyUrl, … })
 *   - jobs2web row     ({ title, url, jobId, postedDate, location, … })
 *   - HTML-career parse ({ title, reqId, area, country, applyHref, … })
 *
 * @param {object} rawJob
 * @param {object} [options]
 * @param {string} [options.company]  Company display name (e.g. 'ALDI Suisse').
 * @param {string} [options.tenant]   SF tenant code, used when `company` absent.
 * @returns {SuccessFactorsJobIdentity}
 */
export function extractSuccessFactorsJobIdentity(rawJob = {}, options = {}) {
  const r = rawJob || {};
  const jobReqId = String(
    r.jobReqId ??
      r.reqId ??
      r.career_job_req_id ??
      r.jobId ??
      r.id ??
      r.requisitionId ??
      ''
  ).trim();

  const title = normalizeSpace(
    r.title || r.jobTitle || r.name || r.requisitionTitle || ''
  );

  const location = normalizeSpace(
    r.location ||
      r.locationName ||
      r.city ||
      r.country ||
      r.area ||
      ''
  );

  const postedRaw =
    r.postedAt ||
    r.postedDate ||
    r.postingStartDate ||
    r.datePosted ||
    r.postedOn ||
    r.start_date ||
    null;
  const postedAt = postedRaw ? parseSuccessFactorsPostedDate(postedRaw) : null;

  const applyUrl =
    r.applyUrl ||
    r.applyHref ||
    r.url ||
    r.directLink ||
    r.link ||
    '';

  const company = options.company || r.company || options.tenant || '';
  const slug = slugify(`${title} ${company} ${location}`);

  // Description body — currently only populated for html-career detail
  // pages (via parseHtmlCareerDetail). OData / html-jobreq flavors leave
  // it empty and downstream parsers fall back to title + brand blurb.
  const descriptionHtml = String(
    r.descriptionHtml || r.jobDescription || r.description || ''
  );

  return {
    jobReqId,
    slug,
    title,
    location,
    company,
    postedAt,
    applyUrl: String(applyUrl || ''),
    descriptionHtml,
  };
}

/* ── HTTP helpers ──────────────────────────────────────────────────────── */

async function fetchOnce(url, { timeoutMs, userAgent, accept, authHeader } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent || DEFAULT_USER_AGENT,
        Accept: accept || 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      throw new SuccessFactorsAuthError(
        `SuccessFactors auth failure: HTTP ${res.status}`,
        res.status,
        { url }
      );
    }
    if (!res.ok) {
      throw new SuccessFactorsApiError(
        `SuccessFactors HTTP ${res.status} for ${url}`,
        res.status,
        { url }
      );
    }
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof SuccessFactorsApiError) throw err;
    throw new SuccessFactorsApiError(
      `SuccessFactors network error: ${err?.message || err}`,
      0,
      { url, cause: String(err?.message || err) }
    );
  }
}

/* ── Fetcher ───────────────────────────────────────────────────────────── */

/**
 * Auto-detect the SF flavor for a career URL, then dispatch to the right
 * fetch path. Yields {@link SuccessFactorsJobIdentity}-shaped jobs.
 *
 * For SPA-only flavors that this client cannot scrape (e.g. Benteler career
 * page, Alpiq listing index, Workday-styled SF builds), the iterator yields
 * nothing and emits a console warning telling the caller to use
 * `playwright-runtime.mjs` instead. Detail-page fetching after Playwright
 * extracts the URLs CAN re-enter this client.
 *
 * @param {string} careerUrl The career site URL (listing or seed).
 * @param {object} [options]
 * @param {string[]} [options.locationFilters=[]] Substrings (case-insensitive)
 *   to filter the `location` field. Empty = no filter.
 * @param {string}   [options.userAgent='FrontaliereTicino-Bot/1.0']
 * @param {number}   [options.minDelayMs=2000]   Polite delay between requests.
 * @param {number}   [options.timeoutMs=20000]
 * @param {number}   [options.maxPages=10]       Pagination cap (OData / search).
 * @param {string}   [options.tenant]            Override autodetected tenant.
 * @param {string}   [options.company]           Display company name to attach.
 * @param {string}   [options.authHeader]        Bearer/Basic auth for OData.
 * @param {string}   [options.lang='en_GB']
 * @returns {AsyncGenerator<SuccessFactorsJobIdentity, void, unknown>}
 *
 * @example
 *   for await (const job of fetchSuccessFactorsJobs(
 *     'https://career5.successfactors.eu/career?company=aldisuis',
 *     { locationFilters: ['Ticino', 'Lugano'], company: 'ALDI Suisse' }
 *   )) {
 *     console.log(job.title, job.location);
 *   }
 */
export async function* fetchSuccessFactorsJobs(careerUrl, options = {}) {
  const {
    locationFilters = [],
    userAgent = DEFAULT_USER_AGENT,
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxPages = 10,
    tenant: tenantOverride,
    company,
    authHeader,
    lang = 'en_GB',
  } = options;

  const kind = detectSuccessFactorsKind(careerUrl);
  if (!kind) {
    console.warn(
      `[successfactors-client] URL not recognised as SuccessFactors: ${careerUrl}`
    );
    return;
  }

  const filters = locationFilters
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  const matchesLocation = (loc) =>
    filters.length === 0 ||
    filters.some((f) => String(loc || '').toLowerCase().includes(f));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (kind === 'odata-api') {
    const tenant = tenantOverride || extractTenantFromHost(careerUrl);
    let skip = 0;
    for (let page = 0; page < maxPages; page++) {
      const url = buildSuccessFactorsApiUrl(tenant, 'odata-api', {
        top: DEFAULT_PAGE_SIZE,
        skip,
      });
      const res = await fetchOnce(url, {
        timeoutMs,
        userAgent,
        accept: 'application/json',
        authHeader,
      });
      let body;
      try {
        body = await res.json();
      } catch (err) {
        throw new SuccessFactorsApiError(
          `Failed to parse OData JSON: ${err?.message || err}`,
          res.status,
          { url }
        );
      }
      const items =
        body?.d?.results ||
        body?.value ||
        (Array.isArray(body) ? body : []) ||
        [];
      if (!items.length) break;
      for (const raw of items) {
        const job = extractSuccessFactorsJobIdentity(raw, { company, tenant });
        if (matchesLocation(job.location)) yield job;
      }
      if (items.length < DEFAULT_PAGE_SIZE) break;
      skip += DEFAULT_PAGE_SIZE;
      await sleep(minDelayMs);
    }
    return;
  }

  if (kind === 'html-career') {
    // Server-rendered detail pages are scrapable; the listing index is a SPA.
    // We can fetch a single detail URL (when career_job_req_id is in the URL)
    // but full discovery requires Playwright.
    const parsed = new URL(careerUrl);
    const reqId = parsed.searchParams.get('career_job_req_id');
    if (!reqId) {
      console.warn(
        `[successfactors-client] html-career listing index requires Playwright. ` +
        `Pass a detail URL (with career_job_req_id) or use playwright-runtime.mjs. ` +
        `Seen: ${careerUrl}`
      );
      return;
    }
    const res = await fetchOnce(careerUrl, {
      timeoutMs,
      userAgent,
      accept: 'text/html,application/xhtml+xml',
    });
    const html = await res.text();
    const raw = parseHtmlCareerDetail(html);
    if (!raw) return;
    const tenant = tenantOverride || parsed.searchParams.get('company') || '';
    const job = extractSuccessFactorsJobIdentity(
      { ...raw, applyUrl: careerUrl },
      { company, tenant }
    );
    if (matchesLocation(job.location)) yield job;
    return;
  }

  if (kind === 'html-jobreq') {
    // jobs2web-style search is server-rendered (Heineken, Mobiliar via sitemap).
    // SBB v2 detail pages have JSON-LD. The listing index for jobreqcareer
    // is a SPA — we accept a single page and parse what we can.
    const res = await fetchOnce(careerUrl, {
      timeoutMs,
      userAgent,
      accept: 'text/html,application/xhtml+xml',
    });
    const html = await res.text();
    const ldJob = extractJsonLdJobPosting(html);
    if (ldJob) {
      const job = extractSuccessFactorsJobIdentity(ldJob, { company });
      if (matchesLocation(job.location)) yield job;
      return;
    }
    const rows = parseJobs2WebSearchRows(html, careerUrl);
    for (const row of rows) {
      const job = extractSuccessFactorsJobIdentity(row, { company });
      if (matchesLocation(job.location)) yield job;
    }
    return;
  }
}

/* ── Internal HTML helpers ─────────────────────────────────────────────── */

function extractTenantFromHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const m = host.match(/^api(\d+)\./);
    return m ? m[1] : host;
  } catch {
    return '';
  }
}

/**
 * Parse a `career5.successfactors.eu/career?...&career_job_req_id=...`
 * server-rendered detail page. Mirrors the field set used by Giorgio Armani
 * and Prada parsers (the canonical html-career consumers).
 *
 * Description body lives under `<div class="joqReqDescription">` (note the
 * SAP-side typo `joqReq` — keep verbatim). The block is several KB of
 * HTML and is the field downstream parsers expose via `descriptionHtml`.
 *
 * @param {string} html
 * @returns {{title: string, reqId: string, area: string, country: string, descriptionHtml: string} | null}
 */
function parseHtmlCareerDetail(html = '') {
  if (!html) return null;
  const titleMatch =
    html.match(/<title>Career Opportunities:\s*(.+?)\s*\((\d+)\)\s*<\/title>/i);
  const title = titleMatch ? normalizeSpace(stripTags(titleMatch[1])) : '';
  const reqId = titleMatch ? titleMatch[2] : '';
  // Metadata: <b>{reqId}</b><b /><b>{AREA}</b><b>{COUNTRY}</b>
  const meta = html.match(
    /Requisition ID[^<]*<b>\d+<\/b>[\s\S]{0,200}?<b[^>]*>[^<]*<\/b>[\s\S]{0,200}?<b>([^<]+)<\/b>[^<]*<b>([^<]+)<\/b>/i
  );
  const area = meta ? normalizeSpace(meta[1]) : '';
  const country = meta ? normalizeSpace(meta[2]) : '';
  if (!title && !reqId) return null;

  // Job description body — SAP uses class="joqReqDescription" (sic). We
  // pull from its opening tag until the next closing </td> or </tr>
  // because the div is unbalanced w.r.t. surrounding table cells in some
  // tenants (Pictet ships nested <div>s inside the description that throw
  // a naive .*?</div> non-greedy match off by ~10KB).
  let descriptionHtml = '';
  const descAnchor = html.search(/<div[^>]*class="[^"]*joqReqDescription[^"]*"/i);
  if (descAnchor !== -1) {
    const slice = html.slice(descAnchor);
    const endMarker = slice.search(/<\/td>|<\/tr>|<div[^>]*class="[^"]*(?:apply|jobApply|formButtonBar)/i);
    descriptionHtml = endMarker !== -1 ? slice.slice(0, endMarker) : slice.slice(0, 20000);
  }

  return { title, reqId, area, country, location: country || area, descriptionHtml };
}

/**
 * Extract the schema.org/JobPosting JSON-LD node from an SF SSR page (SBB-style).
 * @param {string} html
 * @returns {object|null}
 */
function extractJsonLdJobPosting(html = '') {
  const scripts = [
    ...String(html || '').matchAll(
      /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  for (const m of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(String(m[1] || '').trim());
    } catch {
      continue;
    }
    const nodes = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((n) => {
      if (!n || typeof n !== 'object') return [];
      if (Array.isArray(n['@graph'])) return n['@graph'];
      return [n];
    });
    for (const n of nodes) {
      const t = n?.['@type'];
      const isJob = Array.isArray(t)
        ? t.some((x) => String(x || '').toLowerCase() === 'jobposting')
        : String(t || '').toLowerCase() === 'jobposting';
      if (!isJob) continue;
      const loc = n.jobLocation;
      const locName =
        (Array.isArray(loc) ? loc[0]?.address : loc?.address)?.addressLocality ||
        n.locationName ||
        '';
      return {
        title: n.title || n.name || '',
        jobReqId: n.identifier?.value || n.identifier || '',
        location: locName,
        postedAt: n.datePosted || null,
        applyUrl: n.url || n.applyUrl || '',
      };
    }
  }
  return null;
}

/**
 * Parse a jobs2web / SF search-results table.
 * Each row contains: Title (link to /Switzerland/job/{slug}/{id}/) | Department
 * | Location | Date.
 *
 * @param {string} html
 * @param {string} pageUrl Used to resolve relative links.
 * @returns {Array<{title:string, url:string, jobId:string, location:string, postedAt:string|null}>}
 */
function parseJobs2WebSearchRows(html = '', pageUrl = '') {
  if (!html) return [];
  const rows = [];
  const seen = new Set();
  let base = '';
  try {
    base = new URL(pageUrl).origin;
  } catch {
    base = '';
  }
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const rowHtml = rm[1];
    const link = rowHtml.match(/<a[^>]+href="([^"]*\/job\/[^"]+\/(\d+)\/?)"/i);
    if (!link) continue;
    const url = link[1].startsWith('http')
      ? link[1].replace(/&amp;/g, '&')
      : `${base}${link[1].replace(/&amp;/g, '&')}`;
    const jobId = link[2];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(rowHtml)) !== null) {
      cells.push(normalizeSpace(stripTags(cm[1])));
    }
    const titleA = rowHtml.match(/<a[^>]+href="[^"]*\/job\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleA
      ? normalizeSpace(stripTags(titleA[1])).replace(
          /^(?:Title|Titre|Bezeichnung|Titolo|Titulo)\s*:\s*/i,
          ''
        )
      : cells[0] || '';
    if (!title || title.length < 3) continue;
    rows.push({
      title,
      url,
      jobId,
      location: cells[2] || '',
      postedAt: parseSuccessFactorsPostedDate(cells[3] || ''),
    });
  }
  return rows;
}

function stripTags(s = '') {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
