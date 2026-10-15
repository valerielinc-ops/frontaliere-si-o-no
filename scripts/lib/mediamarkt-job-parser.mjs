#!/usr/bin/env node
/**
 * MediaMarkt Switzerland job parser.
 *
 * The public MediaMarkt career page is a SuccessFactors Career Site Builder
 * SPA. Its HTML contains the shell only; the page loads the actual postings
 * from the public Azure Search index below. Querying that same source keeps
 * descriptions, addresses, publication dates and job IDs authoritative
 * without requiring a headless browser in the scheduled crawler.
 */
import { createHash } from 'node:crypto';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { resolveSwissPostalCodePlace } from './swiss-locality-directory.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MEDIAMARKT_KEY = 'mediamarkt';
export const MEDIAMARKT_COMPANY_NAME = 'MediaMarkt';
export const MEDIAMARKT_COMPANY_DOMAIN = 'mediamarkt.ch';

const CAREER_HOST = 'careers.mediamarktsaturn.com';
const CAREER_URL = 'https://careers.mediamarktsaturn.com/MediaMarktCH/?locale=de_CH&currentPage=1&pageSize=100&addresses%2Fcountry=CHE&orderBy=datePosted&isDesc=true';
const SEARCH_API_URL = 'https://searchui.search.windows.net/indexes/mms-prod/docs/search?api-version=2020-06-30';
// Publishable browser key: the MediaMarkt SPA ships this value in its public
// client bundle. It is a query key, not a credential for private data.
const SEARCH_API_KEY = '6BBD74F1CBD41E5B0232FB05C5B78ED9';
const SEARCH_PAGE_SIZE = 100;
const SEARCH_FILTER = "addresses/any(jt: jt/country eq 'CHE') and language eq 'de_CH'";
const SEARCH_FIELDS = 'jobId,title,description';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SECTOR = 'Commercio al dettaglio / Elettronica';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function localeToLang(locale = '') {
  const lang = String(locale || '').slice(0, 2).toLowerCase();
  return ['de', 'fr', 'it', 'en'].includes(lang) ? lang : 'de';
}

/**
 * Preserve headings and list items from the source HTML. The API's
 * `description` field contains the authored vacancy body, not just a teaser.
 */
export function htmlToMarkdown(html = '') {
  let value = String(html || '');
  value = value.replace(/<\s*(h[1-6])[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi,
    (_match, _tag, inner) => `\n\n## ${stripHtml(inner).trim()}\n`);
  value = value.replace(/<\s*li[^>]*>([\s\S]*?)<\/\s*li\s*>/gi,
    (_match, inner) => `\n- ${stripHtml(inner).trim()}`);
  value = value.replace(/<\s*\/?\s*(p|div|ul|ol|section|article)[^>]*>/gi, '\n');
  value = value.replace(/<\s*br\s*\/?>/gi, '\n');
  value = stripHtml(value)
    .replace(/&#13;/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return value;
}

function detectCategory(title = '', businessArea = '') {
  const t = normalize(`${title} ${businessArea}`);
  if (/\b(logist|lager|warehouse|logistics|warenannahme)/.test(t)) return 'Logistica';
  if (/\b(vendita|verkauf|sales|commerce|retail|kasse|kundendienst|store|markt)/.test(t)) return 'Commerciale';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  return 'Altro';
}

function detectExperienceLevel(title = '', careerLevel = '') {
  const t = normalize(`${title} ${careerLevel}`);
  if (/\b(praktik|praktikum|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(value = '') {
  const t = normalize(value);
  if (/\b(part[ -]?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full[ -]?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

function isSwissAddress(address = {}) {
  const country = normalize(address.country || address.countryCode || '');
  return country === 'ch' || country === 'che'
    || /^(schweiz|switzerland|suisse|svizzera)$/.test(country);
}

function primarySwissAddress(record = {}) {
  const addresses = Array.isArray(record.addresses) ? record.addresses : [];
  return addresses.find((address) => address?.isPrimary && isSwissAddress(address))
    || addresses.find(isSwissAddress)
    || addresses.find((address) => address?.isPrimary)
    || addresses[0]
    || {};
}

/* ── Company matchers ──────────────────────────────────────── */

export function isMediamarktJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return key === MEDIAMARKT_KEY
    || key.startsWith('mediamarkt-')
    || company.includes('mediamarkt')
    || url.includes('mediamarkt.ch')
    || url.includes('mediamarktsaturn.com');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === MEDIAMARKT_COMPANY_DOMAIN
      || host.endsWith(`.${MEDIAMARKT_COMPANY_DOMAIN}`)
      || host === CAREER_HOST
      || host.endsWith('.mediamarktsaturn.com');
  } catch {
    return false;
  }
}

/* ── MediaMarkt Azure Search client ────────────────────────── */

async function callSearchApi(body, { retries = 3 } = {}) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(SEARCH_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json;charset=UTF-8',
          'api-key': SEARCH_API_KEY,
          Referer: CAREER_URL,
          'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT
            || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from MediaMarkt search API`);
      }
      const data = await response.json();
      if (!Array.isArray(data?.value)) {
        throw new Error('MediaMarkt search API returned no value array');
      }
      return data;
    } catch (error) {
      lastError = error;
      const status = Number(error?.message?.match(/HTTP (\d+)/)?.[1] || 0);
      if (attempt >= retries || (status && !RETRYABLE_STATUS.has(status))) throw error;
      const baseMs = Number(process.env.JOBS_CRAWLER_RETRY_BASE_MS ?? 1000);
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

async function fetchSwissRecords() {
  const records = [];
  let skip = 0;
  let total = Infinity;

  for (let page = 0; page < 50 && skip < total; page += 1) {
    const data = await callSearchApi({
      count: true,
      filter: `${SEARCH_FILTER} and datePosted lt ${new Date().toISOString()}`,
      orderby: 'datePosted desc',
      search: '*',
      searchFields: SEARCH_FIELDS,
      skip,
      top: SEARCH_PAGE_SIZE,
    });
    if (page === 0) total = Number(data?.['@odata.count'] ?? 0);
    const pageRecords = data.value;
    if (pageRecords.length === 0) break;
    records.push(...pageRecords);
    skip += pageRecords.length;
    if (records.length >= total) break;
  }
  return records;
}

/* ── Public parser ─────────────────────────────────────────── */

export async function fetchAllMediamarktJobs() {
  console.log('🔍 Fetching MediaMarkt Switzerland jobs');
  console.log(`   Source: MediaMarkt Azure Search (${CAREER_HOST})\n`);

  const records = await fetchSwissRecords();
  console.log(`  📋 Swiss job records returned: ${records.length}`);

  const jobs = [];
  const seenIds = new Set();
  for (const record of records) {
    const internalId = String(record?.jobId || '').split('-')[0].trim();
    const title = normalizeSpace(record?.title || '');
    if (!internalId || seenIds.has(internalId) || title.length < 3) continue;

    const address = primarySwissAddress(record);
    const sourceCity = normalizeSpace(address.city || '');
    const postalCode = normalizeSpace(address.postalCode || address.zipCode || address.zip || '');
    const postalPlace = resolveSwissPostalCodePlace(postalCode);
    const location = normalizeSpace(sourceCity || postalPlace?.locality || address.name || '');
    const canton = postalPlace?.canton || inferSwissTargetCanton(`${location} ${postalCode}`.trim());
    if (!location || !canton) {
      console.warn(`  ⚠️ Skipping MediaMarkt job without a Swiss canton: ${title} (${location || 'unknown'})`);
      continue;
    }

    const description = htmlToMarkdown(record?.description || '');
    if (description.length < 30) continue;

    const publicUrl = /^https?:\/\//i.test(String(record?.link || ''))
      ? String(record.link)
      : `https://${CAREER_HOST}/job-invite/${encodeURIComponent(internalId)}/?locale=de_CH`;
    if (!isTrustedDomain(publicUrl)) continue;
    seenIds.add(internalId);

    const sourceLang = localeToLang(record?.language || record?.defaultLocale || 'de_CH');
    const jobSlug = slugify(`${title} mediamarkt ${location} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const descriptionByLocale = { [sourceLang]: description };
    const titleByLocale = { [sourceLang]: title };
    const employmentType = detectEmploymentType(record?.employmentType || title);
    const postingDates = sourcePostingDateFields(record?.datePosted);

    jobs.push({
      id: `mediamarkt-${internalId || urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MEDIAMARKT_COMPANY_NAME,
      companyKey: MEDIAMARKT_KEY,
      companyDomain: MEDIAMARKT_COMPANY_DOMAIN,
      title,
      titleByLocale,
      description,
      descriptionByLocale,
      location,
      canton,
      url: publicUrl,
      source: 'MediaMarkt Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      postalCode: postalCode || undefined,
      streetAddress: normalizeSpace(address.street || address.streetAddress || ''),
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, record?.businessArea || record?.category || ''),
      department: normalizeSpace(record?.businessArea || ''),
      contract: employmentType === 'PART_TIME'
        ? 'part-time'
        : employmentType === 'FULL_TIME' ? 'full-time' : 'other',
      employmentType,
      experienceLevel: detectExperienceLevel(title, record?.careerLevel || ''),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      ...postingDates,
      applyUrl: publicUrl,
      legalEntity: normalizeSpace(record?.legalEntity || '') || undefined,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total MediaMarkt (CH) jobs discovered: ${jobs.length}`);
  return jobs;
}
