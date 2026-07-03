#!/usr/bin/env node
/**
 * Sygnum job parser — custom Salesforce fRecruit (Visualforce) portal.
 *
 * Source: https://www.sygnum.com/working-at-sygnum-careers/ (public career
 * page; the actual listing/apply feed is a bespoke Salesforce fRecruit
 * portal below — the join.com widget referenced from marketing pages is
 * stale and shows "no positions").
 *
 * Sygnum is a Swiss digital-asset banking group headquartered in Zürich
 * (Uetlibergstrasse 134A, 8045 Zürich ZH — confirmed via LEI registry,
 * Zefix commercial register and opencorpdata, cross-checked, not a guess).
 *
 * ATS discovery: no shared ATS client in `./ats-clients/` matches — Sygnum
 * runs a self-hosted Salesforce fRecruit (Visualforce) recruiting portal at
 *   https://sygnumpeopleportal.my.salesforce-sites.com/recruit
 * The listing page is paginated via JSF-style form postbacks
 * (`jsfcljs(...)` onclick handlers on the "Next" link) that require
 * replaying the page's hidden ViewState fields + session cookie on each
 * POST. This parser owns that pagination + detail-page scraping directly
 * (no shared client applies).
 *
 * Detail pages embed a schema.org JobPosting JSON-LD block (used for
 * title/datePosted/employmentType/jobLocation) plus a stable label/value
 * HTML table (`About the role`, `Our ideal candidate`, `Our Offer`, etc.)
 * that carries the real description content — the JSON-LD `description`
 * field itself is boilerplate placeholder text and is intentionally NOT
 * used.
 *
 * Public posting URLs are
 *   https://sygnumpeopleportal.my.salesforce-sites.com/recruit/fRecruit__ApplyJob?vacancyNo={VN}
 * confirmed live/resolvable in a browser.
 *
 * Non-Swiss office postings (observed: Liechtenstein, Singapore) are
 * filtered out via the shared `isChCountry()` guard.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSygnumJobs()   — Fetch and parse all Sygnum jobs
 *   - isSygnumJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchWithRetry, RETRYABLE_STATUS } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { isChCountry } from './ch-country-guard.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * Resilient fetch wrapper: applies timeout + shared exponential-backoff
 * retry, and returns { text, setCookie } so callers can replay the
 * fRecruit portal's session cookie across the pagination/detail requests.
 */
async function fetchUrl(url, { method = 'GET', headers = {}, body } = {}) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      const text = await res.text();
      const setCookie = (res.headers.get('set-cookie') || res.headers.get('Set-Cookie') || '').split(';')[0];
      return { text, setCookie };
    } finally {
      clearTimeout(timer);
    }
  }, { label: `sygnum ${url}` });
}

/* ── Constants ─────────────────────────────────────────────── */

export const SYGNUM_KEY = 'sygnum';
export const SYGNUM_COMPANY_NAME = 'Sygnum Bank';
export const SYGNUM_COMPANY_DOMAIN = 'sygnum.com';

const PORTAL_HOST = 'sygnumpeopleportal.my.salesforce-sites.com';
const LISTING_URL = `https://${PORTAL_HOST}/recruit`;
const LISTING_POST_URL = `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJobList`;
const DETAIL_URL = (vacancyNo) => `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJob?vacancyNo=${encodeURIComponent(vacancyNo)}`;
const CAREER_URL = 'https://www.sygnum.com/working-at-sygnum-careers/';

const MAX_PAGES = 12; // safety cap; observed real max is 3 pages / 26 vacancies

/* ── HQ fallback (Uetlibergstrasse 134A, 8045 Zürich, ZH) ─────── */
/* Confirmed via LEI registry + Zefix commercial register + opencorpdata, */
/* cross-checked across independent sources — not a guess. */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8045',
  streetAddress: 'Uetlibergstrasse 134A',
  region: 'ZH',
};

const SECTOR = 'Finanza / Banche digitali';

/* ── Labels excluded from the description (boilerplate/meta, not content) */
const EXCLUDED_LABELS = new Set([
  'posting title',
  'country',
  'location city',
  'about sygnum',
  'our values',
  'employment type',
  'duration',
  'working arrangement',
]);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text = '') {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Sygnum.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSygnumJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SYGNUM_KEY ||
    key.startsWith('sygnum') ||
    company.includes('sygnum') ||
    url.includes('sygnum.com') ||
    url.includes(PORTAL_HOST)
  );
}

/**
 * Validate that a URL belongs to Sygnum's domain OR the fRecruit portal
 * host that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'sygnum.com' || host.endsWith('.sygnum.com')) return true;
    if (host === PORTAL_HOST) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(engineer|developer|devops|backend|frontend|full.?stack|tech lead|software|security|iam|platform engineering|service desk)/.test(t)) return 'IT';
  if (/\b(compliance|legal|counsel|dpo|risk)/.test(t)) return 'Legale';
  if (/\b(financ|treasury|account|wealth|relationship manager|corporate clients|custody)/.test(t)) return 'Finanza';
  if (/\b(market|communication|brand|growth)/.test(t)) return 'Marketing';
  if (/\b(hr|human|talent|recruit|people)/.test(t)) return 'Risorse Umane';
  if (/\b(sales|business.?develop)/.test(t)) return 'Commerciale';
  if (/\b(support|customer)/.test(t)) return 'Assistenza clienti';
  if (/\b(design|ux|ui)\b/.test(t)) return 'Design';
  if (/\b(product)/.test(t)) return 'IT';
  if (/\b(admin|office)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|internship|apprentice|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|principal)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map Sygnum's explicit "Employment Type" label value (from the label/value
 * table) to the schema.org enum, falling back to title-based detection when
 * the source string is missing/unrecognized.
 */
function mapEmploymentType(raw = '', title = '') {
  const r = normalize(raw);
  if (/intern/.test(r)) return 'INTERN';
  if (/part.?time/.test(r)) return 'PART_TIME';
  if (/(permanent|full.?time)/.test(r)) return 'FULL_TIME';

  const t = normalize(title);
  if (/\b(intern|internship|apprentice)/.test(t)) return 'INTERN';
  if (/\bpart.?time\b/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Address resolution (canton-gated, mirrors the fixed pattern) ──── */

/**
 * Resolve city/canton/postalCode/streetAddress for a job, gating BOTH the
 * postal code and street address on canton match with HQ — never emit HQ's
 * street address for a job located in a different canton.
 */
function resolveAddress(localityRaw = '', postalRaw = '') {
  const locality = normalizeSpace(localityRaw);
  const canton = locality ? inferSwissTargetCanton(locality) : null;

  if (locality && canton) {
    return {
      city: locality,
      canton,
      postalCode: postalRaw || (canton === HQ.canton ? HQ.postalCode : ''),
      streetAddress: canton === HQ.canton ? HQ.streetAddress : '',
      region: canton,
    };
  }

  // Unmapped/empty locality → safe HQ fallback, never dropped.
  return {
    city: HQ.city,
    canton: HQ.canton,
    postalCode: HQ.postalCode,
    streetAddress: HQ.streetAddress,
    region: HQ.region,
  };
}

/* ── Fetch: pagination (Salesforce fRecruit / Visualforce postback) ─── */

function extractHiddenFields(html = '') {
  const fields = {};
  const rx = /<input[^>]*type="hidden"[^>]*>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const tag = m[0];
    const nameMatch = tag.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const valueMatch = tag.match(/value="([^"]*)"/i);
    fields[nameMatch[1]] = valueMatch ? decodeEntities(valueMatch[1]) : '';
  }
  return fields;
}

/**
 * Extract the postback element/param pair for the "Next" page link.
 * Anchored to the literal `>Next</a>` text so it can never match the
 * "Previous"/"First"/"Last" links once multiple nav links are present.
 */
function extractNextPvp(html = '') {
  const rx = /jsfcljs\(document\.getElementById\('([^']+)'\),'([^']+)'[^"]*"[^>]*>Next<\/a>/;
  const m = rx.exec(html);
  if (!m) return null;
  return { elementId: m[1], param: m[2] };
}

function extractVacancyRows(html = '') {
  const rows = [];
  const rx = /vacancyNo=(VN\d+)"[^>]*>([^<]+)/g;
  let m;
  while ((m = rx.exec(html))) {
    rows.push({ vacancyNo: m[1], title: normalizeSpace(decodeEntities(m[2])) });
  }
  return rows;
}

async function fetchListingPages() {
  const cookieJar = { value: '' };
  const rowsByVacancy = new Map();

  let { text: html, setCookie } = await fetchUrl(LISTING_URL);
  if (setCookie) cookieJar.value = setCookie;

  for (const row of extractVacancyRows(html)) {
    rowsByVacancy.set(row.vacancyNo, row);
  }

  let page = 1;
  while (page < MAX_PAGES) {
    const pvp = extractNextPvp(html);
    if (!pvp) break;

    const hidden = extractHiddenFields(html);
    const body = new URLSearchParams({ ...hidden, [pvp.param]: pvp.elementId });

    ({ text: html, setCookie } = await fetchUrl(LISTING_POST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieJar.value,
        Referer: LISTING_URL,
      },
      body: body.toString(),
    }));
    if (setCookie) cookieJar.value = setCookie;

    const before = rowsByVacancy.size;
    for (const row of extractVacancyRows(html)) {
      rowsByVacancy.set(row.vacancyNo, row);
    }
    if (rowsByVacancy.size === before) break; // no new vacancies → stop (cycling guard)

    page += 1;
  }

  return { rows: [...rowsByVacancy.values()], cookieJar };
}

/* ── Fetch: detail page (JSON-LD + label/value table) ────────────────── */

function extractJsonLd(html = '') {
  const rx = /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/i;
  const m = rx.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractLabelFields(html = '') {
  const fields = {};
  const rx = /<th[^>]*class="labelCol[^"]*"[^>]*>\s*<label>\s*([^<]+?)\s*<\/label>\s*<\/th>\s*<td[^>]*class="data2Col[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = rx.exec(html))) {
    const label = normalizeSpace(decodeEntities(m[1]));
    fields[label] = m[2];
  }
  return fields;
}

async function fetchDetailPage(vacancyNo, cookieJar) {
  const { text: html } = await fetchUrl(DETAIL_URL(vacancyNo), {
    headers: cookieJar?.value ? { Cookie: cookieJar.value } : {},
  });

  const jsonLd = extractJsonLd(html);
  const labelFields = extractLabelFields(html);

  const descriptionParts = [];
  for (const [label, valueHtml] of Object.entries(labelFields)) {
    if (EXCLUDED_LABELS.has(normalize(label))) continue;
    const text = stripHtml(valueHtml);
    if (text) descriptionParts.push(text);
  }

  return {
    jsonLd,
    employmentTypeRaw: labelFields['Employment Type'] ? stripHtml(labelFields['Employment Type']) : '',
    description: normalizeSpace(descriptionParts.join(' ')),
  };
}

/* ── Fetch + Parse (main entry point) ─────────────────────────────── */

/**
 * Fetch all Sygnum jobs from the Salesforce fRecruit portal (listing
 * pagination + per-vacancy detail scraping). Non-CH office postings are
 * skipped. Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSygnumJobs() {
  console.log(`🔍 Fetching ${SYGNUM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Salesforce fRecruit portal "${PORTAL_HOST}")\n`);

  let rows = [];
  let cookieJar = { value: '' };
  try {
    ({ rows, cookieJar } = await fetchListingPages());
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    throw err;
  }

  if (!rows || rows.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${rows.length}`);

  const jobs = [];
  const seen = new Set();
  for (const row of rows) {
    const title = normalizeSpace(row.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = DETAIL_URL(row.vacancyNo);
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    let detail;
    try {
      detail = await fetchDetailPage(row.vacancyNo, cookieJar);
    } catch (err) {
      console.warn(`⚠️ Detail fetch failed for ${row.vacancyNo}: ${err?.message || err}`);
      continue;
    }

    const ld = detail.jsonLd || {};
    const address = ld?.jobLocation?.address || {};
    const countryRaw = address.addressCountry || '';
    if (countryRaw && !isChCountry(countryRaw)) continue; // non-CH office (e.g. Liechtenstein, Singapore)

    const localityRaw = address.addressLocality || '';
    const postalRaw = address.postalCode || '';
    const { city, canton, postalCode, streetAddress, region } = resolveAddress(localityRaw, postalRaw);
    const location = normalizeSpace(city || HQ.city);

    const descriptionText = detail.description;
    const description = descriptionText && descriptionText.length >= 80
      ? descriptionText
      : `${title} presso ${SYGNUM_COMPANY_NAME} a ${location}.`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} sygnum ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = mapEmploymentType(detail.employmentTypeRaw, title);
    const postedDate = (ld.datePosted && String(ld.datePosted).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${SYGNUM_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SYGNUM_COMPANY_NAME,
      companyKey: SYGNUM_KEY,
      companyDomain: SYGNUM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Sygnum Dedicated Parser (Salesforce fRecruit)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress: streetAddress || (canton === HQ.canton ? HQ.streetAddress : ''),
      postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: row.vacancyNo || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SYGNUM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
