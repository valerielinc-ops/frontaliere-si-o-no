#!/usr/bin/env node
/**
 * Parser for the inline vacancies published on Rohrer Gartenbau's official
 * jobs page. The page is the complete source inventory: each vacancy is a
 * heading followed by its body, rather than an ATS listing with detail URLs.
 *
 * Only the source-backed Treppenhausreinigung vacancy is emitted for this
 * crawler. The other headings on the page are real vacancies, but are not
 * part of the addetto-pulizie:OW target and must not be reclassified as such.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import {
  fetchHtml,
  normalizeDescriptionSpace,
  normalizeSpace,
  slugify,
  stripHtml,
} from './crawler-template.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

export const ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY = 'rohrer-gartenbau-und-hauswartungen';
export const ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME = 'Rohrer Gartenbau und Hauswartungen GmbH';
export const ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_DOMAIN = 'rohrer-gartenbau.ch';
export const ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL = 'https://rohrer-gartenbau.ch/unternehmen/jobs/';

const ROLE_HEADING_RE = /\b(?:landschaftsg[aä]rtner(?:\/in)?|g[aä]rtner(?:\/in)?|flachdach(?:-service)?|treppenhausreinigung|reinigungskraft|unterhaltsreinigung|raumpfleger(?:\/in)?|reinigungsmitarbeiter(?:\/in)?)\b/i;
const CLEANING_ROLE_RE = /\b(?:treppenhausreinigung|reinigungskraft|unterhaltsreinigung|raumpfleger(?:\/in)?|reinigungsmitarbeiter(?:\/in)?)\b/i;
const OBWALDEN_RE = /\bObwalden\b/i;
const POSITIVE_OBWALDEN_WORKPLACE_RE = /\b(?:arbeitsort(?:e)?|arbeitsplatz|einsatzort(?:e)?|einsatzgebiet|t[aä]tigkeitsgebiet|standort|objekt(?:e|en)?|liegenschaft(?:en)?|reinigung(?:s(?:ort|objekt|arbeiten))?|hauswartung(?:en)?|arbeit(?:en)?|stelle(?:n)?|position(?:en)?)\b[^.!?;\n]{0,80}\bObwalden\b|\bObwalden\b[^.!?;\n]{0,80}\b(?:arbeitsort(?:e)?|arbeitsplatz|einsatzort(?:e)?|einsatzgebiet|t[aä]tigkeitsgebiet|standort|objekt(?:e|en)?|liegenschaft(?:en)?|reinigung(?:s(?:ort|objekt|arbeiten))?|hauswartung(?:en)?|arbeit(?:en)?|stelle(?:n)?|position(?:en)?)\b/i;
const OBWALDEN_NEGATION_RE = /\b(?:nicht|kein(?:e[snmr]?|en)?|ohne|au(?:sser|ßer)halb(?:\s+von)?)\b/i;

/** Validate both the origin and the protocol of source-owned URLs. */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_DOMAIN
        || host.endsWith(`.${ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_DOMAIN}`));
  } catch {
    return false;
  }
}

/** Match rows belonging to this crawler without accepting a neighbouring ATS. */
export function isRohrerGartenbauUndHauswartungenJob(job) {
  const key = normalizeSpace(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalizeSpace(job?.company || '').toLowerCase();
  const url = normalizeSpace(job?.url || '');
  return key === ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY
    || key.startsWith(`${ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY}-`)
    || company.includes(ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME.toLowerCase())
    || isTrustedDomain(url);
}

function textOfJsonLd(value, dates) {
  if (Array.isArray(value)) {
    for (const entry of value) textOfJsonLd(entry, dates);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.datePublished === 'string') dates.push(value.datePublished);
  if (value['@graph']) textOfJsonLd(value['@graph'], dates);
}

function extractPublicationFields(document, now) {
  const candidates = [];
  for (const meta of document.querySelectorAll(
    'meta[property="article:published_time"], meta[name="datePublished"], meta[itemprop="datePublished"]',
  )) {
    const value = meta.getAttribute('content');
    if (value) candidates.push(value);
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      textOfJsonLd(JSON.parse(script.textContent || ''), candidates);
    } catch {
      // A malformed unrelated JSON-LD block must not hide valid page metadata.
    }
  }
  return sourcePostingDateCandidatesFields(candidates, now);
}

function sourceContentRoot(document) {
  const root = document.querySelector('main, [role="main"], article') || document.body;
  for (const noisy of root.querySelectorAll('script, style, nav, footer, header, aside, form')) {
    noisy.remove();
  }
  return root;
}

function extractHeadings(root) {
  return [...root.querySelectorAll('h2, h3, h4, h5')];
}

function extractPositiveWorkplaceEvidence(description) {
  for (const clause of String(description || '').split(/[.!?;\n]+/)) {
    const obwaldenIndex = clause.search(OBWALDEN_RE);
    const nearbyContext = obwaldenIndex >= 0
      ? clause.slice(Math.max(0, obwaldenIndex - 80), obwaldenIndex + 'Obwalden'.length + 80)
      : '';
    if (!POSITIVE_OBWALDEN_WORKPLACE_RE.test(clause) || OBWALDEN_NEGATION_RE.test(nearbyContext)) continue;
    return clause.match(OBWALDEN_RE)?.[0] || '';
  }
  return '';
}

function extractHeadingBody(heading, nextHeading, root, document) {
  const range = document.createRange();
  range.setStartAfter(heading);
  if (nextHeading) range.setEndBefore(nextHeading);
  else range.setEndAfter(root);
  const wrapper = document.createElement('div');
  wrapper.appendChild(range.cloneContents());
  return normalizeDescriptionSpace(stripHtml(wrapper.innerHTML));
}

function annotateListings(listings, metadata) {
  Object.defineProperties(listings, {
    discoveredCount: { value: metadata.discoveredCount, enumerable: false },
    fetchOutcome: { value: metadata.fetchOutcome, enumerable: false },
  });
  return listings;
}

/**
 * Parse the official page's role-heading sections.
 *
 * The Obwalden test is applied to the vacancy body, not the company footer or
 * page navigation. This prevents the employer's Sachseln address from being
 * reused as a workplace for a role whose source does not name Obwalden.
 */
export function parseRohrerGartenbauUndHauswartungenPage(
  html = '',
  pageUrl = ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
  { now = new Date() } = {},
) {
  if (!String(html || '').trim() || !isTrustedDomain(pageUrl)) {
    return { listings: [], discoveredCount: 0, fetchOutcome: 'selector_miss' };
  }

  const document = new JSDOM(String(html)).window.document;
  const publication = extractPublicationFields(document, now);
  const root = sourceContentRoot(document);
  const allHeadings = extractHeadings(root);
  const roleHeadings = allHeadings
    .filter((heading) => ROLE_HEADING_RE.test(normalizeSpace(heading.textContent || '')));
  const listings = [];
  let sawCleaningHeading = false;

  for (let index = 0; index < allHeadings.length; index += 1) {
    const heading = allHeadings[index];
    const title = normalizeSpace(heading.textContent || '');
    if (!ROLE_HEADING_RE.test(title) || !CLEANING_ROLE_RE.test(title)) continue;
    sawCleaningHeading = true;

    const description = extractHeadingBody(heading, allHeadings[index + 1], root, document);
    const workplaceEvidence = extractPositiveWorkplaceEvidence(description);
    const geography = workplaceEvidence
      ? resolveSourceBackedSwissGeography(workplaceEvidence)
      : null;
    if (!geography || geography.canton !== 'OW' || !meetsSourceBodyFloor(description)) continue;

    const address = sourceBackedSwissGeographyFields(workplaceEvidence, geography);
    const pageUrlObject = new URL(pageUrl);
    pageUrlObject.hash = '';
    const url = `${pageUrlObject.href}#${slugify(title)}`;
    listings.push({
      title,
      description,
      url,
      location: address.location,
      canton: address.canton,
      addressLocality: address.addressLocality,
      addressRegion: address.addressRegion,
      addressCountry: address.addressCountry || 'CH',
      ...publication,
      employmentType: /\b100\s*%|\bvollzeit\b/i.test(title)
        ? 'FULL_TIME'
        : /\b(?:teilzeit|part[ -]?time)\b|\b\d{1,3}\s*%/i.test(title)
          ? 'PART_TIME'
          : 'OTHER',
    });
  }

  const fetchOutcome = listings.length > 0
    ? 'ok'
    : roleHeadings.length === 0 || sawCleaningHeading
      ? 'selector_miss'
      : 'filtered_empty';
  return { listings, discoveredCount: roleHeadings.length, fetchOutcome };
}

async function fetchJobListings({ fetchHtmlImpl = fetchHtml, now = new Date() } = {}) {
  const html = await fetchHtmlImpl(ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    validateRedirectUrl: isTrustedDomain,
  });
  const parsed = parseRohrerGartenbauUndHauswartungenPage(
    html,
    ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
    { now },
  );
  return annotateListings(parsed.listings, parsed);
}

function buildRohrerGartenbauUndHauswartungenJob(listing, now) {
  const sourceLang = detectLang(`${listing.title}\n${listing.description}`, 'de');
  const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
  const slug = slugify(`${listing.title} ${listing.location} rohrer-gartenbau-und-hauswartungen ch`);
  return {
    id: `${ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY}-${urlHash}`,
    slug,
    slugByLocale: { [sourceLang]: slug },
    company: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME,
    companyKey: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY,
    companyDomain: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_DOMAIN,
    title: listing.title,
    titleByLocale: { [sourceLang]: listing.title },
    description: listing.description,
    descriptionByLocale: { [sourceLang]: listing.description },
    location: listing.location,
    canton: listing.canton,
    addressLocality: listing.addressLocality,
    addressRegion: listing.addressRegion,
    addressCountry: listing.addressCountry,
    url: listing.url,
    source: 'Rohrer Gartenbau und Hauswartungen GmbH Official Dedicated Parser',
    sourceLang,
    crawledAt: now.toISOString(),
    category: 'Pulizie',
    contract: listing.employmentType === 'PART_TIME' ? 'part-time' : 'other',
    employmentType: listing.employmentType,
    experienceLevel: 'mid',
    sector: 'Facility Management / Pulizie',
    currency: 'CHF',
    featured: false,
    datePosted: listing.datePosted,
    postedDate: listing.postedDate,
    postingDateSource: listing.postingDateSource,
    applyUrl: listing.url,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/** Fetch, parse and return source-locale jobs for runStandardCrawlerPipeline. */
export async function fetchAllRohrerGartenbauUndHauswartungenJobs(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const listings = await fetchJobListings({ ...options, now });
  const jobs = listings.map((listing) => buildRohrerGartenbauUndHauswartungenJob(listing, now));
  Object.defineProperties(jobs, {
    discoveredCount: { value: listings.discoveredCount ?? listings.length, enumerable: false },
    fetchOutcome: { value: listings.fetchOutcome || (jobs.length > 0 ? 'ok' : 'selector_miss'), enumerable: false },
  });
  return jobs;
}

export { slugify, stripHtml };
