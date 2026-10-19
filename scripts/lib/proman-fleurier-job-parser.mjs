import { createHash } from 'node:crypto';
import { detectLang, appendSlugDisambiguator } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import {
  resolveSourceBackedSwissGeography,
  resolveDetailOrListingSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

export const PROMAN_FLEURIER_KEY = 'proman-fleurier';
export const PROMAN_FLEURIER_COMPANY_NAME = 'PROMAN BM-EMPLOI SA — Fleurier';
export const PROMAN_FLEURIER_COMPANY_DOMAIN = 'proman.ch';

const CAREER_URL = 'https://www.proman-group.ch/Job/SearchJobs?brancheId=0&regionId=0&typeId=0';
const TRUSTED_HOSTS = new Set([
  'proman.ch',
  'www.proman.ch',
  'proman-group.ch',
  'www.proman-group.ch',
]);
const TARGET_CANTON = 'NE';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function locationKey(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Proman's detail card sometimes uses a source-local label rather than a
// canton or a current BFS municipality (for example `Couvet`, `St-Imier`, or
// `Franches Montagnes`). These are exact labels reviewed on the official
// board, not a free-text geocoder: every fallback candidate still goes through
// the shared source-backed resolver with the reviewed canton.
const PROMAN_SOURCE_LOCATION_CANTONS = new Map([
  ['ayer', 'VS'],
  ['bramois', 'VS'],
  ['chermignon d en bas', 'VS'],
  ['court', 'BE'],
  ['couvet', 'NE'],
  ['crans montana', 'VS'],
  ['fleurier', 'NE'],
  ['franches montagnes', 'JU'],
  ['glovelier', 'JU'],
  ['granges vs', 'VS'],
  ['st imier', 'BE'],
  ['st leonard', 'VS'],
]);

// The runtime re-checks the returned evidence. These reviewed parent/current
// municipality names corroborate the otherwise ambiguous two-letter region
// code (`NE`) without changing the source display location.
const PROMAN_SOURCE_LOCATION_LOCALITIES = new Map([
  ['canton de neuchatel', 'Neuchâtel'],
  ['couvet', 'Val-de-Travers'],
  ['fleurier', 'Val-de-Travers'],
]);

function classContainer(html = '', className = '') {
  const escaped = String(className || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  ).exec(String(html || ''));
  return match?.[2] || '';
}

/**
 * Proman's current detail template has no JobPosting JSON-LD or microdata.
 * These are still authored vacancy fields: the location is the item marked by
 * the official location icon and the body is the rendered `u-specs` block.
 */
function extractPromanRenderedDetail(html = '') {
  const infoBlock = classContainer(html, 'u-job-infos');
  const locationItem = [...infoBlock.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .find((match) => /<u-svg\b[^>]*\bsource\s*=\s*["']24\/job\/location["']/i.test(match[1]));
  const location = normalizeSpace(
    stripHtml(locationItem?.[1] || '')
      .replace(/^\s*lieu\s*/iu, ''),
  );
  const bodyHtml = [classContainer(html, 'u-intro'), classContainer(html, 'u-specs')]
    .filter(Boolean)
    .join('\n');
  return {
    title: normalizeSpace(stripHtml(
      /<section\b[^>]*\bclass\s*=\s*["'][^"']*u-section-job-details-header[^"']*["'][^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/i
        .exec(String(html || ''))?.[1] || '',
    )),
    location,
    description: stripHtml(bodyHtml),
  };
}

function resolvePromanDetailGeography(detail = {}) {
  const decision = resolveDetailOrListingSwissGeography(detail, {});
  if (decision.geography || decision.explicitlyForeign) return decision;
  const location = normalizeSpace(detail.location);
  const canton = PROMAN_SOURCE_LOCATION_CANTONS.get(locationKey(location));
  if (!location || !canton) return decision;
  const candidate = { location, addressRegion: canton };
  const geography = resolveSourceBackedSwissGeography(candidate);
  return geography
    ? { geography, explicitlyForeign: false, candidate }
    : decision;
}

function emptyDetail(detail, sourceBackedCanton = '') {
  return {
    ...detail,
    title: '',
    description: '',
    location: '',
    canton: '',
    addressLocality: '',
    addressRegion: '',
    addressCountry: '',
    country: '',
    postalCode: '',
    streetAddress: '',
    locationCandidates: [],
    ...(sourceBackedCanton
      ? { sourceBackedCanton, locationGateRejected: true }
      : {}),
  };
}

/**
 * The official group board is multi-canton. Keep the source-backed location
 * resolver as the only authority, then expose a non-target canton marker so
 * the shared runtime can count other cantons as an intentional filter rather
 * than treating them as failed detail extraction.
 */
export function extractPromanFleurierDetailFields(html = '', pageUrl = '') {
  const detail = extractDetailFields(html, pageUrl);
  const rendered = extractPromanRenderedDetail(html);
  const sourceDetail = {
    ...detail,
    ...(rendered.title ? { title: rendered.title } : {}),
    ...(rendered.description ? { description: rendered.description } : {}),
    ...(rendered.location
      ? {
        location: rendered.location,
        locationCandidates: [{ location: rendered.location }],
      }
      : {}),
  };
  const decision = resolvePromanDetailGeography(sourceDetail);
  if (!decision.geography) return emptyDetail(sourceDetail);

  if (decision.geography.canton !== TARGET_CANTON) {
    return emptyDetail(sourceDetail, decision.geography.canton);
  }

  const evidenceCandidate = {
    ...decision.candidate,
    ...(PROMAN_SOURCE_LOCATION_LOCALITIES.has(locationKey(sourceDetail.location))
      ? { addressLocality: PROMAN_SOURCE_LOCATION_LOCALITIES.get(locationKey(sourceDetail.location)) }
      : {}),
  };
  const fields = sourceBackedSwissGeographyFields(evidenceCandidate, decision.geography);
  return {
    ...sourceDetail,
    ...fields,
    locationCandidates: [{ ...evidenceCandidate, ...fields }],
  };
}

export function isPromanFleurierExpectedDetailFilter({ reason, detail } = {}) {
  return reason === 'geography'
    && Boolean(detail?.sourceBackedCanton)
    && detail.sourceBackedCanton !== TARGET_CANTON;
}

export function isPromanFleurierJob(job) {
  return normalizeSpace(job?.companyKey || '').toLowerCase() === PROMAN_FLEURIER_KEY;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    return TRUSTED_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function fetchJobListings(runtime = {}) {
  return runSpecInProduction(loadSpec(PROMAN_FLEURIER_KEY), {
    ...runtime,
    detailExtractor: extractPromanFleurierDetailFields,
    isExpectedDetailFilter: isPromanFleurierExpectedDetailFilter,
  });
}

export async function fetchAllPromanFleurierJobs(runtime = {}) {
  const listings = await fetchJobListings(runtime);
  const jobs = [];
  for (const listing of listings || []) {
    const title = normalizeSpace(listing.title);
    const description = stripHtml(listing.description || '');
    const url = normalizeSpace(listing.url);
    const geography = resolveDetailOrListingSwissGeography(listing, {}).geography;
    if (title.length < 3 || !description || !url || !geography || geography.canton !== TARGET_CANTON) continue;
    if (!isTrustedDomain(url)) continue;

    const sourceLang = detectLang(`${title} ${description}`, 'fr');
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const slug = appendSlugDisambiguator(
      slugify(`${title} ${geography.location} proman`),
      urlHash.slice(0, 8),
    );
    jobs.push({
      id: `${PROMAN_FLEURIER_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      slugDisambiguator: urlHash.slice(0, 8),
      company: PROMAN_FLEURIER_COMPANY_NAME,
      companyKey: PROMAN_FLEURIER_KEY,
      companyDomain: PROMAN_FLEURIER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: geography.location,
      canton: geography.canton,
      url,
      source: 'PROMAN Official Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: listing.addressLocality || geography.location,
      addressRegion: geography.canton,
      ...(listing.addressCountry ? { addressCountry: listing.addressCountry } : {}),
      ...(listing.postalCode ? { postalCode: listing.postalCode } : {}),
      ...(listing.streetAddress ? { streetAddress: listing.streetAddress } : {}),
      employmentType: listing.employmentType || 'OTHER',
      contract: 'other',
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

export { CAREER_URL as PROMAN_FLEURIER_CAREER_URL };
