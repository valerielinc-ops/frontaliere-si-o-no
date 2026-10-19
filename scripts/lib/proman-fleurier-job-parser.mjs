import { createHash } from 'node:crypto';
import { detectLang, appendSlugDisambiguator } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  extractBalancedTagBlock,
  extractBalancedTagBlockWithStatus,
  parseSwissShortDate,
} from './hospital-custom-html-helpers.mjs';
import { readAttr, scanStartTags } from './html-attr.mjs';
import { mergeSourcePostingDates, sourcePostingDateFields } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import {
  bodyTextOf,
  extractDetailFields,
  isSufficientVacancyDescription,
  textOf,
} from './prospector/extract.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import {
  resolveDetailOrListingSwissGeography,
  resolveSourceBackedSwissGeography,
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

// These exact labels are reviewed on the official board; they are not a
// free-text geocoder and every candidate still passes through the shared
// source-backed geography resolver.
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

const PROMAN_SOURCE_LOCATION_LOCALITIES = new Map([
  ['canton de neuchatel', 'Neuchâtel'],
  ['couvet', 'Val-de-Travers'],
  ['fleurier', 'Val-de-Travers'],
]);

function hasClass(opening = '', className = '') {
  return normalizeSpace(readAttr(opening, 'class')).split(' ').includes(className);
}

function firstTagBlock(html = '', tag = '', predicate = () => true) {
  const opening = scanStartTags(html, tag).find(({ raw }) => predicate(raw));
  if (!opening) return '';
  return extractBalancedTagBlock(html.slice(opening.end), tag);
}

function classContainer(html = '', className = '') {
  const source = String(html || '');
  const escaped = String(className || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>`,
    'i',
  ).exec(source);
  if (!match) return '';
  const bodyStart = match.index + match[0].length;
  const block = extractBalancedTagBlockWithStatus(
    source.slice(bodyStart),
    match[1],
    source.length - bodyStart,
  );
  return block.complete ? block.html : '';
}

function sourceText(html = '') {
  return normalizeSpace(decodeEntities(textOf(html)));
}

function extractPromanInfoValue(html = '', iconSource = '', label = /^$/) {
  const info = classContainer(html, 'u-job-infos');
  for (const opening of scanStartTags(info, 'li')) {
    const block = extractBalancedTagBlock(info.slice(opening.end), 'li');
    if (!block.includes(iconSource)) continue;
    return normalizeSpace(sourceText(block).replace(label, ''));
  }
  return '';
}

/**
 * PROMAN renders each vacancy as an empty overlay anchor followed by the
 * visible heading. The generic template matcher deliberately rejects empty
 * anchors, so pair both source-owned fields inside the same balanced card.
 */
export function extractPromanFleurierListingCandidates(html = '', pageUrl = CAREER_URL) {
  const rows = [];
  const seen = new Set();
  let recognizedCards = 0;
  for (const opening of scanStartTags(html, 'li')) {
    if (!hasClass(opening.raw, 'u-job-item')) continue;
    recognizedCards++;
    const card = extractBalancedTagBlock(html.slice(opening.end), 'li');
    const anchor = scanStartTags(card, 'a').find(({ raw }) => hasClass(raw, 'u-link-fit'));
    const title = sourceText(firstTagBlock(card, 'h3'));
    const href = anchor ? readAttr(anchor.raw, 'href') : '';
    const location = extractPromanInfoValue(card, '24/job/location', /^lieu\s*/i);
    // Use the same source-owned canton evidence as the detail parser. The
    // shared resolver does not know every locality published by this board
    // (for example Fleurier), so resolving only the listing's raw location
    // would drop the card before its detail page can supply the vacancy.
    const decision = resolvePromanDetailGeography({ location });
    const geography = decision.geography;
    const evidenceCandidate = {
      ...decision.candidate,
      location,
      ...(PROMAN_SOURCE_LOCATION_LOCALITIES.has(locationKey(location))
        ? { addressLocality: PROMAN_SOURCE_LOCATION_LOCALITIES.get(locationKey(location)) }
        : {}),
    };
    const fields = geography ? sourceBackedSwissGeographyFields(evidenceCandidate, geography) : null;
    // A broad label such as "Canton de Neuchâtel" identifies the target
    // region but is not a publishable addressLocality. Re-resolve the projected
    // fields so only municipality-level evidence reaches the detail pool.
    const projected = fields ? resolveSourceBackedSwissGeography(fields) : null;
    if (!href || title.length < 3 || projected?.canton !== TARGET_CANTON) continue;
    let url;
    try { url = new URL(href, pageUrl).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({
      title,
      url,
      via: 'proman-listing-card',
      ...fields,
      locationCandidates: [fields],
    });
  }
  // `null` tells the shared crawler that this page no longer matches the
  // source-specific markup, so its generic candidate cascade can still run.
  // An empty array means the markup was recognized and none of its cards is a
  // publishable vacancy; in that case the generic cascade must stay suppressed.
  return recognizedCards ? rows : null;
}

function extractPromanDetailMarkup(html = '') {
  const title = sourceText(firstTagBlock(html, 'h1'));
  const location = extractPromanInfoValue(html, '24/job/location', /^lieu\s*/i);
  const employmentType = extractPromanInfoValue(html, '24/job/type', /^Type de poste\s*/i);
  const intro = bodyTextOf(classContainer(html, 'u-intro'));
  const specs = bodyTextOf(classContainer(html, 'u-specs'));
  const description = [intro, specs].filter(Boolean).join('\n');
  const published = sourceText(firstTagBlock(html, 'p', (raw) => hasClass(raw, 'u-date')))
    .match(/(\d{1,2}\.\d{1,2}\.\d{4})/)?.[1] || '';
  return {
    title,
    description,
    location,
    employmentType,
    ...sourcePostingDateFields(parseSwissShortDate(published)),
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
  const generic = extractDetailFields(html, pageUrl);
  const source = extractPromanDetailMarkup(html);
  const detail = {
    ...generic,
    title: source.title || generic.title,
    description: isSufficientVacancyDescription(generic.description)
      && generic.description.length >= source.description.length
      ? generic.description
      : (source.description || generic.description),
    location: source.location || generic.location,
    employmentType: source.employmentType || generic.employmentType,
    ...mergeSourcePostingDates(generic, source),
  };
  const decision = resolvePromanDetailGeography(detail);
  if (!decision.geography) return emptyDetail(detail);

  if (decision.geography.canton !== TARGET_CANTON) {
    return emptyDetail(detail, decision.geography.canton);
  }

  const sourceLocationKey = locationKey(detail.location);
  const evidenceCandidate = {
    ...decision.candidate,
    ...(PROMAN_SOURCE_LOCATION_LOCALITIES.has(sourceLocationKey)
      ? { addressLocality: PROMAN_SOURCE_LOCATION_LOCALITIES.get(sourceLocationKey) }
      : {}),
  };
  const fields = sourceBackedSwissGeographyFields(evidenceCandidate, decision.geography);
  return {
    ...detail,
    ...fields,
    ...(sourceLocationKey === 'canton de neuchatel' ? { addressLocality: '' } : {}),
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
    listingExtractor: extractPromanFleurierListingCandidates,
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
