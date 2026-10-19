import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang, appendSlugDisambiguator } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { mergeSourcePostingDates, sourcePostingDateFields } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { bodyTextOf, extractDetailFields } from './prospector/extract.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

export const SYMPAJOBS_REINACH_BL_KEY = 'sympajobs-reinach-bl';
export const SYMPAJOBS_REINACH_BL_CANDIDATE_KEY = 'sympajobs@reinach-bl';
export const SYMPAJOBS_REINACH_BL_COMPANY_NAME = 'Sympajobs AG';
export const SYMPAJOBS_REINACH_BL_COMPANY_DOMAIN = 'sympajobs.ch';

export const SYMPAJOBS_REINACH_BL_CAREER_URL = 'https://sympajobs.ch/jobs/';

const SYMPAJOBS_HOSTS = new Set(['sympajobs.ch', 'www.sympajobs.ch']);
const BL_LOCATION_RE = /\b(?:BL|Basel[\s-]?Landschaft|Baselland)\b/i;
const SWISS_COUNTRY_RE = /\b(?:CH|Schweiz|Suisse|Svizzera|Switzerland)\b/i;

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isBlRegionOnlyLocation(value = '') {
  const normalized = normalizeSpace(value);
  if (!BL_LOCATION_RE.test(normalized)) return false;

  const remainder = normalized
    .replace(/\b(?:BL|Basel[\s-]?Landschaft|Baselland)\b/gi, '')
    .replace(/\b(?:CH|Schweiz|Suisse|Svizzera|Switzerland)\b/gi, '')
    .replace(/[\s,.;:/()\-–—]+/g, '');
  return remainder.length === 0;
}

function documentOf(html = '') {
  const document = new JSDOM(String(html || '')).window.document;
  for (const node of document.querySelectorAll('script, style, nav, footer, form')) node.remove();
  return document;
}

function textOfNode(node) {
  return normalizeSpace(node?.textContent || '');
}

function firstText(root, selectors = []) {
  for (const selector of selectors) {
    const value = textOfNode(root?.querySelector(selector));
    if (value) return value;
  }
  return '';
}

function labelledField(root, labelPattern) {
  for (const node of root?.querySelectorAll('[data-label], [data-field], dt, li') || []) {
    const label = normalizeSpace(
      node.getAttribute('data-label')
      || node.getAttribute('data-field')
      || node.querySelector('dt, strong, b, .label')?.textContent
      || '',
    );
    if (!labelPattern.test(label)) continue;
    const value = textOfNode(node.querySelector('dd, .value, .field-value') || node);
    if (value && value.toLowerCase() !== label.toLowerCase()) return value;
  }
  return '';
}

function normalizeSourceDate(value = '') {
  const raw = normalizeSpace(value);
  if (!raw) return '';
  const dotted = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(raw);
  if (dotted) return `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`;
  return raw;
}

function sourceDateFrom(root, base = {}) {
  const node = root?.querySelector(
    '.job_listing-meta .date-posted time, .job-listing-meta .date-posted time, '
      + '.date-posted time, .job_listing-date time, [itemprop="datePosted"], '
      + '.date-posted, .job-listing-date',
  );
  const raw = node?.getAttribute('datetime')
    || node?.getAttribute('content')
    || textOfNode(node)
    || base.datePosted
    || base.postedDate
    || '';
  return sourcePostingDateFields(normalizeSourceDate(raw));
}

function employmentTypeFrom(root, title = '') {
  const value = firstText(root, [
    '.job_listing-meta .job-type',
    '.job-listing-meta .job-type',
    '.job_listing-type',
    '.job-listing-type',
    '[itemprop="employmentType"]',
  ]) || labelledField(root, /^(?:anstellungsart|beschäftigungsart|employment\s*type|pensum)$/i);
  const text = normalizeSpace(`${value} ${title}`).toLowerCase();
  if (/\b(?:teilzeit|part[ -]?time|temps? partiel|tempo parziale)\b/.test(text)) return 'PART_TIME';
  if (/\b(?:vollzeit|full[ -]?time|temps? plein|tempo pieno)\b/.test(text)) return 'FULL_TIME';
  return 'OTHER';
}

function locationFrom(root, base = {}) {
  const value = firstText(root, [
    '.job_listing-meta .location',
    '.job-listing-meta .location',
    '.job_listing-location',
    '.job-listing-location',
    '[itemprop="jobLocation"]',
  ]) || labelledField(root, /^(?:arbeitsort|einsatzort|standort|ort|location)$/i)
    || normalizeSpace(base.location || '');
  if (!value) return null;

  // These fields are retained only when they are present in the source's
  // workplace value. The company address elsewhere on the page is not a
  // fallback for a vacancy location.
  const postalMatch = /\b(?:CH[-\s]?)?(\d{4})\b/.exec(value);
  const postalCode = postalMatch?.[1] || '';
  const addressRegion = BL_LOCATION_RE.test(value) ? 'BL' : '';
  const addressCountry = SWISS_COUNTRY_RE.test(value) || addressRegion
    ? 'CH'
    : normalizeSpace(base.addressCountry || '');
  const localitySource = postalMatch
    ? value.slice((postalMatch.index ?? 0) + postalMatch[0].length)
    : value;
  const addressLocality = isBlRegionOnlyLocation(value)
    ? ''
    : normalizeSpace(
      localitySource
        .replace(/\b(?:Basel[\s-]?Landschaft|Baselland|BL|Schweiz|Suisse|Svizzera|Switzerland)\b/gi, '')
        .replace(/[(),]/g, ' '),
    );
  const streetAddress = postalCode
    ? normalizeSpace(value.match(/^([^,\d][^,]{2,80}),\s*(?:CH[-\s]?)?\d{4}/)?.[1] || '')
    : '';
  const evidence = {
    location: value,
    addressLocality,
    addressRegion,
    addressCountry,
    postalCode,
    streetAddress,
  };
  const geography = resolveSourceBackedSwissGeography(evidence);
  if (!geography) return null;
  const fields = sourceBackedSwissGeographyFields(evidence, geography);
  return fields && isBlRegionOnlyLocation(value)
    ? { ...fields, addressLocality: '' }
    : fields;
}

function descriptionFrom(root, base = '') {
  const descriptionNode = root?.querySelector(
    '.job_description, .job-description, .job_listing-description, '
      + '.job-listing-description, [itemprop="description"]',
  );
  const rendered = bodyTextOf(descriptionNode?.innerHTML || '');
  return rendered || normalizeSpace(base);
}

function isSympajobsUrl(rawUrl = '') {
  try {
    return SYMPAJOBS_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function canonicalUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch {
    return '';
  }
}

export function isSympajobsReinachBlJob(job) {
  const key = normalizeSpace(job?.companyKey || '').toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase();
  return key === SYMPAJOBS_REINACH_BL_KEY
    || key === SYMPAJOBS_REINACH_BL_CANDIDATE_KEY
    || company === SYMPAJOBS_REINACH_BL_COMPANY_NAME.toLowerCase()
    || isSympajobsUrl(job?.url || '');
}

export function isTrustedDomain(rawUrl = '') {
  return isSympajobsUrl(rawUrl);
}

/**
 * Read the vacancy body used by the official WordPress job-listing template.
 * Location is intentionally limited to the job meta/labelled workplace field;
 * the agency address in the footer is not evidence for where an assignment is.
 */
export function extractSympajobsDetailFields(html = '', pageUrl = '') {
  const base = extractDetailFields(html, pageUrl);
  const document = documentOf(html);
  const root = document.querySelector('.job_listing, article.job_listing, main article, main') || document.body;
  const title = firstText(root, ['.job_listing-title', '.job-listing-title', 'h1', 'h2'])
    || normalizeSpace(base.title || document.title);
  const geography = locationFrom(root, base);
  const description = descriptionFrom(root, base.description || '');
  const posting = sourceDateFrom(root, base);
  const employmentType = employmentTypeFrom(root, title);

  if (!geography) {
    return {
      ...base,
      title,
      company: SYMPAJOBS_REINACH_BL_COMPANY_NAME,
      location: '',
      canton: '',
      addressLocality: '',
      addressRegion: '',
      addressCountry: '',
      country: '',
      postalCode: '',
      streetAddress: '',
      locationCandidates: [],
      description,
      ...posting,
      employmentType,
    };
  }

  return {
    ...base,
    title,
    company: SYMPAJOBS_REINACH_BL_COMPANY_NAME,
    description,
    location: geography.location,
    canton: geography.canton,
    addressLocality: geography.addressLocality,
    addressRegion: geography.addressRegion,
    addressCountry: geography.addressCountry || 'CH',
    country: geography.addressCountry || 'CH',
    postalCode: geography.postalCode || '',
    streetAddress: geography.streetAddress || '',
    locationCandidates: [geography],
    ...posting,
    employmentType,
  };
}

async function fetchJobListings(runtime = {}) {
  return runSpecInProduction(loadSpec(SYMPAJOBS_REINACH_BL_KEY), {
    ...runtime,
    detailExtractor: extractSympajobsDetailFields,
  });
}

export async function fetchAllSympajobsReinachBlJobs(runtime = {}) {
  const listings = await fetchJobListings(runtime);
  const jobs = [];
  for (const listing of listings || []) {
    const title = normalizeSpace(listing.title || '');
    const description = stripHtml(listing.description || '');
    const url = canonicalUrl(listing.url || listing.sourceUrl || '');
    const regionOnly = isBlRegionOnlyLocation(listing.location || '');
    const listingEvidence = regionOnly
      ? { ...listing, addressLocality: '' }
      : listing.locationCandidates?.[0] || listing;
    const geography = resolveSourceBackedSwissGeography(listingEvidence);
    if (title.length < 3 || !description || !url || !isTrustedDomain(url) || !geography || geography.canton !== 'BL') continue;

    const sourceLang = detectLang(`${title} ${description}`, 'de');
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const slug = appendSlugDisambiguator(
      slugify(`${title} ${geography.location} sympajobs ch`),
      urlHash.slice(0, 8),
    );
    const resolvedGeographyFields = sourceBackedSwissGeographyFields(
      listingEvidence,
      geography,
    );
    const geographyFields = regionOnly
      ? { ...resolvedGeographyFields, addressLocality: '' }
      : resolvedGeographyFields;
    jobs.push({
      id: `${SYMPAJOBS_REINACH_BL_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      slugDisambiguator: urlHash.slice(0, 8),
      company: SYMPAJOBS_REINACH_BL_COMPANY_NAME,
      companyKey: SYMPAJOBS_REINACH_BL_KEY,
      companyDomain: SYMPAJOBS_REINACH_BL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: geographyFields.location,
      canton: geographyFields.canton,
      url,
      source: 'Sympajobs Official Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: geographyFields.addressLocality,
      addressRegion: geographyFields.addressRegion,
      addressCountry: geographyFields.addressCountry || 'CH',
      country: geographyFields.addressCountry || 'CH',
      ...(geographyFields.postalCode ? { postalCode: geographyFields.postalCode } : {}),
      ...(geographyFields.streetAddress ? { streetAddress: geographyFields.streetAddress } : {}),
      employmentType: listing.employmentType || 'OTHER',
      contract: listing.employmentType === 'PART_TIME' ? 'part-time' : 'other',
      experienceLevel: 'mid',
      sector: 'Altro',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  return copySpecFetchMetadata(jobs, listings || []);
}
