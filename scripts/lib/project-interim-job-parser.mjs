#!/usr/bin/env node
/**
 * Project Interim — official WordPress careers source, scoped to masons in GE.
 *
 * Public listing: https://projectinterim.ch/work/
 * Official records: https://projectinterim.ch/wp-json/wp/v2/works
 *
 * The custom `work` records expose the canonical detail URL, authored body,
 * source publication timestamp and `work-meta-fields` used by the public
 * detail page. Only masonry roles whose own metadata says Genève enter this
 * slice; the agency address is never used as a workplace fallback.
 */
import {
  RETRYABLE_STATUS,
  fetchWithRetry,
  normalizeDescriptionSpace,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

export const PROJECT_INTERIM_KEY = 'project-interim';
export const PROJECT_INTERIM_COMPANY_NAME = 'Project Interim Sàrl';
export const PROJECT_INTERIM_COMPANY_DOMAIN = 'projectinterim.ch';

export const PROJECT_INTERIM_CAREER_URL = 'https://projectinterim.ch/work/';
const PROJECT_INTERIM_API_URL = 'https://projectinterim.ch/wp-json/wp/v2/works';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const SOURCE_LANG = 'fr';
const MAX_SLUG_LENGTH = 90;

function fold(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === PROJECT_INTERIM_COMPANY_DOMAIN
        || url.hostname === `www.${PROJECT_INTERIM_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

export function isProjectInterimJob(job) {
  const key = fold(job?.companyKey || '');
  const company = fold(job?.company || '');
  return key === PROJECT_INTERIM_KEY
    || company === fold(PROJECT_INTERIM_COMPANY_NAME)
    || isTrustedDomain(job?.url || '');
}

export function isMasonRole(title = '') {
  // `work_type=Maçon` is a broad site taxonomy and currently also labels a
  // "Centraliste à Béton" vacancy. The authored title is the professional
  // evidence for this narrow muratore slice; category alone must not promote.
  return /\bmacon(?:ne|nerie|s)?\b/i.test(fold(title));
}

function canonicalDetailUrl(rawUrl = '') {
  if (!isTrustedDomain(rawUrl)) return '';
  const url = new URL(rawUrl);
  if (!/^\/work\/[^/]+\/?$/.test(url.pathname)) return '';
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function employmentFields(meta = {}) {
  const type = normalizeSpace(meta.type_of_employment || '');
  const activity = normalizeSpace(meta.activity || '');
  const temporary = /temporaire|int[ée]rim|dur[ée]e\s+d[ée]termin[ée]e/i.test(type);
  const percentage = Number(activity.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.'));
  return {
    contract: temporary ? 'temporary' : 'other',
    employmentType: temporary ? 'TEMPORARY' : (percentage >= 80 ? 'FULL_TIME' : 'OTHER'),
  };
}

function publicationFields(record, now) {
  const dateGmt = normalizeSpace(record?.date_gmt || '');
  return sourcePostingDateCandidatesFields([
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dateGmt) ? `${dateGmt}Z` : dateGmt,
    record?.date,
  ], now);
}

function projectInterimSlug(title, recordId) {
  // Keep the historical title/company/location slug as the readable prefix,
  // then append the immutable WordPress record id. This preserves the old
  // slug shape while making repeated titles collision-free and stable across
  // title edits or feed ordering changes.
  const suffix = slugify(recordId);
  const maxBaseLength = Math.max(1, MAX_SLUG_LENGTH - suffix.length - 1);
  const base = slugify(`${title} project interim geneve`, maxBaseLength);
  return base ? `${base}-${suffix}` : suffix;
}

export function parseProjectInterimWork(record, now = new Date()) {
  const title = normalizeSpace(stripHtml(record?.title?.rendered || ''));
  const description = normalizeDescriptionSpace(stripHtml(record?.content?.rendered || ''));
  const meta = record?.['work-meta-fields'] && typeof record['work-meta-fields'] === 'object'
    ? record['work-meta-fields']
    : {};
  const rawLocation = normalizeSpace(meta.location || '');
  const resolved = resolveSourceBackedSwissGeography(rawLocation, 'CH');
  const geography = sourceBackedSwissGeographyFields({
    location: rawLocation,
    addressLocality: rawLocation,
    addressRegion: resolved?.canton || '',
    addressCountry: 'CH',
  }, resolved);
  const url = canonicalDetailUrl(record?.link || '');
  const recordId = String(record?.id || '').trim();

  if (!/^\d+$/.test(recordId) || !title || !description || !url) return null;
  if (!isMasonRole(title)) return null;
  if (!geography || geography.canton !== 'GE') return null;
  if (description.split(/\s+/).filter(Boolean).length < 50) return null;

  const slug = projectInterimSlug(title, recordId);
  return {
    id: `${PROJECT_INTERIM_KEY}-${recordId}`,
    slug,
    slugByLocale: { [SOURCE_LANG]: slug },
    slugDisambiguator: recordId,
    company: PROJECT_INTERIM_COMPANY_NAME,
    companyKey: PROJECT_INTERIM_KEY,
    companyDomain: PROJECT_INTERIM_COMPANY_DOMAIN,
    title,
    titleByLocale: { [SOURCE_LANG]: title },
    description,
    descriptionByLocale: { [SOURCE_LANG]: description },
    needsRetranslation: true,
    ...geography,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: geography.postalCode || '',
    streetAddress: geography.streetAddress || '',
    url,
    applyUrl: url,
    source: 'Project Interim Dedicated Parser (official WordPress work record)',
    sourceLang: SOURCE_LANG,
    crawledAt: now.toISOString(),
    hiringOrganizationName: PROJECT_INTERIM_COMPANY_NAME,
    category: 'Muratore',
    sector: 'Edilizia / Costruzioni',
    ...employmentFields(meta),
    experienceLevel: 'mid',
    currency: 'CHF',
    featured: false,
    requirements: [],
    requirementsByLocale: { [SOURCE_LANG]: [] },
    startDate: normalizeSpace(meta.start_date || ''),
    activity: normalizeSpace(meta.activity || ''),
    ...publicationFields(record, now),
  };
}

function worksPageUrl(page) {
  const fields = 'id,slug,link,date,date_gmt,title,content,work-meta-fields';
  return `${PROJECT_INTERIM_API_URL}?per_page=${PAGE_SIZE}&page=${page}&_fields=${fields}`;
}

async function fetchWorksPage(page) {
  const url = worksPageUrl(page);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Referer: PROJECT_INTERIM_CAREER_URL },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${url}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      const batch = JSON.parse(await response.text());
      if (!Array.isArray(batch)) throw new Error('Unexpected Project Interim payload: expected an array');
      const declaredTotalPages = Number(response.headers?.get?.('x-wp-totalpages'));
      return {
        batch,
        totalPages: Number.isInteger(declaredTotalPages) && declaredTotalPages > 0
          ? declaredTotalPages
          : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { label: `Project Interim official work records page ${page}` });
}

export async function fetchAllProjectInterimJobs() {
  console.log(`Fetching ${PROJECT_INTERIM_COMPANY_NAME} mason jobs in GE`);
  console.log(`   Source: ${PROJECT_INTERIM_CAREER_URL}\n`);

  const records = [];
  let totalPages = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchWorksPage(page);
    if (page === 1 && result.totalPages != null) {
      if (result.totalPages > MAX_PAGES) {
        throw new Error(`Project Interim feed exceeded ${MAX_PAGES * PAGE_SIZE} records`);
      }
      totalPages = result.totalPages;
    }
    records.push(...result.batch);
    if ((totalPages != null && page >= totalPages) || result.batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new Error(`Project Interim feed exceeded ${MAX_PAGES * PAGE_SIZE} records`);
  }

  const now = new Date();
  const jobs = records.map((record) => parseProjectInterimWork(record, now)).filter(Boolean);
  console.log(`   Official records: ${records.length}; muratore:GE jobs: ${jobs.length}`);
  return jobs;
}
