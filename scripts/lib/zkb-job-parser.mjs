#!/usr/bin/env node
/**
 * Zürcher Kantonalbank job parser — SAP SuccessFactors NES portal.
 *
 * ZKB moved its public vacancies from the retired Refline tenant 792841 to
 * the official SuccessFactors portal at jobs.zkb.ch. The portal's search
 * page is an application shell; its own listing request is the recruiting
 * JSON endpoint below. Detail pages use the NES token layout shared with
 * the Post.ch crawlers, so the source body is read from the official detail
 * page rather than reconstructed from an API card.
 */
import { createHash } from 'node:crypto';
import { fetchJson, slugify } from './crawler-template.mjs';
import { fetchHtml } from './hospital-custom-html-helpers.mjs';
import { detectLang, hqPostalCodeForLocality } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { parsePostJobDetail } from './postch-job-parser.mjs';
import { parseCsbDetailPage } from './successfactors-shared-job-parser-common.mjs';

export const ZKB_KEY = 'zkb';
export const ZKB_COMPANY_NAME = 'Zürcher Kantonalbank';
export const ZKB_COMPANY_DOMAIN = 'zkb.ch';

const CAREER_ORIGIN = 'https://jobs.zkb.ch';
const CAREER_LISTING_URL = `${CAREER_ORIGIN}/go/Offene-Stellen-bei-der-Z%C3%BCrcher-Kantonalbank/511074/`;
const RECRUITING_API_URL = `${CAREER_ORIGIN}/services/recruiting/v1/jobs`;
const SOURCE_LOCALE = 'de_DE';
const DEFAULT_CITY = 'Zürich';
const DEFAULT_CANTON = 'ZH';
const DEFAULT_POSTAL_CODE = '8001';
const API_PAGE_SIZE = 10;
const API_MAX_PAGES = 100;
const DETAIL_DELAY_MS = 250;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeApiText(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function encodePathSegment(value = '') {
  const decoded = (() => {
    try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
  })();
  return encodeURIComponent(decoded);
}

function recordIdentity(record = {}) {
  return normalizeSpace(record.id || record.jobReqId || record.jobId || '');
}

function canonicalDetailUrl(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl, CAREER_ORIGIN);
    if (parsed.hostname.toLowerCase() !== 'jobs.zkb.ch' || !/^\/job\//i.test(parsed.pathname)) return '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Build the official ZKB detail URL from one recruiting-API record.
 * Exported so the URL contract is tested independently of the network path.
 */
export function buildZkbDetailUrl(record = {}) {
  const supplied = canonicalDetailUrl(record.url || record.jobUrl || record.detailUrl || '');
  if (supplied) return supplied;

  const id = recordIdentity(record);
  const title = decodeApiText(record.unifiedUrlTitle || record.urlTitle || record.title || record.jobTitle || '');
  if (!id || !title) return '';
  const localeId = /-[a-z]{2}_[A-Z]{2}$/i.test(id) ? id : `${id}-${SOURCE_LOCALE}`;
  return `${CAREER_ORIGIN}/job/${encodePathSegment(title)}/${encodePathSegment(localeId)}/`;
}

/**
 * Validate and unwrap one recruiting API response page.
 * A malformed list is a source failure, not an empty result.
 */
export function parseZkbApiResponse(payload, pageNumber = 0) {
  if (!payload || !Array.isArray(payload.jobSearchResult)) {
    throw new Error(`ZKB recruiting API page ${pageNumber}: expected jobSearchResult array.`);
  }
  return payload.jobSearchResult.map((entry, index) => {
    const record = entry?.response && typeof entry.response === 'object'
      ? entry.response
      : entry;
    if (!record || typeof record !== 'object' || !recordIdentity(record)) {
      throw new Error(`ZKB recruiting API page ${pageNumber}: row ${index} has no stable identity.`);
    }
    return record;
  });
}

function declaredTotal(payload, pageNumber) {
  if (payload?.totalJobs == null || payload.totalJobs === '') return null;
  const total = Number(payload.totalJobs);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`ZKB recruiting API page ${pageNumber}: invalid totalJobs.`);
  }
  return total > 0 ? total : null;
}

async function fetchZkbApiPage(pageNumber) {
  return fetchJson(RECRUITING_API_URL, {
    method: 'POST',
    timeoutMs: 20_000,
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
      Origin: CAREER_ORIGIN,
      Referer: CAREER_LISTING_URL,
    },
    body: {
      locale: SOURCE_LOCALE,
      pageNumber,
      pageSize: API_PAGE_SIZE,
      sortBy: 'date',
    },
    label: `ZKB recruiting API (page ${pageNumber})`,
  });
}

async function fetchZkbListings() {
  const recordsById = new Map();
  let totalJobs = null;

  for (let pageNumber = 0; pageNumber < API_MAX_PAGES; pageNumber += 1) {
    const payload = await fetchZkbApiPage(pageNumber);
    const pageTotal = declaredTotal(payload, pageNumber);
    if (pageTotal !== null) {
      if (totalJobs !== null && totalJobs !== pageTotal) {
        throw new Error(`ZKB recruiting API pagination changed totalJobs from ${totalJobs} to ${pageTotal}.`);
      }
      totalJobs = pageTotal;
    }

    const pageRecords = parseZkbApiResponse(payload, pageNumber);
    if (pageRecords.length === 0) {
      if (totalJobs !== null && recordsById.size < totalJobs) {
        throw new Error(`ZKB recruiting API pagination ended at ${recordsById.size}/${totalJobs} records.`);
      }
      return [...recordsById.values()];
    }

    let added = 0;
    for (const record of pageRecords) {
      const id = recordIdentity(record);
      if (!recordsById.has(id)) added += 1;
      recordsById.set(id, record);
    }
    if (added === 0) {
      throw new Error(`ZKB recruiting API pagination made no unique progress on page ${pageNumber}.`);
    }
    if (totalJobs !== null && recordsById.size >= totalJobs) {
      return [...recordsById.values()];
    }
    if (totalJobs === null && pageRecords.length < API_PAGE_SIZE) {
      return [...recordsById.values()];
    }
  }

  throw new Error(`ZKB recruiting API pagination exceeded ${API_MAX_PAGES} pages.`);
}

function parseApiLocation(record = {}) {
  const locations = Array.isArray(record.jobLocationShort)
    ? record.jobLocationShort
    : (record.jobLocationShort ? [record.jobLocationShort] : []);

  for (const rawLocation of locations) {
    const parts = String(rawLocation || '').split('|').map(normalizeSpace);
    const city = parts[0] || '';
    const countryCode = (parts[4] || parts.at(-1) || '').toUpperCase();
    if (!city || (countryCode && countryCode !== 'CHE' && countryCode !== 'CH')) continue;
    const canton = normalizeCantonCode(parts[2]) || inferSwissTargetCanton(city);
    if (canton) return { city, canton };
  }
  return null;
}

function detailCountry(detail = {}) {
  const placeCountry = detail.places?.find((place) => place?.address?.addressCountry)?.address?.addressCountry;
  return normalize(placeCountry || detail.country || '');
}

function isSwissCountry(value = '') {
  const country = normalize(value);
  return !country || country === 'ch' || country === 'che' || country.includes('schweiz')
    || country.includes('switzerland') || country.includes('suisse') || country.includes('svizzera');
}

function resolveZkbLocation(detail = {}, record = {}) {
  const sourceCountry = detailCountry(detail);
  if (!isSwissCountry(sourceCountry)) return null;

  const detailCity = normalizeSpace(detail.city || '');
  const detailCanton = normalizeCantonCode(detail.region) || inferSwissTargetCanton(detailCity);
  if (detailCity && detailCanton) return { city: detailCity, canton: detailCanton };

  return parseApiLocation(record);
}

function wordCount(value = '') {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

/**
 * Parse both current NES detail markup and the older CSB property-id markup.
 * The second parser is a bounded compatibility path for pages during the
 * vendor migration; neither path invents a vacancy body.
 */
export function parseZkbDetailPage(html = '', url = '') {
  const nes = parsePostJobDetail(html, url);
  const csb = parseCsbDetailPage(html) || {};
  const nesTitle = /^stellendetails$/i.test(String(nes.title || '').trim()) ? '' : nes.title;
  const description = wordCount(nes.description) >= wordCount(csb.descriptionText)
    ? nes.description
    : (csb.descriptionText || nes.description || '');
  const placeCountry = nes.places?.find((place) => place?.address?.addressCountry)?.address?.addressCountry || '';

  return {
    ...nes,
    title: normalizeSpace(nesTitle || csb.title || ''),
    description,
    city: normalizeSpace(nes.city || csb.city || ''),
    region: normalizeSpace(nes.region || csb.region || ''),
    postalCode: normalizeSpace(nes.postalCode || csb.postalCode || ''),
    country: placeCountry || csb.country || nes.country || '',
    datePosted: nes.datePosted || csb.datePosted || '',
    postedDate: nes.postedDate || csb.postedDate || '',
    postingDateSource: nes.postingDateSource || csb.postingDateSource || '',
    employmentType: nes.employmentType || (csb.rateText ? 'FULL_TIME' : ''),
  };
}

function detectCategory(title = '') {
  const text = normalize(title);
  if (/\b(engineer|entwickl|software|devops|it\b|informat|cloud|platform|data|cyber)/.test(text)) return 'IT';
  if (/\b(finanz|finance|bank|treasury|risk|kredit|hypothek|investment|berater)/.test(text)) return 'Finanza';
  if (/\b(hr|human resources|personal|recruit|talent)/.test(text)) return 'Risorse Umane';
  if (/\b(marketing|kommunik|communication|content)/.test(text)) return 'Marketing';
  if (/\b(legal|recht|compliance)/.test(text)) return 'Legale';
  return 'Amministrazione';
}

function detectExperienceLevel(title = '') {
  const text = normalize(title);
  if (/\b(junior|trainee|praktik|lehr|lernend|apprend)/.test(text)) return 'junior';
  if (/\b(senior|lead|head|leiter|teamleiter|director)/.test(text)) return 'senior';
  return 'mid';
}

function detectEmploymentType(detail = {}) {
  if (detail.employmentType === 'PART_TIME') return 'PART_TIME';
  if (detail.employmentType === 'INTERN') return 'INTERN';
  return 'FULL_TIME';
}

function isZkbApiRecord(record = {}) {
  const brand = normalize(record.brandUrl || record.brand || record.company || '');
  return !brand || brand.includes('zkb') || brand.includes('zürcher kantonalbank');
}

/**
 * Fetch all current ZKB jobs from the official SuccessFactors portal.
 */
export async function fetchAllZkbJobs() {
  console.log(`🔍 Fetching ${ZKB_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_LISTING_URL} (SuccessFactors NES recruiting API)\n`);

  const listings = (await fetchZkbListings()).filter(isZkbApiRecord);
  if (listings.length === 0) {
    console.warn('⚠️ ZKB recruiting API returned no ZKB listings.');
    return [];
  }

  const jobs = [];
  let withoutBody = 0;
  for (const record of listings) {
    const url = buildZkbDetailUrl(record);
    if (!url) throw new Error(`ZKB recruiting API record ${recordIdentity(record)} has no detail URL.`);

    let detail = {};
    try {
      const html = await fetchHtml(url);
      detail = parseZkbDetailPage(html, url);
    } catch (error) {
      console.warn(`  ⚠️ ZKB detail fetch failed for ${recordIdentity(record)}: ${error?.message || error}`);
    }

    const title = normalizeSpace(detail.title || record.title || record.jobTitle || '');
    const description = normalizeSpace(detail.description || '');
    if (!title || !meetsSourceBodyFloor(description)) {
      withoutBody += 1;
      await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
      continue;
    }

    const location = resolveZkbLocation(detail, record);
    if (!location) {
      console.warn(`  ⏭️ ZKB listing has no resolvable Swiss location: ${title}`);
      continue;
    }

    const sourceLang = detectLang(description || title, 'de');
    const slug = slugify(`${title} ${ZKB_KEY} ${location.city}`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const postalCode = detail.postalCode
      || hqPostalCodeForLocality(location.city, DEFAULT_CITY, DEFAULT_POSTAL_CODE, DEFAULT_CANTON);
    const employmentType = detectEmploymentType(detail);

    jobs.push({
      id: `${ZKB_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      company: ZKB_COMPANY_NAME,
      companyKey: ZKB_KEY,
      companyDomain: ZKB_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: location.city,
      canton: location.canton,
      url,
      source: 'Zürcher Kantonalbank Dedicated Parser (SuccessFactors NES)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location.city,
      addressRegion: location.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Finanza / Banca',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, detail),
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: recordIdentity(record),
    });

    await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
  }

  if (withoutBody > 0) {
    console.log(`  ⏭️ ${withoutBody} ZKB listing(s) without a vacancy body — not published.`);
  }
  console.log(`\n📋 Total unique ${ZKB_COMPANY_NAME} jobs: ${jobs.length}`);
  return jobs;
}

export function isZkbJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return key === ZKB_KEY
    || company.includes('zkb')
    || company.includes('zürcher kantonalbank')
    || url.includes('zkb.ch')
    || url.includes('apply.refline.ch/792841/');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'zkb.ch' || host.endsWith('.zkb.ch')) return true;
    return host === 'apply.refline.ch' && /^\/792841\//.test(parsed.pathname);
  } catch {
    return false;
  }
}
