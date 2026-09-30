/**
 * The job posting behind an assisted-application order, as the AI draft sees it.
 *
 * The order only stores jobId/jobUrl/company/title. The full posting is the
 * published per-job detail file (`/data/job-detail/{id}.json`, the same file
 * the SPA lazy-loads), read over HTTP like every other site consumer; the
 * employer page is a fallback for postings that left the dataset.
 *
 * `classifyApplicationChannel` tells the operator HOW the application goes
 * out: an e-mail address the posting itself publishes, or the ATS portal
 * behind the apply link (Workday, SuccessFactors, Umantis…), which decides
 * whether the form needs an account and which quirks to expect.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const JOB_DETAIL_BASE = 'https://cdn.frontaliereticino.ch/data/job-detail';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_POSTING_CHARS = 14_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const JOB_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Only public https hosts: the fallback must never reach internal addresses. */
export function isFetchablePublicUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') || isIP(host)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)
    && !host.endsWith('.goog')
    && host !== 'metadata.google.internal';
}

/** True for loopback, private, link-local, CGNAT and unique-local addresses. */
export function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(value);
  }
  return true;
}

/** The URL is public https AND every address its host resolves to is public. */
export async function resolvesToPublicHost(value, resolve = lookup) {
  if (!isFetchablePublicUrl(value)) return false;
  try {
    const addresses = await resolve(new URL(value).hostname, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchWithTimeout(fetchImpl, url, init = {}) {
  return fetchImpl(url, {
    redirect: 'follow',
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'FrontaliereTicino-AssistedApplication/1.0', ...(init.headers || {}) },
  });
}

/**
 * GET an employer page (the order's jobUrl comes from the browser at
 * checkout): redirects are followed by hand and every hop is re-validated.
 */
async function fetchPublicPage(fetchImpl, startUrl, resolve) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!(await resolvesToPublicHost(url, resolve))) return null;
    const response = await fetchWithTimeout(fetchImpl, url, { redirect: 'manual', headers: { Accept: 'text/html' } });
    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    return response;
  }
  return null;
}

function salaryText(baseSalary) {
  const value = baseSalary?.value;
  if (!value || typeof value !== 'object') return '';
  const min = Number(value.minValue);
  const max = Number(value.maxValue);
  const unit = clean(value.unitText, 20);
  const currency = clean(baseSalary.currency, 5);
  if (Number.isFinite(min) && Number.isFinite(max)) return `${currency} ${min}–${max} / ${unit}`.trim();
  if (Number.isFinite(min)) return `${currency} ${min} / ${unit}`.trim();
  return '';
}

function postingFromDetail(detail) {
  const description = String(detail?.description || '').trim();
  const requirements = Array.isArray(detail?.requirements) ? detail.requirements.map((item) => clean(item, 400)).filter(Boolean) : [];
  const text = [description, requirements.length ? requirements.map((item) => `- ${item}`).join('\n') : '']
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_POSTING_CHARS);
  return {
    text,
    applyUrl: clean(detail?.applyUrl, 1000),
    titles: detail?.titleByLocale && typeof detail.titleByLocale === 'object' ? detail.titleByLocale : {},
    location: clean([detail?.addressLocality, detail?.addressRegion].filter(Boolean).join(', '), 200),
    postalCode: clean(detail?.postalCode, 20),
    streetAddress: clean(detail?.streetAddress, 200),
    contactPerson: clean(detail?.contactPerson, 200),
    contactPhone: clean(detail?.contactPhone, 60),
    salary: salaryText(detail?.baseSalary),
    employmentType: clean(detail?.employmentType, 40),
  };
}

/**
 * @returns {Promise<{source:'job_detail'|'job_page'|'none', text:string, applyUrl:string, titles:object,
 *   location:string, postalCode:string, streetAddress:string, contactPerson:string, contactPhone:string,
 *   salary:string, employmentType:string}>}
 */
export async function fetchJobPosting(order, { fetchImpl = fetch, resolve = lookup } = {}) {
  const empty = {
    source: 'none', text: '', applyUrl: clean(order?.jobUrl, 1000), titles: {}, location: '', postalCode: '',
    streetAddress: '', contactPerson: '', contactPhone: '', salary: '', employmentType: '',
  };
  const jobId = String(order?.jobId || '');
  if (JOB_ID_RE.test(jobId)) {
    try {
      const response = await fetchWithTimeout(fetchImpl, `${JOB_DETAIL_BASE}/${encodeURIComponent(jobId)}.json`);
      if (response.ok) {
        const posting = postingFromDetail(await response.json());
        if (posting.text) {
          return { ...empty, ...posting, applyUrl: posting.applyUrl || empty.applyUrl, source: 'job_detail' };
        }
      }
    } catch (error) {
      console.warn('[assistedApplicationAi] job detail fetch failed', jobId, error instanceof Error ? error.message : String(error));
    }
  }

  if (isFetchablePublicUrl(order?.jobUrl)) {
    try {
      const response = await fetchPublicPage(fetchImpl, order.jobUrl, resolve);
      const contentType = String(response?.headers?.get?.('content-type') || '');
      if (response?.ok && contentType.includes('html')) {
        const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
        const text = htmlToText(html).slice(0, MAX_POSTING_CHARS);
        if (text.length > 200) return { ...empty, text, source: 'job_page' };
      }
    } catch (error) {
      console.warn('[assistedApplicationAi] job page fetch failed', error instanceof Error ? error.message : String(error));
    }
  }
  return empty;
}

// ── Channel ────────────────────────────────────────────────────────────────

const PORTALS = [
  { id: 'workday', label: 'Workday', re: /(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|workday\.com)$/, account: true },
  { id: 'successfactors', label: 'SAP SuccessFactors', re: /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu)|jobs\.sap\.com)$/, account: true },
  { id: 'umantis', label: 'Abacus Umantis', re: /(^|\.)umantis\.com$/, account: false },
  { id: 'refline', label: 'Refline', re: /(^|\.)refline\.ch$/, account: false },
  { id: 'smartrecruiters', label: 'SmartRecruiters', re: /(^|\.)smartrecruiters\.com$/, account: false },
  { id: 'lever', label: 'Lever', re: /(^|\.)lever\.co$/, account: false },
  { id: 'greenhouse', label: 'Greenhouse', re: /(^|\.)greenhouse\.io$/, account: false },
  { id: 'personio', label: 'Personio', re: /(^|\.)personio\.(de|com)$/, account: false },
  { id: 'softgarden', label: 'softgarden', re: /(^|\.)softgarden\.(io|de)$/, account: false },
  { id: 'jobs_ch', label: 'jobs.ch / jobup.ch', re: /(^|\.)(jobs\.ch|jobup\.ch)$/, account: false },
  { id: 'linkedin', label: 'LinkedIn', re: /(^|\.)linkedin\.com$/, account: true },
];

const EMAIL_ONLY_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function isPlausibleEmail(value) {
  return EMAIL_ONLY_RE.test(String(value || '').trim()) && String(value).length <= 254;
}

/**
 * @param {{applyUrl?:string, postingText?:string, applicationEmail?:string}} input
 *   `applicationEmail` must already be verified to appear in the posting text.
 */
export function classifyApplicationChannel({ applyUrl = '', postingText = '', applicationEmail = '' } = {}) {
  const url = String(applyUrl || '').trim();
  if (/^mailto:/i.test(url)) {
    const address = decodeURIComponent(url.replace(/^mailto:/i, '').split('?')[0]).trim();
    if (isPlausibleEmail(address)) return { type: 'email', label: 'E-mail', email: address.toLowerCase(), applyUrl: '', host: '', requiresAccount: false };
  }
  const email = isPlausibleEmail(applicationEmail) && String(postingText).toLowerCase().includes(applicationEmail.toLowerCase())
    ? applicationEmail.trim().toLowerCase()
    : '';
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const portal = host ? PORTALS.find((candidate) => candidate.re.test(host)) : null;
  if (email) {
    return {
      type: 'email', label: 'E-mail', email, applyUrl: url, host,
      requiresAccount: false, portal: portal ? portal.id : null,
    };
  }
  if (portal) return { type: portal.id, label: portal.label, email: '', applyUrl: url, host, requiresAccount: portal.account };
  if (host) return { type: 'employer_site', label: 'Sito del datore', email: '', applyUrl: url, host, requiresAccount: false };
  return { type: 'unknown', label: 'Sconosciuto', email: '', applyUrl: '', host: '', requiresAccount: false };
}
