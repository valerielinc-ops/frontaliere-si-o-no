#!/usr/bin/env node
/**
 * Seniorenzentrum Engelhof job parser.
 *
 * The official career page links to a dedicated EmployerBoard tenant. The
 * promoted spec reads that official page and the linked tenant listing; this
 * parser keeps only source titles relevant to the oss:SZ coverage unit.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { bodyTextOf, extractDetailFields } from './prospector/extract.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { matchProfessionTitle, normalizeText } from './profession-taxonomy.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import {
  freeTextPostalCandidates,
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
  variablePostalGeography,
} from './prospector/location-evidence.mjs';
import {
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
} from './hospital-custom-html-helpers.mjs';

export const SENIORENZENTRUM_ENGELHOF_KEY = 'seniorenzentrum-engelhof';
export const SENIORENZENTRUM_ENGELHOF_COMPANY_NAME = 'Seniorenzentrum Engelhof';
export const SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN = 'seniorenzentrum-engelhof.ch';

const CAREER_URL = 'https://seniorenzentrum-engelhof.ch/arbeiten-im-engelhof/freie-stellen';
const EMPLOYER_BOARD_HOST = 'seniorenzentrum-engelhof.employerboard.ch';
const SOZJOBS_HOST = 'www.sozjobs.ch';
const EXPECTED_CANTON = 'SZ';
const SENIORENZENTRUM_ENGELHOF_EMPLOYER_POSTAL_LOCATIONS = Object.freeze([
  '8852 Altendorf',
]);
const SENIORENZENTRUM_ENGELHOF_POSTAL_LOCATION_RX = /(?:^|\D)(?:CH[\s-]?)?(\d{4})\s+(\p{Lu}[\p{L}'’.-]*(?:[ -][\p{L}][\p{L}'’.-]*){0,3})/gu;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * EmployerBoard does not use the exact "OSS" label for every Swiss care
 * qualification. The shared title taxonomy maps Pflegehelfer/in to
 * assistente-cura, while the canton profession matcher includes that same
 * role in its OSS surface. Keep both IDs, plus the source's explicit EBA
 * qualification, and do not classify a neighbouring nursing/management role.
 */
export function isSeniorenzentrumEngelhofOssJob(job = {}) {
  const title = normalizeSpace(job?.title || '');
  if (!title) return false;

  const professionId = matchProfessionTitle(title);
  if (professionId === 'oss' || professionId === 'assistente-cura') return true;

  const sourceTitle = normalizeText(title);
  return sourceTitle.includes('gesundheit')
    && sourceTitle.includes('soziales')
    && sourceTitle.includes('eba');
}

export function isSeniorenzentrumEngelhofJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');

  return (
    key === SENIORENZENTRUM_ENGELHOF_KEY
    || company.includes(normalize(SENIORENZENTRUM_ENGELHOF_COMPANY_NAME))
    || isEngelhofIdentityDomain(job?.url || '')
  );
}

function isEngelhofIdentityDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN
      || host.endsWith('.' + SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN)
      || host === EMPLOYER_BOARD_HOST;
  } catch {
    return false;
  }
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN
      || host.endsWith('.' + SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN)
      || host === EMPLOYER_BOARD_HOST
      || host === SOZJOBS_HOST;
  } catch {
    return false;
  }
}

function isSozjobsDetailUrl(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.toLowerCase() === SOZJOBS_HOST
      && /^\/job\/[^/]+\/J\d{6,7}\/partnerDetail\/easypublish\/widgetid\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function approvedSozjobsLocality(sourceTitle = '', description = '') {
  const employerLocalities = new Set(
    SENIORENZENTRUM_ENGELHOF_EMPLOYER_POSTAL_LOCATIONS.map((entry) => (
      String(entry).replace(/^\d{4}\s+/, '').trim().toLowerCase()
    )),
  );
  const candidates = [];
  const titleLocation = /\s[-–—]\s+([^|–—]+?)\s*$/u.exec(String(sourceTitle || ''))?.[1];
  if (titleLocation) candidates.push(titleLocation);
  const bodyLocation = /\bSeniorenzentrum\s+Engelhof\s+(?:in|,|\|)\s+([\p{Lu}][\p{L}'’.-]*(?:[ -][\p{L}][\p{L}'’.-]*){0,3})/u.exec(String(description || ''))?.[1];
  if (bodyLocation) candidates.push(bodyLocation);

  for (const candidate of candidates) {
    const locality = normalizeSpace(candidate).replace(/[.,;:!?]+$/u, '');
    if (!employerLocalities.has(locality.toLowerCase())) continue;
    const geography = resolveSourceBackedSwissGeography({
      location: locality,
      addressLocality: locality,
    });
    if (geography?.canton === EXPECTED_CANTON) return geography;
  }
  return null;
}

function sourceBodyPostalCandidates(text = '') {
  const candidates = freeTextPostalCandidates(text);
  const seen = new Set(candidates.map((candidate) => candidate.location.toLowerCase()));
  const addCandidate = (candidate) => {
    const key = candidate.location.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  // The shared free-text tier deliberately rejects everyday-word localities
  // such as Lachen. Here a postal pair inside this source's reviewed vacancy
  // body is stronger evidence than the bare word; still require the shared
  // resolver before adding it, then let variablePostalGeography remove the
  // reviewed employer seat below.
  for (const match of String(text || '').matchAll(SENIORENZENTRUM_ENGELHOF_POSTAL_LOCATION_RX)) {
    const postalCode = match[1];
    const words = match[2].replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    for (let size = words.length; size >= 1; size -= 1) {
      const addressLocality = words.slice(0, size).join(' ')
        .replace(/[.,;:!?]+$/u, '')
        .trim();
      const candidate = {
        location: `${postalCode} ${addressLocality}`,
        addressLocality,
        postalCode,
      };
      if (!addressLocality || !resolveSourceBackedSwissGeography(candidate)) continue;
      addCandidate(candidate);
      break;
    }
  }
  return candidates;
}

function rejectUnverifiedEngelhofLocation(detail = {}) {
  return {
    ...detail,
    location: '',
    canton: '',
    addressLocality: '',
    addressRegion: '',
    addressCountry: '',
    country: '',
    postalCode: '',
    streetAddress: '',
    locationCandidates: [],
    locationGateRejected: true,
  };
}

/**
 * EmployerBoard currently renders any vacancy-specific postal pair only in the
 * `wwj-text[data-cy="job-detail"]` body. It no longer exposes a JobPosting
 * `jobLocation` or a recognised address container, so the generic extractor
 * otherwise drops every detail page. The reviewed employer seat
 * `8852 Altendorf` is boilerplate: only a different source-backed postal pair
 * in the vacancy body is accepted.
 *
 * Keep this rescue source-specific and scoped to the vacancy body. In
 * particular, do not scan the whole page or substitute the employer address:
 * the shared resolver still verifies the postal/locality pair, and a move to
 * another canton stays fail-closed until this reviewed source contract is
 * updated.
 */
export function extractSeniorenzentrumEngelhofDetailFields(html = '', pageUrl = '', opts = {}) {
  const source = String(html || '');
  const detail = extractDetailFields(source, pageUrl, opts);
  if (!source) return detail;

  const dom = new JSDOM(source);
  try {
    if (isSozjobsDetailUrl(pageUrl)) {
      const sozjobsGeography = approvedSozjobsLocality(
        dom.window.document.title,
        detail.description,
      );
      if (sozjobsGeography) {
        const fields = sourceBackedSwissGeographyFields({
          location: sozjobsGeography.location,
          addressLocality: sozjobsGeography.location,
        }, sozjobsGeography);
        return {
          ...detail,
          ...fields,
          locationCandidates: [fields],
        };
      }
      return rejectUnverifiedEngelhofLocation(detail);
    }

    const vacancyBody = dom.window.document.querySelector('[data-cy="job-detail"]');
    if (!vacancyBody) return rejectUnverifiedEngelhofLocation(detail);

    const vacancyText = bodyTextOf(vacancyBody.innerHTML);
    const candidates = sourceBodyPostalCandidates(vacancyText);
    const decision = variablePostalGeography(
      candidates,
      SENIORENZENTRUM_ENGELHOF_EMPLOYER_POSTAL_LOCATIONS,
    );
    if (decision.geography?.canton === EXPECTED_CANTON) {
      const fields = sourceBackedSwissGeographyFields(decision.candidate, decision.geography);
      return {
        ...detail,
        ...fields,
        locationCandidates: [fields],
      };
    }
    return rejectUnverifiedEngelhofLocation(detail);
  } finally {
    dom.window.close();
  }
}

function normalizedEmploymentType(listing, title) {
  const raw = normalize(listing?.employmentType || '');
  if (['full_time', 'part_time', 'contractor', 'intern', 'other'].includes(raw)) {
    return raw.toUpperCase();
  }
  return detectHealthcareEmploymentType(
    title + ' ' + (listing?.timeType || '') + ' ' + (listing?.employmentType || ''),
  );
}

function buildJob(listing = {}) {
  const title = normalizeSpace(listing.title || '');
  if (!isSeniorenzentrumEngelhofOssJob({ title })) return null;
  if (!listing.url) return null;

  const sourceGeographyEvidence = {
    location: listing.location,
    addressLocality: listing.addressLocality,
    addressRegion: listing.addressRegion,
    addressCountry: listing.addressCountry,
    country: listing.country,
    postalCode: listing.postalCode,
    streetAddress: listing.streetAddress,
  };
  const resolvedGeography = resolveSourceBackedSwissGeography(listing);
  const geography = resolvedGeography
    && sourceBackedSwissGeographyFields(sourceGeographyEvidence, resolvedGeography);
  // A missing or ambiguous source workplace is a drop, never an Engelhof HQ
  // fallback. The job page must prove its own Swiss location.
  if (!geography) return null;

  const descriptionText = stripHtml(listing.description || '');
  if (!meetsSourceBodyFloor(descriptionText)) return null;

  const {
    location,
    canton,
    addressLocality,
    addressRegion,
    addressCountry,
    postalCode,
    streetAddress,
  } = geography;
  const publicUrl = String(listing.url);
  const sourceLang = detectLang(title + '\n' + descriptionText, 'de');
  const jobSlug = slugify(title + ' ' + location + ' ' + SENIORENZENTRUM_ENGELHOF_KEY);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const employmentType = normalizedEmploymentType(listing, title);

  return {
    id: SENIORENZENTRUM_ENGELHOF_KEY + '-' + urlHash,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
    companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
    companyDomain: SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText,
    descriptionByLocale: { [sourceLang]: descriptionText },
    location,
    canton,
    url: publicUrl,
    source: 'Seniorenzentrum Engelhof Dedicated Parser (official career board)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: normalizeSpace(addressLocality || location),
    addressRegion: normalizeSpace(addressRegion || canton),
    addressCountry: normalizeSpace(addressCountry || 'CH'),
    country: normalizeSpace(addressCountry || 'CH'),
    postalCode: normalizeSpace(postalCode || ''),
    streetAddress: normalizeSpace(streetAddress || ''),
    baseSalary: null,
    category: 'Sanità / Ospedali',
    contract: employmentType === 'PART_TIME'
      ? 'part-time'
      : employmentType === 'FULL_TIME' ? 'full-time' : 'other',
    employmentType,
    experienceLevel: detectHealthcareExperienceLevel(title),
    sector: 'Sanità / Ospedali',
    currency: 'CHF',
    featured: false,
    ...mergeSourcePostingDates({}, listing),
    applyUrl: listing.applyUrl || publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

async function fetchJobListings(runtime = {}) {
  const spec = loadSpec(SENIORENZENTRUM_ENGELHOF_KEY);
  const endpoints = Array.isArray(spec?.listingEndpoints) && spec.listingEndpoints.length
    ? spec.listingEndpoints
    : [spec?.listingEndpoint].filter(Boolean);
  const endpointSpecs = endpoints.length
    ? endpoints.map((listingEndpoint) => ({ ...spec, listingEndpoint }))
    : [spec];
  const batches = [];
  for (const endpointSpec of endpointSpecs) {
    batches.push(await runSpecInProduction(endpointSpec, {
      ...runtime,
      detailExtractor: extractSeniorenzentrumEngelhofDetailFields,
    }));
  }

  const listings = batches.flat();
  const metadata = {};
  for (const key of ['fetchOutcome', 'fetchDetail', 'expectedFilterCount', 'expectedFilters', 'authoritativeEmptyState']) {
    const values = batches
      .map((batch) => Object.getOwnPropertyDescriptor(batch, key)?.value)
      .filter((value) => value !== undefined && value !== null);
    if (values.length) metadata[key] = values.at(-1);
  }
  const discoveredCount = batches.reduce((sum, batch) => {
    const value = Object.getOwnPropertyDescriptor(batch, 'discoveredCount')?.value;
    return sum + (Number.isInteger(value) ? value : batch.length);
  }, 0);
  const detailDrops = batches
    .map((batch) => Object.getOwnPropertyDescriptor(batch, 'detailDrop')?.value)
    .filter((drop) => drop && typeof drop === 'object');
  copySpecFetchMetadata(listings, {
    ...metadata,
    discoveredCount,
    ...(detailDrops.length ? {
      detailDrop: detailDrops.reduce((sum, drop) => ({
        candidates: sum.candidates + (Number.isInteger(drop.candidates) ? drop.candidates : 0),
        gone: sum.gone + (Number.isInteger(drop.gone) ? drop.gone : 0),
        rejected: sum.rejected + (Number.isInteger(drop.rejected) ? drop.rejected : 0),
        dropped: sum.dropped + (Number.isInteger(drop.dropped) ? drop.dropped : 0),
      }), { candidates: 0, gone: 0, rejected: 0, dropped: 0 }),
    } : {}),
  });
  return listings;
}

export async function fetchAllSeniorenzentrumEngelhofJobs(runtime = {}) {
  console.log('🔍 Fetching ' + SENIORENZENTRUM_ENGELHOF_COMPANY_NAME + ' jobs');
  console.log('   Source: ' + CAREER_URL + '\n');

  const listings = await fetchJobListings(runtime);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return copySpecFetchMetadata([], listings || []);
  }

  console.log('  📋 Source listings found: ' + listings.length);
  const expectedScopeFilters = listings.filter((listing) => (
    !isSeniorenzentrumEngelhofOssJob({ title: listing?.title })
  )).length;
  const jobs = listings.map(buildJob).filter(Boolean);

  const discoveredCount = Number.isInteger(listings.discoveredCount)
    ? listings.discoveredCount
    : listings.length;
  const inheritedExpectedFilterCount = Number.isInteger(listings.expectedFilterCount)
    && listings.expectedFilterCount >= 0
    ? listings.expectedFilterCount
    : 0;
  const inheritedExpectedFilters = listings.expectedFilters
    && typeof listings.expectedFilters === 'object'
    && !Array.isArray(listings.expectedFilters)
    ? listings.expectedFilters
    : {};
  const inheritedDetailDrop = listings.detailDrop
    && typeof listings.detailDrop === 'object'
    && Number.isInteger(listings.detailDrop.candidates)
    && Number.isInteger(listings.detailDrop.dropped)
    ? listings.detailDrop
    : null;
  const unexpectedPostTransformDrops = Math.max(
    0,
    listings.length - jobs.length - expectedScopeFilters,
  );
  const detailDrop = {
    candidates: Math.max(
      0,
      (inheritedDetailDrop?.candidates ?? Math.max(0, discoveredCount - inheritedExpectedFilterCount))
        - expectedScopeFilters,
    ),
    gone: (inheritedDetailDrop?.gone || 0) + unexpectedPostTransformDrops,
    rejected: inheritedDetailDrop?.rejected || 0,
    dropped: (inheritedDetailDrop?.dropped || 0) + unexpectedPostTransformDrops,
  };
  const expectedFilterCount = inheritedExpectedFilterCount + expectedScopeFilters;
  const expectedFilters = {
    ...inheritedExpectedFilters,
    ...(expectedScopeFilters ? { engelhof_target_job_scope: expectedScopeFilters } : {}),
  };

  console.log('\n📋 Total ' + SENIORENZENTRUM_ENGELHOF_COMPANY_NAME + ' OSS jobs discovered: ' + jobs.length);
  copySpecFetchMetadata(jobs, listings);
  return copySpecFetchMetadata(jobs, {
    discoveredCount,
    expectedFilterCount,
    expectedFilters,
    detailDrop,
  });
}
