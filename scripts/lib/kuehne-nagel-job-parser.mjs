#!/usr/bin/env node
/**
 * Kuehne+Nagel job parser — Phenom People ATS (tenant/refNum "KUNAGLOBAL").
 *
 * Source: https://jobs.kuehne-nagel.com/global/en/search-results
 *
 * Kuehne+Nagel is a global logistics / freight-forwarding group (Swiss HQ:
 * Schindellegi, canton Schwyz). Its careers site runs on the Phenom People
 * platform: the search results are NOT server-rendered — they're fetched
 * client-side via a CSRF-token-gated POST to `/widgets`
 * (ddoKey "eagerLoadRefineSearch") that returns the full filtered job list
 * as JSON in one request. The CSRF token + session cookies needed to
 * authorize that POST are obtained from the plain HTML of the
 * search-results page first (two-step flow — no Playwright needed, unlike
 * e.g. richemont-job-parser.mjs).
 *
 * Each job's full description + postal address are only present on the
 * individual job-detail page
 *   https://jobs.kuehne-nagel.com/global/en/job/{jobSeqNo}/{any-slug}
 * (Phenom keys the page on jobSeqNo alone — the trailing slug segment is
 * cosmetic and not validated), embedded as a schema.org JobPosting
 * `<script type="application/ld+json">` block. That page needs no cookies.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKuehneNagelJobs()  — Fetch and parse all jobs
 *   - isKuehneNagelJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - KUEHNE_NAGEL_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, fetchJson } from './crawler-template.mjs';
import { fetchWithRetry } from './transient-fetch.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KUEHNE_NAGEL_KEY = 'kuehne-nagel';
export const KUEHNE_NAGEL_COMPANY_NAME = 'Kuehne+Nagel';
export const KUEHNE_NAGEL_COMPANY_DOMAIN = 'kuehne-nagel.com';

const JOBS_HOST = 'jobs.kuehne-nagel.com';
const SEARCH_URL = `https://${JOBS_HOST}/global/en/search-results`;
const WIDGETS_URL = `https://${JOBS_HOST}/widgets`;
const CAREER_URL = `https://${JOBS_HOST}/global/en`;

const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';

/* ── HQ fallback (Schindellegi, SZ) ───────────────────────── */

const HQ = {
  city: 'Schindellegi',
  canton: 'SZ',
  postalCode: '8834',
  region: 'Schwyz',
  streetAddress: 'Dorfstrasse 50',
};

const SECTOR = 'Logistics / Freight Forwarding';
const PAGE_SIZE = 50;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kuehne+Nagel.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKuehneNagelJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KUEHNE_NAGEL_KEY ||
    key.startsWith('kuehne-nagel') ||
    company === 'kuehne+nagel' ||
    company === 'kuehne + nagel' ||
    company.startsWith('kuehne') ||
    url.includes('kuehne-nagel.com') ||
    url.includes('jobs.kuehne-nagel.com')
  );
}

/**
 * Validate that a URL belongs to Kuehne+Nagel's domain (corporate site or
 * the Phenom-hosted careers subdomain that actually serves the postings).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'kuehne-nagel.com' || host.endsWith('.kuehne-nagel.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', apiCategory = '') {
  const t = normalize(`${title} ${apiCategory}`);
  if (/\b(it\b|informatik|informatique|software|developer|engineer|wms|erp|sap)/.test(t)) return 'IT';
  if (/\b(insurance|versicherung|assurance)/.test(t)) return 'Assicurazioni';
  if (/\b(hr\b|human resources|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(customer care|kundenservice|service client|disponent|dispatcher)/.test(t)) return 'Logistica';
  if (/\b(seefracht|sea logistics|luftfracht|air logistics|road logistics|fernverkehr|transport)/.test(t)) return 'Logistica';
  if (/\b(servicetechniker|techniker|technician|maintenance)/.test(t)) return 'Tecnico';
  if (/\b(finanz|finance|financ|comptab|buchhalt)/.test(t)) return 'Finanza';
  if (/\b(vendita|sales|verkauf|commerce|business development)/.test(t)) return 'Commerciale';
  if (/\b(market|kommunik|comunicaz|communication)/.test(t)) return 'Marketing';
  return 'Logistica';
}

function detectExperienceLevel(title = '', careerLevel = '') {
  const t = normalize(`${title} ${careerLevel}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|entry)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager|teamleiter|team leader)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|permanent)/.test(t)) return 'FULL_TIME';
  if (/\b(stage|intern|stagiair|apprenti|lehrling|lernend)/.test(t)) return 'INTERN';
  if (/\b(befristet|temporary|tempor|fixed.?term|cdd)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── Search API (CSRF + cookie session) ───────────────────── */

function parseSetCookieJar(res) {
  const jar = new Map();
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const nameValue = cookie.split(';')[0];
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) jar.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
  }
  return jar;
}

/**
 * Fetch the search-results page once to obtain the CSRF token + session
 * cookies needed to authorize the `/widgets` search API POST below.
 * Returns { csrfToken, cookieHeader } or throws on failure.
 */
async function fetchSearchSession(timeoutMs) {
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${SEARCH_URL}`);
        err.status = res.status;
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      const html = await res.text();
      const jar = parseSetCookieJar(res);
      const csrfMatch = html.match(/"csrfToken":"([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';
      if (!csrfToken) throw new Error('CSRF token not found on Kuehne+Nagel search-results page');
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      return { csrfToken, cookieHeader };
    } finally {
      clearTimeout(timer);
    }
  }, { label: 'kuehne-nagel search session', timeoutMs });
}

/**
 * Fetch every Switzerland-filtered job stub from the Phenom `/widgets`
 * search API, paginating with `from`/`size` until `totalHits` reached.
 * Returns raw Phenom job objects (title, city, jobSeqNo, jobId, reqId,
 * multi_category, type, WorkType, CareerLevel, postedDate, …).
 */
async function fetchJobStubs(timeoutMs) {
  const { csrfToken, cookieHeader } = await fetchSearchSession(timeoutMs);

  const headers = {
    'x-csrf-token': csrfToken,
    Cookie: cookieHeader,
    Origin: `https://${JOBS_HOST}`,
    Referer: SEARCH_URL,
  };

  const stubs = [];
  let from = 0;
  let totalHits = Infinity;

  while (from < totalHits) {
    const body = {
      lang: 'en_global',
      deviceType: 'desktop',
      country: 'global',
      pageName: 'search-results',
      ddoKey: 'eagerLoadRefineSearch',
      sortBy: '',
      subsearch: '',
      from,
      irs: false,
      jobs: true,
      counts: true,
      all_fields: ['phLocSlider', 'country', 'state', 'city', 'category', 'CareerLevel', 'WorkType', 'type', 'remote'],
      size: PAGE_SIZE,
      clearAll: false,
      jdsource: 'facets',
      isSliderEnable: true,
      pageId: 'page3-migration-ds',
      siteType: 'external',
      keywords: '',
      global: true,
      selected_fields: { country: ['Switzerland'] },
      locationData: { sliderRadius: 0, aboveMaxRadius: true, LocationUnit: 'kilometers' },
      s: '1',
    };

    const json = await fetchJson(WIDGETS_URL, { method: 'POST', headers, body, timeoutMs, label: 'kuehne-nagel widgets search' });
    const result = json?.eagerLoadRefineSearch;
    const jobs = result?.data?.jobs || [];
    totalHits = Number(result?.totalHits) || jobs.length;

    if (jobs.length === 0) break;
    stubs.push(...jobs);
    from += jobs.length;
    if (jobs.length < PAGE_SIZE) break; // last page
  }

  return stubs;
}

/* ── Job detail page (full description + address) ─────────── */

/**
 * Fetch the job-detail page and extract the embedded schema.org JobPosting
 * JSON-LD block. Returns { descriptionHtml, postalCode, addressLocality,
 * addressCountry, cantonCode } or an empty object on parse failure —
 * callers fall back to the search-stub fields + HQ defaults.
 */
async function fetchJobDetail(jobSeqNo, title, timeoutMs) {
  const detailUrl = `${CAREER_URL}/job/${jobSeqNo}/${slugify(title, 140)}`;
  try {
    const html = await fetchHtml(detailUrl, { timeoutMs, label: 'kuehne-nagel job detail' });

    let descriptionHtml = '';
    let postalCode = '';
    let addressLocality = '';
    let addressCountry = '';
    const ldMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        descriptionHtml = ld.description || '';
        const addr = ld.jobLocation?.address || {};
        postalCode = (addr.postalCode || '').trim();
        addressLocality = (addr.addressLocality || '').trim();
        addressCountry = (addr.addressCountry || '').trim();
      } catch {
        // Malformed JSON-LD — fall through to raw-HTML regex fallback below.
      }
    }

    const stateMatch = html.match(/"standardisedStateCode":"([A-Z]{2})"/);
    const cantonCode = stateMatch ? stateMatch[1] : '';

    return { detailUrl, descriptionHtml, postalCode, addressLocality, addressCountry, cantonCode };
  } catch (err) {
    console.warn(`   ⚠️ Detail fetch failed for ${jobSeqNo}: ${err?.message || err}`);
    return { detailUrl, descriptionHtml: '', postalCode: '', addressLocality: '', addressCountry: '', cantonCode: '' };
  }
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Kuehne+Nagel jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKuehneNagelJobs() {
  console.log(`🔍 Fetching Kuehne+Nagel jobs`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  let stubs;
  try {
    stubs = await fetchJobStubs(timeoutMs);
  } catch (err) {
    console.warn(`⚠️ Kuehne+Nagel search fetch failed: ${err?.message || err}`);
    throw err;
  }

  if (!stubs || stubs.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${stubs.length}`);

  const jobs = [];
  const seen = new Set();
  for (const stub of stubs) {
    const title = normalizeSpace(stub.title || '');
    if (!title || title.length < 3) continue;

    const jobSeqNo = stub.jobSeqNo || '';
    if (!jobSeqNo) continue;

    const detail = await fetchJobDetail(jobSeqNo, title, timeoutMs);
    const publicUrl = detail.detailUrl;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const city = normalizeSpace(stub.city || detail.addressLocality || HQ.city);
    const canton =
      (detail.cantonCode && detail.cantonCode.length === 2 ? detail.cantonCode : '') ||
      inferSwissTargetCanton(city) ||
      inferSwissTargetCanton(stub.location || '') ||
      HQ.canton;

    const descriptionHtml = detail.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml) || normalizeSpace(stub.descriptionTeaser || '');
    const description = descriptionText || `${title} at ${KUEHNE_NAGEL_COMPANY_NAME} in ${city}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} kuehne nagel ${city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const apiCategory = Array.isArray(stub.multi_category) ? stub.multi_category[0] : (stub.category || '');
    const employmentLabel = `${stub.type || ''} ${stub.WorkType || ''}`;
    const employmentType = detectEmploymentType(employmentLabel);
    const postedDate = (stub.postedDate && String(stub.postedDate).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const isHqCity = /schindellegi/i.test(city);
    const postalCode = detail.postalCode || (isHqCity ? HQ.postalCode : '');
    const streetAddress = isHqCity ? HQ.streetAddress : '';

    const job = {
      // ── Required fields ──
      id: `${KUEHNE_NAGEL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KUEHNE_NAGEL_COMPANY_NAME,
      companyKey: KUEHNE_NAGEL_KEY,
      companyDomain: KUEHNE_NAGEL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Kuehne+Nagel Dedicated Parser (Phenom People)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      postalCode,
      streetAddress,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, apiCategory),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title, stub.CareerLevel || ''),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: stub.reqId || stub.jobId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${KUEHNE_NAGEL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
