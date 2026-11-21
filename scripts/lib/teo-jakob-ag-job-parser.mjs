#!/usr/bin/env node
/**
 * Teo Jakob AG — Jobalino tenant parser.
 *
 * The public component is the tenant inventory. Detail pages provide the
 * JobPosting body and address evidence. The component also carries openings
 * for teo jakob real estate AG, so ownership is accepted only when the source
 * employer name is exactly Teo Jakob AG.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import {
  extractJobalinoJobPostingJsonLd,
  fetchJobalinoComponentListing,
  fetchJobalinoDetailHtml,
  isExplicitlyInactiveJobalinoPosting,
  jobalinoDescriptionToText,
  parseJobalinoListingHtml,
} from './jobalino-common.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

export const TEO_JAKOB_AG_KEY = 'teo-jakob-ag';
export const TEO_JAKOB_AG_COMPANY_NAME = 'Teo Jakob AG';
export const TEO_JAKOB_AG_COMPANY_DOMAIN = 'my.jobalino.ch';

const LISTING_COMPANY = 'teo-jakob-ag';
const SOURCE_COMPANY_NAME = 'teo jakob ag';
const CAREER_URL = 'https://my.jobalino.ch/public/component/jobsfactory?company_name=teo-jakob-ag&lang=de&lang_filter=de&task=framelistjobs';
const DETAIL_DELAY_MS = 250;

export { slugify, stripHtml };

function normalize(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function objectValues(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0
    || values.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    return null;
  }
  return values;
}

function hasGeographicEvidence(address = {}) {
  return [
    address.addressLocality,
    address.addressRegion,
    address.addressCountry,
    address.postalCode,
    address.streetAddress,
  ].some((value) => typeof value === 'string' && normalizeSpace(value));
}

function tenantEmployer(tile = {}, posting = {}) {
  if (!hasOwn(posting, 'hiringOrganization')) {
    const listingName = normalizeSpace(tile.company || '');
    return { name: listingName, isTenant: normalize(listingName) === SOURCE_COMPANY_NAME };
  }
  const organizations = objectValues(posting.hiringOrganization);
  if (!organizations) {
    throw new Error('Teo Jakob AG hiringOrganization is unusable');
  }
  const named = organizations
    .map((organization) => normalizeSpace(organization.name || ''))
    .filter(Boolean);
  if (named.length !== organizations.length) {
    throw new Error('Teo Jakob AG hiringOrganization is unusable');
  }
  const matching = named.filter((name) => normalize(name) === SOURCE_COMPANY_NAME);
  if (matching.length > 1) {
    throw new Error('Teo Jakob AG hiringOrganization is ambiguous');
  }
  if (matching.length === 1) return { name: matching[0], isTenant: true };
  return { name: named.join(' | '), isTenant: false };
}

function addressCandidates(posting = {}) {
  if (!hasOwn(posting, 'jobLocation')) return null;
  const locations = objectValues(posting.jobLocation);
  if (!locations) throw new Error('Teo Jakob AG jobLocation is unusable');
  const addresses = [];
  for (const location of locations) {
    if (!hasOwn(location, 'address')) {
      throw new Error('Teo Jakob AG jobLocation address is unusable');
    }
    const locationAddresses = objectValues(location.address);
    if (!locationAddresses) {
      throw new Error('Teo Jakob AG jobLocation address is unusable');
    }
    addresses.push(...locationAddresses.filter(hasGeographicEvidence));
  }
  if (addresses.length === 0) {
    throw new Error('Teo Jakob AG jobLocation address is unusable');
  }
  return addresses;
}

function sourceGeography(tile = {}, posting = {}) {
  const listingCity = normalizeSpace(tile.city || '');
  const listingPostal = normalizeSpace(tile.zip || '');
  const candidates = addressCandidates(posting);
  const sourceCandidates = candidates || [{}];
  const matches = [];
  const matchingAddressKeys = new Set();

  for (const address of sourceCandidates) {
    const candidateCity = normalizeSpace(address.addressLocality || '');
    const candidatePostal = normalizeSpace(address.postalCode || '');
    if (listingCity && candidateCity && normalize(listingCity) !== normalize(candidateCity)) continue;
    if (listingPostal && candidatePostal && listingPostal !== candidatePostal) continue;
    const addressLocality = listingCity || candidateCity;
    const addressCountry = normalizeSpace(address.addressCountry || tile.country || '');
    const sourceAddressKey = JSON.stringify({
      addressLocality: candidateCity,
      addressRegion: normalizeSpace(address.addressRegion || ''),
      postalCode: candidatePostal,
      streetAddress: normalizeSpace(address.streetAddress || ''),
    });
    const evidence = {
      location: addressLocality,
      addressLocality,
      addressRegion: normalizeSpace(address.addressRegion || ''),
      addressCountry,
      country: addressCountry,
      postalCode: listingPostal || candidatePostal,
      streetAddress: normalizeSpace(address.streetAddress) || normalizeSpace(tile.address),
    };
    const resolved = resolveSourceBackedSwissGeography(evidence);
    if (!resolved) continue;
    matchingAddressKeys.add(sourceAddressKey);
    matches.push(sourceBackedSwissGeographyFields(evidence, resolved));
  }

  if (matchingAddressKeys.size > 1) {
    throw new Error('Teo Jakob AG jobLocation is ambiguous');
  }
  const distinct = new Map(matches.map((candidate) => [JSON.stringify({
    addressLocality: candidate.addressLocality,
    addressRegion: candidate.addressRegion,
    addressCountry: candidate.addressCountry,
    postalCode: candidate.postalCode,
    streetAddress: candidate.streetAddress,
  }), candidate]));
  if (distinct.size > 1) throw new Error('Teo Jakob AG jobLocation is ambiguous');
  return distinct.values().next().value || null;
}

export function isTeoJakobAgJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  return key === TEO_JAKOB_AG_KEY || company === SOURCE_COMPANY_NAME;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === TEO_JAKOB_AG_COMPANY_DOMAIN
      || host.endsWith('.' + TEO_JAKOB_AG_COMPANY_DOMAIN);
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const value = normalize(title);
  if (/\b(logist|lager|warehouse|ausliefer|montag)/.test(value)) return 'Logistica';
  if (/\b(verkauf|sales|vendita|commerce|detailhandel)/.test(value)) return 'Commerciale';
  if (/\b(immobil|architektur|interior|design)/.test(value)) return 'Design / Architettura';
  if (/\b(admin|sekret|contab|buchhalt|account)/.test(value)) return 'Amministrazione';
  if (/\b(hr|human|personal|risorse)/.test(value)) return 'Risorse Umane';
  if (/\b(it|software|develop|programm)/.test(value)) return 'IT';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const value = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehr|lernend|apprenti)/.test(value)) return 'intern';
  if (/\b(junior|jr)\b/.test(value)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|responsab)\b/.test(value)) return 'senior';
  return 'mid';
}

function workloadFields(workload = '', title = '') {
  const text = normalizeSpace(workload);
  const range = text.match(/(\d{1,3})\s*%?\s*-\s*(\d{1,3})\s*%/);
  const single = text.match(/(\d{1,3})\s*%/);
  let pensumMin = null;
  let pensumMax = null;
  if (range) {
    pensumMin = Number.parseInt(range[1], 10);
    pensumMax = Number.parseInt(range[2], 10);
  } else if (single) {
    pensumMin = Number.parseInt(single[1], 10);
    pensumMax = pensumMin;
  }
  const words = normalize(text + ' ' + title);
  const employmentType = Number.isFinite(pensumMax)
    ? (pensumMax < 90 ? 'PART_TIME' : 'FULL_TIME')
    : /\b(teilzeit|part.?time|tempo parziale|temps partiel)\b/.test(words)
      ? 'PART_TIME'
      : /\b(vollzeit|full.?time|tempo pieno|temps plein)\b/.test(words)
        ? 'FULL_TIME'
        : 'OTHER';
  return {
    employmentType,
    contract: employmentType === 'PART_TIME'
      ? 'part-time'
      : employmentType === 'FULL_TIME' ? 'full-time' : 'other',
    ...(text ? { pensum: text } : {}),
    ...(Number.isFinite(pensumMin) ? { pensumMin } : {}),
    ...(Number.isFinite(pensumMax) ? { pensumMax } : {}),
  };
}

export async function fetchAllTeoJakobAgJobs() {
  console.log('🔍 Fetching Teo Jakob AG jobs');
  console.log('   Source: ' + CAREER_URL + '\n');

  const listing = await fetchJobalinoComponentListing({
    companyName: LISTING_COMPANY,
    locale: 'de',
  });
  if (listing.error) throw new Error('Jobalino listing error: ' + listing.error);

  const tiles = parseJobalinoListingHtml(listing.html);
  if (!tiles.length) {
    throw new Error('No openings parsed from the Teo Jakob AG Jobalino listing');
  }

  const jobs = [];
  let foreignCompany = 0;
  let inactive = 0;

  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    if (tile.company && normalize(tile.company) !== SOURCE_COMPANY_NAME) {
      foreignCompany += 1;
      continue;
    }

    let detailHtml = '';
    try {
      detailHtml = await fetchJobalinoDetailHtml(tile.url);
    } catch (error) {
      throw new Error(
        'Teo Jakob AG detail fetch failed for ' + tile.url + ': ' + (error?.message || error),
        { cause: error },
      );
    }
    const posting = extractJobalinoJobPostingJsonLd(detailHtml);
    if (isExplicitlyInactiveJobalinoPosting(detailHtml, posting)) {
      inactive += 1;
      continue;
    }
    if (!posting) {
      throw new Error('Teo Jakob AG detail has no JobPosting JSON-LD: ' + tile.url);
    }
    const employer = tenantEmployer(tile, posting || {});
    if (!employer.name) {
      throw new Error('Teo Jakob AG employer is missing from listing and detail: ' + tile.url);
    }
    if (!employer.isTenant) {
      foreignCompany += 1;
      continue;
    }

    const title = normalizeSpace(posting?.title || tile.title || '');
    const description = jobalinoDescriptionToText(posting?.description || '');
    const geography = sourceGeography(tile, posting || {});
    if (!title || !meetsSourceBodyFloor(description) || !geography
      || !geography.addressLocality || !geography.postalCode || !geography.streetAddress) {
      throw new Error('Teo Jakob AG required source fields are incomplete: ' + tile.url);
    }

    const sourceLang = detectLang(description || title, 'de');
    const publicUrl = tile.url;
    const jobSlug = slugify(title + ' ' + geography.location + ' teo-jakob-ag ch');
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const workload = workloadFields(tile.workload, title);
    const publication = mergeSourcePostingDates({}, posting || {});
    const validThrough = normalizeSpace(posting?.validThrough || '');

    jobs.push({
      id: TEO_JAKOB_AG_KEY + '-' + urlHash,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TEO_JAKOB_AG_COMPANY_NAME,
      companyKey: TEO_JAKOB_AG_KEY,
      companyDomain: TEO_JAKOB_AG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: geography.location,
      canton: geography.canton,
      url: publicUrl,
      source: 'Teo Jakob AG Dedicated Parser (Jobalino)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: geography.addressLocality,
      addressRegion: geography.addressRegion || geography.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: geography.postalCode,
      streetAddress: geography.streetAddress,
      streetAddressSource: 'listing-source',
      category: detectCategory(title),
      ...workload,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Arredamento / Interior design',
      currency: 'CHF',
      featured: false,
      ...publication,
      ...(validThrough ? { validThrough } : {}),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      externalId: String(tile.id),
      hiringOrganizationName: TEO_JAKOB_AG_COMPANY_NAME,
    });

    if (index < tiles.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
    }
  }

  console.log(
    '\n📋 Total Teo Jakob AG jobs discovered: ' + jobs.length
    + ' (' + foreignCompany + ' other-company, ' + inactive + ' inactive)',
  );
  return jobs;
}
