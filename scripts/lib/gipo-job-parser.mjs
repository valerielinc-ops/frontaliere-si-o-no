#!/usr/bin/env node
/**
 * GIPO GISLER POWER AG job parser.
 *
 * The source is the official GIPO careers index and its vacancy detail pages.
 * The detail extractor keeps the generic structured-data cascade, then adds
 * the source's rendered address and employment labels when the CMS omits them.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { appendSlugDisambiguator, detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { bodyTextOf, extractDetailFields } from './prospector/extract.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

export const GIPO_KEY = 'gipo';
export const GIPO_COMPANY_NAME = 'GIPO GISLER POWER AG';
export const GIPO_COMPANY_DOMAIN = 'gipo.ch';
export const GIPO_CAREER_URL = 'https://gipo.ch/de/karriere-bei-gipo/stellenangebote-bei-gipo/';

const GIPO_DETAIL_PATH_RE = /^\/de\/offene_stellen\/[^/]+\/?$/i;
const GIPO_ENGINEERING_TITLE_RE = /\b(?:system[-\s]?engineer|(?:electrical|software|mechanical|civil)[-\s]?engineer|(?:elektro)?ingenieur(?:in)?|ingegnere(?:[a-zà-öø-ÿ]*)?|ingénieur(?:e)?|elektrotechniker(?:in)?|projektleiter(?:in)?[-\s]+elektro(?:technik)?)\b/iu;

// All observed GIPO vacancies expose the Seedorf UR company address. This is
// a source-specific safe default for the CMS detail template, not a generic
// employer-HQ fallback: it is used only when the official detail page carries
// no usable location evidence at all, and a conflicting explicit location
// remains fail-closed.
const GIPO_DEFAULT_GEOGRAPHY = Object.freeze({
  location: 'Seedorf',
  canton: 'UR',
  addressLocality: 'Seedorf',
  addressRegion: 'UR',
  addressCountry: 'CH',
  postalCode: '6462',
  streetAddress: 'Kohlplatzstrasse 15',
});

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeDocument(html = '') {
  return new JSDOM(String(html || '')).window.document;
}

function nonEmpty(value) {
  return normalizeSpace(value);
}

/**
 * Restrict URLs to GIPO's official detail route and canonicalise the host,
 * query and fragment so one vacancy has one stable identity.
 */
export function canonicalizeGipoUrl(rawUrl = '', baseUrl = GIPO_CAREER_URL) {
  let url;
  try { url = new URL(rawUrl, baseUrl); } catch { return ''; }
  if (!isTrustedDomain(url.href) || !GIPO_DETAIL_PATH_RE.test(url.pathname)) return '';
  url.hostname = GIPO_COMPANY_DOMAIN;
  url.search = '';
  url.hash = '';
  const segments = url.pathname.split('/').filter(Boolean);
  url.pathname = `/${segments.join('/')}/`;
  return url.href;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === GIPO_COMPANY_DOMAIN || host === `www.${GIPO_COMPANY_DOMAIN}`;
  } catch {
    return false;
  }
}

export function isGipoEngineeringVacancy(value = {}) {
  const title = normalizeSpace(typeof value === 'string' ? value : value?.title);
  return GIPO_ENGINEERING_TITLE_RE.test(title);
}

export function isGipoJob(job = {}) {
  const key = normalizeSpace(job.companyKey).toLowerCase();
  const company = normalizeSpace(job.company).toLowerCase();
  return key === GIPO_KEY
    || company.includes('gipo')
    || isTrustedDomain(job.url || '');
}

function employmentTypeFromText(...values) {
  const existing = values
    .map((value) => normalizeSpace(value))
    .find((value) => /^(?:FULL_TIME|PART_TIME|CONTRACTOR|TEMPORARY|INTERN|OTHER)$/i.test(value));
  if (existing) return existing.toUpperCase();

  const text = normalizeSpace(values.filter(Boolean).join(' '));
  if (/\b(?:teilzeit|part[-\s]?time|tempo\s+parziale|temps\s+partiel)\b/i.test(text)) {
    return 'PART_TIME';
  }
  if (/\b(?:vollzeit|full[-\s]?time|festanstellung|tempo\s+pieno|temps\s+plein)\b/i.test(text)) {
    return 'FULL_TIME';
  }
  return 'OTHER';
}

function extractStreetAddress(text = '', postalCode = '', locality = '') {
  const clean = normalizeSpace(text);
  if (!clean || !postalCode || !locality) return '';
  const escapedPostal = String(postalCode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedLocality = String(locality).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = clean.match(new RegExp(
    `(?:^|[|;•])?\\s*([^|;•]{2,100}?)\\s*,?\\s*(?:CH[- ]?)?${escapedPostal}\\s+${escapedLocality}\\b`,
    'i',
  ));
  return normalizeSpace(match?.[1] || '').replace(/[,:-]+$/, '').trim();
}

function renderedGipoAddressCandidates(document, root) {
  const nodes = new Set([
    ...root.querySelectorAll(
      'address, [itemprop="address"], [itemprop="streetAddress"], '
      + '[itemprop="addressLocality"], [itemprop="postalCode"], '
      + 'a[href*="maps"], a[href*="google.com/maps"]',
    ),
    ...document.querySelectorAll(
      'address, [itemprop="address"], [itemprop="streetAddress"], '
      + '[itemprop="addressLocality"], [itemprop="postalCode"], '
      + 'a[href*="maps"], a[href*="google.com/maps"]',
    ),
  ]);
  const values = [...nodes].map((node) => normalizeSpace(node.textContent)).filter(Boolean);
  const localityNode = root.querySelector('[itemprop="addressLocality"]')
    || document.querySelector('[itemprop="addressLocality"]');
  const postalNode = root.querySelector('[itemprop="postalCode"]')
    || document.querySelector('[itemprop="postalCode"]');
  const regionNode = root.querySelector('[itemprop="addressRegion"]')
    || document.querySelector('[itemprop="addressRegion"]');
  const countryNode = root.querySelector('[itemprop="addressCountry"]')
    || document.querySelector('[itemprop="addressCountry"]');
  const itemLocality = nonEmpty(localityNode?.textContent);
  const itemPostal = nonEmpty(postalNode?.textContent).match(/\b\d{4}\b/)?.[0] || '';
  const itemRegion = nonEmpty(regionNode?.textContent);
  const itemCountry = nonEmpty(countryNode?.textContent);
  const candidates = [];

  if (itemLocality || itemPostal || itemRegion || itemCountry) {
    candidates.push({
      location: [itemPostal, itemLocality].filter(Boolean).join(' '),
      addressLocality: itemLocality,
      addressRegion: itemRegion,
      addressCountry: itemCountry,
      postalCode: itemPostal,
      streetAddress: extractStreetAddress(values.join(' | '), itemPostal, itemLocality),
    });
  }

  for (const value of values) {
    const match = value.match(/\b(?:CH[- ]?)?(\d{4})\s+(Seedorf)\b/i);
    if (!match) continue;
    candidates.push({
      location: match[2],
      addressLocality: match[2],
      addressRegion: 'UR',
      addressCountry: 'CH',
      postalCode: match[1],
      streetAddress: extractStreetAddress(value, match[1], match[2]),
    });
  }
  return { candidates, hasExplicitAddressEvidence: values.length > 0 || candidates.length > 0 };
}

function detailRoot(document) {
  const root = document.querySelector('main, article') || document.body || document.documentElement;
  for (const node of root.querySelectorAll('script, style, nav, footer, header, aside, form')) node.remove();
  return root;
}

function sourceEvidenceCandidates(detail, rendered) {
  const candidates = [
    ...(rendered.candidates || []),
    ...(Array.isArray(detail.locationCandidates) ? detail.locationCandidates : []),
  ];
  const detailCandidate = {
    location: nonEmpty(detail.location),
    addressLocality: nonEmpty(detail.addressLocality),
    addressRegion: nonEmpty(detail.addressRegion),
    addressCountry: nonEmpty(detail.addressCountry),
    postalCode: nonEmpty(detail.postalCode),
    streetAddress: nonEmpty(detail.streetAddress),
  };
  if (Object.values(detailCandidate).some(Boolean)) candidates.push(detailCandidate);
  return candidates.filter((candidate) => candidate && typeof candidate === 'object');
}

function resolveGipoGeography(detail, rendered) {
  const candidates = sourceEvidenceCandidates(detail, rendered);
  for (const candidate of candidates) {
    const resolved = resolveSourceBackedSwissGeography(candidate);
    if (!resolved) continue;
    const fields = sourceBackedSwissGeographyFields(candidate, resolved);
    if (fields) return fields;
  }

  // If the source exposed a conflicting/ambiguous location, do not overwrite
  // it with the employer default. An entirely unannotated official detail page
  // is the only case where the reviewed GIPO template default is allowed.
  if (candidates.length || detail.authoritativeLocationConflict || rendered.hasExplicitAddressEvidence) return null;
  const resolvedDefault = resolveSourceBackedSwissGeography(GIPO_DEFAULT_GEOGRAPHY);
  return sourceBackedSwissGeographyFields(GIPO_DEFAULT_GEOGRAPHY, resolvedDefault);
}

export function extractGipoDetailFields(html = '', pageUrl = '') {
  const base = extractDetailFields(html, pageUrl);
  const document = safeDocument(html);
  const root = detailRoot(document);
  const rendered = renderedGipoAddressCandidates(document, root);
  const title = nonEmpty(root.querySelector('h1, h2, h3')?.textContent || base.title || document.title);
  const renderedDescription = normalizeSpace(bodyTextOf(root.innerHTML));
  const genericDescription = normalizeSpace(stripHtml(base.description || ''));
  const description = [renderedDescription, genericDescription]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || '';
  const employmentType = employmentTypeFromText(base.employmentType, renderedDescription, title);
  const geography = resolveGipoGeography(base, rendered);
  if (!geography) {
    return {
      ...base,
      title,
      description,
      location: '',
      canton: '',
      addressLocality: '',
      addressRegion: '',
      addressCountry: '',
      country: '',
      postalCode: '',
      streetAddress: '',
      locationCandidates: [],
      employmentType,
    };
  }

  const isDefaultSeedorf = geography.location === GIPO_DEFAULT_GEOGRAPHY.location
    && geography.canton === GIPO_DEFAULT_GEOGRAPHY.canton;
  const postalCode = nonEmpty(geography.postalCode) || (isDefaultSeedorf ? GIPO_DEFAULT_GEOGRAPHY.postalCode : '');
  const streetAddress = nonEmpty(geography.streetAddress)
    || (isDefaultSeedorf ? GIPO_DEFAULT_GEOGRAPHY.streetAddress : '');
  const addressCountry = nonEmpty(geography.addressCountry) || 'CH';
  const addressLocality = nonEmpty(geography.addressLocality) || geography.location;
  const projected = {
    ...geography,
    addressLocality,
    addressRegion: geography.canton,
    addressCountry,
    postalCode,
    streetAddress,
  };
  return {
    ...base,
    title,
    description,
    location: projected.location,
    canton: projected.canton,
    addressLocality: projected.addressLocality,
    addressRegion: projected.addressRegion,
    addressCountry: projected.addressCountry,
    country: projected.addressCountry,
    postalCode: projected.postalCode,
    streetAddress: projected.streetAddress,
    locationCandidates: [projected],
    employmentType,
  };
}

function detailEvidence(listing) {
  const firstCandidate = Array.isArray(listing.locationCandidates)
    ? listing.locationCandidates[0]
    : null;
  if (firstCandidate && typeof firstCandidate === 'object') return firstCandidate;
  return {
    location: nonEmpty(listing.location),
    addressLocality: nonEmpty(listing.addressLocality),
    addressRegion: nonEmpty(listing.addressRegion),
    addressCountry: nonEmpty(listing.addressCountry),
    postalCode: nonEmpty(listing.postalCode),
    streetAddress: nonEmpty(listing.streetAddress),
  };
}

function jobContract(employmentType) {
  if (employmentType === 'PART_TIME') return 'part-time';
  if (employmentType === 'FULL_TIME') return 'full-time';
  return 'other';
}

export function buildGipoJobs(listings = []) {
  const jobs = [];
  for (const listing of Array.isArray(listings) ? listings : []) {
    const title = normalizeSpace(listing?.title);
    if (title.length < 3 || !isGipoEngineeringVacancy({ title })) continue;
    const description = normalizeSpace(stripHtml(listing?.description || ''));
    if (description.split(/\s+/).filter(Boolean).length < 50) continue;
    const url = canonicalizeGipoUrl(listing?.url || listing?.sourceUrl || '');
    if (!url || !isTrustedDomain(url)) continue;

    const evidence = detailEvidence(listing);
    const resolved = resolveSourceBackedSwissGeography(evidence);
    const geography = sourceBackedSwissGeographyFields(evidence, resolved);
    if (!geography || geography.canton !== 'UR') continue;

    const isDefaultSeedorf = geography.location === GIPO_DEFAULT_GEOGRAPHY.location;
    const addressCountry = nonEmpty(geography.addressCountry) || 'CH';
    const addressLocality = nonEmpty(geography.addressLocality) || geography.location;
    const postalCode = nonEmpty(geography.postalCode) || (isDefaultSeedorf ? GIPO_DEFAULT_GEOGRAPHY.postalCode : '');
    const streetAddress = nonEmpty(geography.streetAddress)
      || (isDefaultSeedorf ? GIPO_DEFAULT_GEOGRAPHY.streetAddress : '');
    const sourceLang = detectLang(`${title} ${description}`, 'de');
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const slug = appendSlugDisambiguator(
      slugify(`${title} ${geography.location} gipo ch`),
      urlHash.slice(0, 8),
    );
    const employmentType = employmentTypeFromText(listing.employmentType, listing.title);
    jobs.push({
      id: `${GIPO_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      slugDisambiguator: urlHash.slice(0, 8),
      company: GIPO_COMPANY_NAME,
      companyKey: GIPO_KEY,
      companyDomain: GIPO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: geography.location,
      canton: geography.canton,
      url,
      source: 'GIPO GISLER POWER AG Official Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality,
      addressRegion: geography.canton,
      addressCountry,
      country: addressCountry,
      postalCode,
      streetAddress,
      baseSalary: null,
      category: 'Ingegneria',
      contract: jobContract(employmentType),
      employmentType,
      experienceLevel: /\bsenior\b/i.test(title) ? 'senior' : 'mid',
      sector: 'engineering',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  return jobs;
}

async function fetchJobListings(runtime = {}) {
  return runSpecInProduction(loadSpec(GIPO_KEY), {
    ...runtime,
    detailExtractor: extractGipoDetailFields,
  });
}

export async function fetchAllGipoJobs(runtime = {}) {
  const listings = await fetchJobListings(runtime);
  return copySpecFetchMetadata(buildGipoJobs(listings || []), listings || []);
}
