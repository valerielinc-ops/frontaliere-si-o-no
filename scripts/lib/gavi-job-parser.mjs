#!/usr/bin/env node
/**
 * Gavi, the Vaccine Alliance job parser — custom Salesforce fRecruit
 * (Visualforce) recruiting portal.
 *
 * Source: https://www.gavi.org/about-us/work-us/vacancies (public career
 * page; the "Search & Apply" link on that page points at the actual
 * listing/apply feed below).
 *
 * Gavi is an international public-private global health partnership
 * headquartered in Geneva, Switzerland: Global Health Campus, Chemin du
 * Pommier 40, 1218 Le Grand-Saconnex GE (confirmed live via
 * https://www.gavi.org/contact-us "Mailing and visiting address"; also has
 * a Washington DC liaison office, which is why the Swiss-office filter
 * below matters — not a guess).
 *
 * ATS discovery: no shared ATS client in `./ats-clients/` matches — Gavi
 * runs the same self-hosted Salesforce fRecruit (Visualforce) recruiting
 * portal family as Sygnum (see `sygnum-job-parser.mjs`), at
 *   https://fs-2662.my.salesforce-sites.com/recruit
 * confirmed live via curl (2 open vacancies as of this writing, both
 * "Geneva"). The listing table differs from Sygnum's in one way: it
 * exposes a "Location" column directly (Vacancy No / Job Title / Location /
 * Close Date), so this parser can filter on that column instead of relying
 * solely on JSON-LD address fields (which are unpopulated placeholders on
 * Gavi's detail pages — see below). No "Next" pagination link was observed
 * (single page, 2 rows), but the same jsfcljs-postback pagination handling
 * as Sygnum is kept for when the vacancy count grows past one page.
 *
 * Detail pages embed a schema.org JobPosting JSON-LD block, but unlike
 * Sygnum's it is entirely placeholder/empty (empty jobLocation.address,
 * empty hiringOrganization.name, bogus currency "AFN", employmentType set
 * to a tenure string like "Gavi 5-years") — none of it is usable. The real
 * content lives in the same stable label/value HTML table
 * (`Location`, `Team`, `Reporting to`, `Job Description`, ...) that Sygnum
 * uses, with the rich "Job Description" field containing the full role
 * write-up (position title / contract / location / department / About the
 * Role / Key Responsibilities / etc.).
 *
 * Public posting URLs are
 *   https://fs-2662.my.salesforce-sites.com/recruit/fRecruit__ApplyJob?vacancyNo={VN}&portal=Global
 * confirmed live/resolvable in a browser.
 *
 * Only genuinely Swiss-based postings are ingested: the listing's
 * "Location" column value is resolved through `inferSwissTargetCanton()`
 * and postings that don't map to a Swiss canton (e.g. a future Washington
 * DC liaison-office vacancy) are skipped — mirroring the CERN/Sygnum
 * international-org pattern in this repo (CERN filters via SmartRecruiters
 * `locationCountryCodes: ['ch']`; Sygnum via the `isChCountry()` guard on
 * the JSON-LD country field). Gavi's JSON-LD has no country field at all,
 * so the canton-inference gate on the Location column is the equivalent
 * guard here.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGaviJobs()      — Fetch and parse all Gavi jobs
 *   - isGaviJob()             — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchWithRetry, RETRYABLE_STATUS } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * Resilient fetch wrapper: applies a timeout + the shared exponential-backoff
 * retry, and returns { text, setCookie } so callers can replay the fRecruit
 * portal's session cookie across the pagination/detail requests.
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
  }, { label: `gavi ${url}` });
}

/* ── Constants ─────────────────────────────────────────────── */

export const GAVI_KEY = 'gavi';
export const GAVI_COMPANY_NAME = 'Gavi, the Vaccine Alliance';
export const GAVI_COMPANY_DOMAIN = 'gavi.org';

const PORTAL_HOST = 'fs-2662.my.salesforce-sites.com';
const LISTING_URL = `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJobList?portal=Global`;
const LISTING_POST_URL = `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJobList`;
const DETAIL_URL = (vacancyNo) => `https://${PORTAL_HOST}/recruit/fRecruit__ApplyJob?vacancyNo=${encodeURIComponent(vacancyNo)}&portal=Global`;
const CAREER_URL = 'https://www.gavi.org/about-us/work-us/vacancies';

const MAX_PAGES = 12; // safety cap; only 1 page / 2 vacancies observed live

/* ── HQ fallback (Global Health Campus, Chemin du Pommier 40, 1218 Le Grand-Saconnex, GE) */
/* Confirmed live via https://www.gavi.org/contact-us "Mailing and visiting */
/* address" — not a guess. */

const HQ = {
  city: 'Le Grand-Saconnex',
  canton: 'GE',
  postalCode: '1218',
  streetAddress: 'Chemin du Pommier 40',
  region: 'GE',
};

const SECTOR = 'Salute globale / Organizzazioni internazionali';

/* ── Labels excluded from the description (boilerplate/meta, not content) */
const EXCLUDED_LABELS = new Set([
  'vacancy no',
  'job title',
  'location',
  'team',
  'reporting to',
  'career step level',
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
 * Check if a job belongs to Gavi.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGaviJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GAVI_KEY ||
    key.startsWith('gavi') ||
    company.includes('gavi') ||
    url.includes('gavi.org') ||
    url.includes(PORTAL_HOST)
  );
}

/**
 * Validate that a URL belongs to Gavi's domain OR the fRecruit portal
 * host that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'gavi.org' || host.endsWith('.gavi.org')) return true;
    if (host === PORTAL_HOST) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(legal|counsel|compliance|ethics|risk|governance)/.test(t)) return 'Legale';
  if (/\b(financ|treasury|account|invest|audit)/.test(t)) return 'Finanza';
  if (/\b(health|vaccin|immuniz|medical|clinic|epidemio)/.test(t)) return 'Sanità';
  if (/\b(market|communication|brand|advocacy)/.test(t)) return 'Marketing';
  if (/\b(hr|human|talent|recruit|people)/.test(t)) return 'Risorse Umane';
  if (/\b(it|software|develop|programm|data|digital)/.test(t)) return 'IT';
  if (/\b(partner|resource mobiliz|donor|policy)/.test(t)) return 'Relazioni Istituzionali';
  if (/\b(admin|office|executive assistant)/.test(t)) return 'Amministrazione';
  if (/\b(supply chain|logist|procurement)/.test(t)) return 'Logistica';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|internship|apprentice|trainee|fellow)/.test(t)) return 'intern';
  if (/\b(junior|jr|associate)/.test(t)) return 'junior';
  if (/\b(chief|director|head|senior|sr|lead|principal|general counsel|vice.?president|deputy)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map a free-text "Contract type / duration" line from the Job Description
 * field to the schema.org enum, falling back to title-based detection when
 * the source string is missing/unrecognized. Gavi roles are typically
 * fixed-duration contracts (e.g. "5 year contract defined duration"), which
 * are still full-time engagements unless "part-time" is explicit.
 */
function mapEmploymentType(raw = '', title = '') {
  const r = normalize(raw);
  if (/intern/.test(r)) return 'INTERN';
  if (/part.?time/.test(r)) return 'PART_TIME';
  if (/(permanent|full.?time|defined duration|fixed.?term|contract)/.test(r)) return 'FULL_TIME';

  const t = normalize(title);
  if (/\b(intern|internship|apprentice)/.test(t)) return 'INTERN';
  if (/\bpart.?time\b/.test(t)) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Address resolution (canton-gated) ────────────────────────────── */

/**
 * Resolve city/canton/postalCode/streetAddress for a job from the listing's
 * "Location" column text. Returns null when the location does not map to a
 * Swiss canton (used upstream to skip non-Swiss postings, e.g. a future
 * Washington DC liaison-office vacancy — Gavi is not a Switzerland-only
 * employer).
 */
function resolveAddress(localityRaw = '') {
  const locality = normalizeSpace(localityRaw);
  if (!locality) return null;

  const canton = inferSwissTargetCanton(locality);
  if (!canton) return null;

  const isHqCity = /gen[eè]ve|geneva|grand.?saconnex/i.test(locality);
  return {
    city: isHqCity ? HQ.city : locality,
    canton,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
    region: canton,
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

/**
 * Extract {vacancyNo, title, location} rows from a listing page. Gavi's
 * table has 4 columns (Vacancy No / Job Title link / Location / Close
 * Date) — this regex walks the "Job Title" anchor and the immediately
 * following "Location" cell text together so each row keeps its location.
 */
function extractVacancyRows(html = '') {
  const rows = [];
  const rx = /vacancyNo=(VN\d+)(?:&amp;portal=Global)?"[^>]*>([^<]+)<\/a><\/span><\/td><td[^>]*><span[^>]*><span[^>]*>([^<]*)<\/span>/g;
  let m;
  while ((m = rx.exec(html))) {
    rows.push({
      vacancyNo: m[1],
      title: normalizeSpace(decodeEntities(m[2])),
      location: normalizeSpace(decodeEntities(m[3])),
    });
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

/* ── Fetch: detail page (JSON-LD datePosted + label/value table) ─────── */

/**
 * Gavi's detail-page JSON-LD is mostly unusable placeholder data (empty
 * jobLocation.address, empty hiringOrganization.name, bogus baseSalary
 * currency "AFN", employmentType set to a tenure string like
 * "Gavi 5-years") — none of that is used. `datePosted` (and `validThrough`)
 * are the exception: both carry real, live values, so this parser reads
 * `datePosted` from JSON-LD only, and takes everything else (location,
 * description, contract type) from the label/value table like Sygnum does.
 */
function extractJsonLdDatePosted(html = '') {
  const rx = /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/i;
  const m = rx.exec(html);
  if (!m) return '';
  try {
    const ld = JSON.parse(m[1]);
    return ld?.datePosted ? String(ld.datePosted).slice(0, 10) : '';
  } catch {
    return '';
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

/** Pull the "Contract type / duration:" line out of the rich "Job Description" field. */
function extractContractLine(descriptionHtml = '') {
  const m = /Contract type\s*\/\s*duration:?<\/strong>\s*([^<]+)/i.exec(descriptionHtml);
  return m ? normalizeSpace(decodeEntities(m[1])) : '';
}

async function fetchDetailPage(vacancyNo, cookieJar) {
  const { text: html } = await fetchUrl(DETAIL_URL(vacancyNo), {
    headers: cookieJar?.value ? { Cookie: cookieJar.value } : {},
  });

  const labelFields = extractLabelFields(html);
  const jobDescriptionHtml = labelFields['Job Description'] || '';

  const descriptionParts = [];
  for (const [label, valueHtml] of Object.entries(labelFields)) {
    if (EXCLUDED_LABELS.has(normalize(label))) continue;
    const text = stripHtml(valueHtml);
    if (text) descriptionParts.push(text);
  }

  return {
    datePosted: extractJsonLdDatePosted(html),
    contractRaw: extractContractLine(jobDescriptionHtml),
    location: labelFields['Location'] ? stripHtml(labelFields['Location']) : '',
    description: normalizeSpace(descriptionParts.join(' ')),
  };
}

/* ── Fetch + Parse (main entry point) ─────────────────────────────── */

/**
 * Fetch all Gavi jobs from the Salesforce fRecruit portal (listing
 * pagination + per-vacancy detail scraping). Only postings whose listed
 * "Location" resolves to a Swiss canton are kept (Gavi also runs a
 * Washington DC liaison office). Returns an array of ParsedJob objects
 * (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGaviJobs() {
  console.log(`🔍 Fetching ${GAVI_COMPANY_NAME} jobs`);
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

    const localityRaw = detail.location || row.location || '';
    const address = resolveAddress(localityRaw);
    if (!address) {
      console.log(`  ⏭️  Skipping non-Swiss posting "${title}" (location: "${localityRaw || 'unknown'}")`);
      continue; // non-CH office (e.g. Washington DC liaison office) or unmapped location
    }
    const { city, canton, postalCode, streetAddress, region } = address;
    const location = normalizeSpace(city || HQ.city);

    const descriptionText = detail.description;
    const description = descriptionText && descriptionText.length >= 80
      ? descriptionText
      : `${title} presso ${GAVI_COMPANY_NAME} a ${location}.`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} gavi ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = mapEmploymentType(detail.contractRaw, title);
    const postedDate = detail.datePosted || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${GAVI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GAVI_COMPANY_NAME,
      companyKey: GAVI_KEY,
      companyDomain: GAVI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Gavi Dedicated Parser (Salesforce fRecruit)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
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

  console.log(`\n📋 Total ${GAVI_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
