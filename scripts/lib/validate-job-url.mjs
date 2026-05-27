#!/usr/bin/env node
/**
 * Shared Job URL Validation
 *
 * Validates whether a job listing URL is still live and accepting applications.
 * Used by:
 *   - shared-jobs-crawler.mjs (publish-time validation)
 *   - cleanup-jobs.mjs (housekeeping)
 *   - Dedicated crawlers (update-*-jobs.mjs)
 *
 * Design: fail-open. Network errors, auth walls, rate limits,
 * and ambiguous responses are treated as "valid" to avoid false positives.
 */

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// Fresh protection: jobs crawled within this many hours are never removed
const DEFAULT_FRESH_PROTECTION_HOURS = 72;

// ── Strong "job closed" phrases ───────────────────────────────────────────────
// A match on any of these in the response body = strong unavailable signal.

const STRONG_PHRASES = [
  // English
  'no longer accepting applications',
  'this job is no longer available',
  'job is no longer available',
  'position has been filled',
  'this position is no longer accepting applications',
  'this position has been closed',
  'this job has been closed',
  'this position is no longer available',
  'this role has been filled',
  'the vacancy has been filled',
  'vacancy is no longer available',
  'expired job listing',
  'this posting has expired',
  'this job posting is no longer active',
  'job posting is no longer active',
  'sorry, this position is no longer open',
  // Italian
  'questa posizione non è più disponibile',
  'questa offerta non è più disponibile',
  'la posizione è stata coperta',
  'posizione non più disponibile',
  'offerta scaduta',
  'offerta non più attiva',
  'annuncio scaduto',
  'il posto è stato occupato',
  'candidatura chiusa',
  'annuncio non più disponibile',
  // German
  'diese stelle ist nicht mehr verfügbar',
  'diese position ist nicht mehr verfügbar',
  'diese stelle wurde besetzt',
  'stellenangebot nicht mehr verfügbar',
  'stelle nicht mehr offen',
  'bewerbung geschlossen',
  // French
  'cette offre n\'est plus disponible',
  'ce poste n\'est plus disponible',
  'cette position a été pourvue',
  'offre expirée',
  'poste pourvu',
].map((s) => s.toLowerCase());

// ── Career portal redirect patterns ──────────────────────────────────────────
// If a job URL redirects to a generic careers/listing page, the position is gone.

const GENERIC_LANDING_PATTERNS = [
  /\/careers\/?$/i,
  /\/jobs\/?$/i,
  /\/vacanc(ies|y)\/?$/i,
  /\/offerte-di-lavoro\/?$/i,
  /\/posti-vacanti\/?$/i,
  /\/stellenangebote\/?$/i,
  /\/offres-emploi\/?$/i,
  /\/open-positions\/?$/i,
  /\/join-us\/?$/i,
  /\/work-with-us\/?$/i,
  /\/lavora-con-noi\/?$/i,
  // SuccessFactors / SAP generic results page
  /\/career\?.*company=/i,
  /\/career\/?#?\s*$/i,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract LinkedIn job ID from a URL.
 */
function extractLinkedInJobId(url) {
  if (!url) return null;
  const m1 = url.match(/-(\d+)(?:\?|$)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]currentJobId=(\d+)/);
  if (m2) return m2[1];
  const m3 = url.match(/\/jobs\/view\/(\d+)/);
  if (m3) return m3[1];
  return null;
}

/**
 * Convert LinkedIn URL to guest API endpoint (avoids auth wall).
 */
function toLinkedInGuestEndpoint(url) {
  const jobId = extractLinkedInJobId(url);
  if (!jobId) return null;
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
}

/**
 * Heuristic: does the HTML look like an auth/login wall?
 * Requires ≥2 signals to be confident (bare 'login' is too common).
 */
function looksLikeAuthWall(htmlLower) {
  const signals = [
    htmlLower.includes('authwall'),
    /join now.*sign in|sign in.*join now/i.test(htmlLower),
    htmlLower.includes('join linkedin'),
    htmlLower.includes('session_password'),
    htmlLower.includes('uas/login-submit'),
  ];
  return signals.filter(Boolean).length >= 2;
}

/**
 * Does the final URL (after redirects) look like a generic careers landing page?
 * If the original URL was a specific job detail page and we ended up on a generic
 * listing, the job is gone.
 */
function isGenericLandingPage(originalUrl, finalUrl) {
  if (!originalUrl || !finalUrl) return false;
  // Only trigger if the URL actually changed (redirect happened)
  try {
    const orig = new URL(originalUrl);
    const fin = new URL(finalUrl);
    // Same exact path → no redirect to generic page
    if (orig.pathname === fin.pathname) return false;
    // Check if final URL matches a generic landing pattern
    for (const pattern of GENERIC_LANDING_PATTERNS) {
      if (pattern.test(fin.pathname + fin.search)) return true;
    }
    // Redirect to root of a careers/jobs subdomain (e.g., careers.company.com/)
    if (fin.pathname === '/' && /^(careers|jobs|job|carriere|karriere|recruiting)\./i.test(fin.hostname)) {
      return true;
    }
    // Redirect to an explicit error page (e.g., /errorpage/?errortype=404)
    if (/errorpage|error-page|page-not-found|not-found/i.test(fin.pathname)) {
      return true;
    }
    // Redirect to a generic portal/listing page (e.g., zohorecruit portal.html)
    if (/\/portal\.html?$/i.test(fin.pathname)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Check response body for SuccessFactors/SAP-specific "position closed" signals.
 * These portals often return 200 but show "no results" or redirect to listing.
 */
function hasSuccessFactorsClosedSignal(htmlLower, url) {
  if (!url) return false;
  const isSuccessFactors =
    /successfactors|coopjobs\.ch|fust\.ch|jobs\.sbb\.ch/i.test(url);
  if (!isSuccessFactors) return false;
  // SuccessFactors: empty result set or "0 risultati"
  const closedSignals = [
    '0 risultati',
    '0 results',
    '0 ergebnisse',
    '0 résultats',
    'nessun risultato trovato',
    'no results found',
    'keine ergebnisse',
    'aucun résultat',
  ];
  return closedSignals.some((s) => htmlLower.includes(s));
}

/**
 * Check response body for Workday-specific closure signals.
 */
function hasWorkdayClosedSignal(htmlLower, url) {
  if (!url) return false;
  if (!/workday|myworkdayjobs/i.test(url)) return false;
  return (
    htmlLower.includes('this position is no longer available') ||
    htmlLower.includes('invalid job id') ||
    htmlLower.includes('the job you are looking for is no longer available')
  );
}

/**
 * Check response body for Umantis-specific closure signals.
 */
function hasUmantisClosedSignal(htmlLower, url) {
  if (!url) return false;
  if (!/umantis/i.test(url)) return false;
  return (
    htmlLower.includes('dieses inserat ist nicht mehr aktiv') ||
    htmlLower.includes('this job is no longer active') ||
    htmlLower.includes('questa offerta non è più attiva')
  );
}

/**
 * Check for Swiss canton (ti.ch) closed concorso signals.
 */
function hasTiChClosedSignal(htmlLower, url) {
  if (!url) return false;
  if (!/concorsi\.ti\.ch/i.test(url)) return false;
  return (
    htmlLower.includes('concorso chiuso') ||
    htmlLower.includes('concorso scaduto') ||
    htmlLower.includes('termine di inoltro scaduto')
  );
}

// ── Core validation ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {string} [id]       - Job ID (passed through)
 * @property {boolean} valid     - true = job is live (or unknown); false = strong dead signal
 * @property {number} [status]   - HTTP status code
 * @property {string} reason     - Machine-readable reason
 */

/**
 * Validate a single job URL.
 *
 * @param {string} url           - The URL to check
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]    - Request timeout
 * @param {string} [options.userAgent]    - User-Agent header
 * @param {string} [options.id]           - Pass-through job ID for result
 * @returns {Promise<ValidationResult>}
 */
export async function validateJobUrl(url, { timeoutMs, userAgent, id } = {}) {
  if (!url) return { id, valid: true, reason: 'no-url' };

  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const ua = userAgent || DEFAULT_USER_AGENT;

  // LinkedIn: use guest endpoint to bypass auth wall
  const isLinkedIn = /linkedin\.com/i.test(url);
  const guest = isLinkedIn ? toLinkedInGuestEndpoint(url) : null;
  const targetUrl = guest || url;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': ua,
      },
    });

    // Strong HTTP-level signal: 404 / 410 — definitive, bypasses fresh protection
    if (res.status === 404 || res.status === 410) {
      return { id, valid: false, status: res.status, reason: `http-${res.status}`, definitive: true };
    }

    // Rate limit / auth block: fail-open (never delete)
    if (res.status === 429 || res.status === 403 || res.status === 999) {
      return { id, valid: true, status: res.status, reason: `blocked-${res.status}` };
    }

    // Other error codes: fail-open
    if (res.status < 200 || res.status >= 400) {
      return { id, valid: true, status: res.status, reason: `nonfatal-${res.status}` };
    }

    // Check for redirect to generic landing page
    const finalUrl = res.url || targetUrl;
    if (isGenericLandingPage(url, finalUrl)) {
      return { id, valid: false, status: res.status, reason: 'redirect-to-generic-listing', definitive: true };
    }

    // Read body for content-level signals
    const text = await res.text();
    const htmlLower = text.slice(0, 300_000).toLowerCase();

    // Strong "job closed" phrases — definitive, bypasses fresh protection
    for (const phrase of STRONG_PHRASES) {
      if (htmlLower.includes(phrase)) {
        return { id, valid: false, status: res.status, reason: `phrase:${phrase}`, definitive: true };
      }
    }

    // Portal-specific signals — definitive, bypasses fresh protection
    if (hasSuccessFactorsClosedSignal(htmlLower, url)) {
      return { id, valid: false, status: res.status, reason: 'portal:successfactors-closed', definitive: true };
    }
    if (hasWorkdayClosedSignal(htmlLower, url)) {
      return { id, valid: false, status: res.status, reason: 'portal:workday-closed', definitive: true };
    }
    if (hasUmantisClosedSignal(htmlLower, url)) {
      return { id, valid: false, status: res.status, reason: 'portal:umantis-closed', definitive: true };
    }
    if (hasTiChClosedSignal(htmlLower, url)) {
      return { id, valid: false, status: res.status, reason: 'portal:tich-closed', definitive: true };
    }

    // Auth wall (LinkedIn etc.): fail-open
    if (looksLikeAuthWall(htmlLower)) {
      return { id, valid: true, status: res.status, reason: 'authwall' };
    }

    return { id, valid: true, status: res.status, reason: 'ok' };
  } catch (err) {
    // Fail-open on network/timeout errors
    return { id, valid: true, status: 0, reason: 'network-error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if a job is fresh-protected (crawled/posted recently).
 * Fresh jobs are never removed by housekeeping even if URL check fails —
 * gives the career portal time to propagate the listing.
 *
 * @param {Object} job
 * @param {number} [freshHours]
 * @returns {boolean}
 */
export function isFreshProtected(job, freshHours) {
  const hours = freshHours || DEFAULT_FRESH_PROTECTION_HOURS;
  const raw = job?.crawledAt || job?.postedDate || '';
  const ts = Date.parse(String(raw));
  if (!Number.isFinite(ts)) return false;
  const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
  if (ageHours < 0) return true; // future date = definitely fresh
  return ageHours <= hours;
}

/**
 * Validate multiple job URLs with concurrency control.
 *
 * @param {Array<{id: string, url: string}>} jobs - Array of {id, url} objects
 * @param {Object} [options]
 * @param {number} [options.concurrency]   - Max parallel requests
 * @param {number} [options.timeoutMs]     - Per-request timeout
 * @param {string} [options.userAgent]     - User-Agent header
 * @returns {Promise<ValidationResult[]>}
 */
export async function validateJobUrls(jobs, { concurrency, timeoutMs, userAgent } = {}) {
  const maxConcurrency = concurrency || DEFAULT_CONCURRENCY;
  const results = [];
  let index = 0;

  async function runner() {
    while (index < jobs.length) {
      const currentIndex = index++;
      const job = jobs[currentIndex];
      // eslint-disable-next-line no-await-in-loop
      results[currentIndex] = await validateJobUrl(job.url, {
        timeoutMs,
        userAgent,
        id: job.id,
      });
    }
  }

  const runners = Array.from(
    { length: Math.min(maxConcurrency, jobs.length) },
    () => runner()
  );
  await Promise.all(runners);
  return results;
}

// Re-export defaults for consumers
export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_FRESH_PROTECTION_HOURS,
  STRONG_PHRASES,
};
