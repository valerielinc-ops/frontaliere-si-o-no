#!/usr/bin/env node
/**
 * Fondation Asile des aveugles — official careers-platform crawler.
 *
 * Employer careers page: https://asiledesaveugles.ch/la-fondation/carrieres/
 * Official eRecruit board: https://emploi.ophtalmique.ch/?page=advertisement
 *
 * The employer page is fetched on every run and must still link to the board.
 * Vacancy identity, title, copy, workload, contract and workplace then come
 * from the board itself. No marketplace or employer-HQ fallback can create a
 * posting that is absent from the official open-vacancy table.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, normalizeSpace, slugify } from './crawler-template.mjs';
import { bodyTextOf } from './prospector/extract.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';

export const ASILE_DES_AVEUGLES_SOURCE_SPEC = JSON.parse(readFileSync(
  new URL('../../data/prospector/crawlers/asile-des-aveugles.json', import.meta.url),
  'utf8',
));

export const ASILE_DES_AVEUGLES_KEY = 'asile-des-aveugles';
if (ASILE_DES_AVEUGLES_SOURCE_SPEC.companyKey !== ASILE_DES_AVEUGLES_KEY) {
  throw new Error(`Asile des aveugles source spec companyKey drifted from ${ASILE_DES_AVEUGLES_KEY}`);
}

export const ASILE_DES_AVEUGLES_COMPANY_NAME = ASILE_DES_AVEUGLES_SOURCE_SPEC.companyName;
export const ASILE_DES_AVEUGLES_COMPANY_DOMAIN = ASILE_DES_AVEUGLES_SOURCE_SPEC.companyHost;
export const ASILE_DES_AVEUGLES_CAREERS_URL = ASILE_DES_AVEUGLES_SOURCE_SPEC.careersUrl;
export const ASILE_DES_AVEUGLES_LISTING_URL = ASILE_DES_AVEUGLES_SOURCE_SPEC.seedUrls[0];

const PLATFORM_HOST = ASILE_DES_AVEUGLES_SOURCE_SPEC.platformHost;
const SOURCE_LOCATION = ASILE_DES_AVEUGLES_SOURCE_SPEC.location;
const SOURCE_LANG = ASILE_DES_AVEUGLES_SOURCE_SPEC.sourceLang;

function fold(value = '') {
  return normalizeSpace(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isHostOrSubdomain(host, parent) {
  return host === parent || host.endsWith(`.${parent}`);
}

/** Trust only the employer and the platform linked by its careers page. */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (isHostOrSubdomain(host, ASILE_DES_AVEUGLES_COMPANY_DOMAIN)
        || isHostOrSubdomain(host, PLATFORM_HOST));
  } catch {
    return false;
  }
}

function requireOfficialUrl(rawUrl, baseUrl) {
  let url;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    throw new Error(`Asile des aveugles source returned an invalid URL: ${String(rawUrl || '')}`);
  }
  if (!isTrustedDomain(url.href)) {
    throw new Error(`Asile des aveugles source returned a non-official URL: ${url.origin}`);
  }
  url.hash = '';
  return url;
}

function detailIdentity(rawUrl, baseUrl = ASILE_DES_AVEUGLES_LISTING_URL) {
  const url = requireOfficialUrl(rawUrl, baseUrl);
  const id = url.searchParams.get('id') || '';
  if (url.hostname !== PLATFORM_HOST
    || url.pathname !== '/'
    || url.searchParams.get('page') !== 'advertisement_display'
    || !/^\d+$/.test(id)) {
    throw new Error('Asile des aveugles vacancy URL no longer matches the official detail contract');
  }
  return { id, url: url.href };
}

function applyIdentity(rawUrl, expectedId, baseUrl = ASILE_DES_AVEUGLES_LISTING_URL) {
  const url = requireOfficialUrl(rawUrl, baseUrl);
  if (url.hostname !== PLATFORM_HOST
    || url.pathname !== '/'
    || url.searchParams.get('page') !== 'personal_information'
    || url.searchParams.get('rrid') !== expectedId) {
    throw new Error(`Asile des aveugles application URL does not match vacancy ${expectedId}`);
  }
  return url.href;
}

export function isAsileDesAveuglesTargetTitle(title = '') {
  return /^assistant(?: e)? en soins et sante communautaire$/.test(fold(title));
}

/** Prove that the official employer page still delegates vacancies to this ATS. */
export function extractAsileOfficialPlatform(careersHtml = '', pageUrl = ASILE_DES_AVEUGLES_CAREERS_URL) {
  const page = requireOfficialUrl(pageUrl, ASILE_DES_AVEUGLES_CAREERS_URL);
  if (!isHostOrSubdomain(page.hostname, ASILE_DES_AVEUGLES_COMPANY_DOMAIN)) {
    throw new Error('Asile des aveugles careers proof did not come from the employer domain');
  }
  const dom = new JSDOM(String(careersHtml || ''), { url: page.href });
  try {
    const links = [...dom.window.document.querySelectorAll('a[href]')];
    for (const anchor of links) {
      let candidate;
      try {
        candidate = new URL(anchor.getAttribute('href') || '', page.href);
      } catch {
        continue;
      }
      if (candidate.hostname === PLATFORM_HOST
        && candidate.protocol === 'https:'
        && candidate.pathname === '/'
        && candidate.searchParams.get('page') === 'advertisement') {
        return candidate.href;
      }
    }
    throw new Error('Asile des aveugles careers page no longer links its official employment platform');
  } finally {
    dom.window.close();
  }
}

/** Read the official employer address published on the same careers page. */
export function extractAsileOfficialAddress(careersHtml = '') {
  const dom = new JSDOM(String(careersHtml || ''));
  try {
    const text = normalizeSpace(dom.window.document.body?.textContent || '');
    const match = /Avenue de France\s*15\s*1004\s+Lausanne/i.exec(text);
    if (!match) {
      throw new Error('Asile des aveugles careers page no longer proves the Lausanne address');
    }
    return {
      streetAddress: 'Avenue de France 15',
      postalCode: '1004',
      addressLocality: 'Lausanne',
      addressRegion: 'VD',
      addressCountry: 'CH',
    };
  } finally {
    dom.window.close();
  }
}

/** Extract titled rows, detail identity and the matching official apply URL. */
export function extractAsileListingRows(html = '', pageUrl = ASILE_DES_AVEUGLES_LISTING_URL) {
  const listingUrl = requireOfficialUrl(pageUrl, ASILE_DES_AVEUGLES_LISTING_URL);
  if (listingUrl.hostname !== PLATFORM_HOST
    || listingUrl.searchParams.get('page') !== 'advertisement') {
    throw new Error('Asile des aveugles listing did not come from the official employment platform');
  }
  const dom = new JSDOM(String(html || ''), { url: listingUrl.href });
  try {
    const table = dom.window.document.querySelector('table.tablelist');
    if (!table) {
      throw new Error('Asile des aveugles official vacancy table was not found; refusing an unproven zero');
    }
    const rows = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const detailAnchor = row.querySelector('a[href*="page=advertisement_display"][href*="id="]');
      if (!detailAnchor) continue;
      const title = normalizeSpace(detailAnchor.textContent || '');
      if (!title) continue;
      const detail = detailIdentity(detailAnchor.getAttribute('href') || '', listingUrl.href);
      const isTarget = isAsileDesAveuglesTargetTitle(title);
      const applyAnchor = isTarget
        ? row.querySelector(`a[href*="page=personal_information"][href*="rrid=${detail.id}"]`)
        : null;
      if (isTarget && !applyAnchor) {
        throw new Error(`Asile des aveugles vacancy ${detail.id} has no matching official application handoff`);
      }
      const cells = [...row.querySelectorAll('th, td')];
      rows.push({
        sourceId: detail.id,
        title,
        url: detail.url,
        applyUrl: isTarget
          ? applyIdentity(applyAnchor.getAttribute('href') || '', detail.id, listingUrl.href)
          : '',
        contractLabel: normalizeSpace(cells[1]?.textContent || ''),
      });
    }
    if (rows.length === 0) {
      throw new Error('Asile des aveugles official vacancy table has no recognized detail rows; refusing an unproven zero');
    }
    return rows;
  } finally {
    dom.window.close();
  }
}

export function sanitizeAsileDescription(rawText = '') {
  const withoutContactBlock = String(rawText || '').replace(/\n?Renseignements\s*:[\s\S]*$/iu, '').trim();
  return stripContactPII(withoutContactBlock);
}

/** Validate the official detail body before it can become a published row. */
export function parseAsileDetailPage(html = '', detailUrl = '', expectedTitle = '') {
  const identity = detailIdentity(detailUrl);
  const dom = new JSDOM(String(html || ''), { url: identity.url });
  try {
    const document = dom.window.document;
    const title = normalizeSpace(
      document.querySelector('.title-container h2')?.textContent
        || document.querySelector('#advert h1')?.textContent
        || '',
    );
    if (!isAsileDesAveuglesTargetTitle(title)
      || (expectedTitle && fold(title) !== fold(expectedTitle))) {
      throw new Error('Asile des aveugles detail does not prove the requested ASSC role');
    }

    const advert = document.querySelector('#advert');
    const description = sanitizeAsileDescription(bodyTextOf(advert?.innerHTML || ''));
    if (!advert || !meetsSourceBodyFloor(description)) {
      throw new Error('Asile des aveugles detail body is missing or below the shared 50-word source floor');
    }

    const locationMatch = /(?:^|\n)Lieu de travail\s*:\s*([^\n]+)/iu.exec(description);
    const location = normalizeSpace(locationMatch?.[1] || '');
    if (!location || !/\bLausanne\b/i.test(location)) {
      throw new Error('Asile des aveugles detail has no source-backed Lausanne workplace');
    }
    const canton = inferSwissTargetCanton(location);
    if (canton !== SOURCE_LOCATION.canton) {
      throw new Error('Asile des aveugles source-backed workplace no longer resolves to VD');
    }

    const workload = /(?:^|\n)Taux d['’]activité\s*:\s*([^\n]+)/iu.exec(description)?.[1] || '';
    const contract = /(?:^|\n)Nature du contrat\s*:\s*([^\n]+)/iu.exec(description)?.[1] || '';
    if (!/^100\s*%$/.test(normalizeSpace(workload)) || !/^CDI$/i.test(normalizeSpace(contract))) {
      throw new Error('Asile des aveugles detail no longer proves a 100% CDI contract');
    }

    return {
      sourceId: identity.id,
      title,
      description,
      location,
      canton,
      workload: normalizeSpace(workload),
      contract: normalizeSpace(contract),
    };
  } finally {
    dom.window.close();
  }
}

function buildAsileJob(listing, detail, address, now = new Date()) {
  if (detail.sourceId !== listing.sourceId) {
    throw new Error('Asile des aveugles listing/detail identity mismatch');
  }
  const sourceLang = detectLang(`${detail.title} ${detail.description}`, SOURCE_LANG);
  const slug = slugify(`${detail.title} fondation asile des aveugles lausanne`);
  return {
    id: `${ASILE_DES_AVEUGLES_KEY}-${detail.sourceId}`,
    slug,
    slugByLocale: { [sourceLang]: slug },
    company: ASILE_DES_AVEUGLES_COMPANY_NAME,
    companyKey: ASILE_DES_AVEUGLES_KEY,
    companyDomain: ASILE_DES_AVEUGLES_COMPANY_DOMAIN,
    hiringOrganizationName: ASILE_DES_AVEUGLES_COMPANY_NAME,
    title: detail.title,
    titleByLocale: { [sourceLang]: detail.title },
    description: detail.description,
    descriptionByLocale: { [sourceLang]: detail.description },
    needsRetranslation: true,
    location: detail.location,
    canton: detail.canton,
    url: listing.url,
    applyUrl: listing.applyUrl,
    source: 'Fondation Asile des aveugles official careers platform (emploi.ophtalmique.ch)',
    sourceLang,
    crawledAt: now.toISOString(),
    ...address,
    country: 'CH',
    category: 'Sanità / Ospedali',
    sector: 'Sanità / Ospedali',
    contract: 'full-time',
    employmentType: 'FULL_TIME',
    experienceLevel: 'junior',
    currency: 'CHF',
    featured: false,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    ...sourcePostingDateFields('', now),
    careerSiteUrl: ASILE_DES_AVEUGLES_CAREERS_URL,
  };
}

export function isAsileDesAveuglesJob(job) {
  return fold(job?.companyKey || '') === fold(ASILE_DES_AVEUGLES_KEY)
    || fold(job?.company || '') === fold(ASILE_DES_AVEUGLES_COMPANY_NAME);
}

/** Fetch only the target ASSC vacancy after proving the complete official chain. */
export async function fetchAllAsileDesAveuglesJobs(runtime = {}) {
  const fetchPage = typeof runtime.fetchPage === 'function'
    ? runtime.fetchPage
    : (url) => fetchHtml(url, { validateRedirectUrl: isTrustedDomain, maxRedirects: 4 });

  console.log(`Fetching ${ASILE_DES_AVEUGLES_COMPANY_NAME} ASSC jobs`);
  const careersHtml = await fetchPage(ASILE_DES_AVEUGLES_CAREERS_URL);
  const listingUrl = extractAsileOfficialPlatform(careersHtml, ASILE_DES_AVEUGLES_CAREERS_URL);
  const address = extractAsileOfficialAddress(careersHtml);
  const listingHtml = await fetchPage(listingUrl);
  const rows = extractAsileListingRows(listingHtml, listingUrl);
  const targets = rows.filter((row) => isAsileDesAveuglesTargetTitle(row.title));

  if (targets.length === 0) {
    return markAuthoritativeEmptySnapshot(
      [],
      `Asile des aveugles official vacancy table exposed ${rows.length} titled rows and no matching ASSC role`,
    );
  }

  const now = runtime.now instanceof Date ? runtime.now : new Date();
  const jobs = [];
  for (const listing of targets) {
    const detailHtml = await fetchPage(listing.url);
    const detail = parseAsileDetailPage(detailHtml, listing.url, listing.title);
    jobs.push(buildAsileJob(listing, detail, address, now));
  }
  console.log(`   Official vacancies: ${rows.length}; source-backed oss:VD jobs: ${jobs.length}`);
  return jobs;
}
