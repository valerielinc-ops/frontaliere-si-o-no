#!/usr/bin/env node
/**
 * Technic Emplois SA job parser.
 *
 * The employer's official vacancy page embeds the Jobeo tenant at
 * https://blog.jobeo.ch/technicemploi/. The tenant page is the source-backed
 * listing surface; every discovered detail URL is still fetched and checked
 * before a job is published.
 */
import { createHash } from 'node:crypto';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { extractLinks } from './prospector/careers-trail.mjs';
import { extractJsonLd } from './prospector/extract.mjs';
import { extractRuntimeDetailFields } from './prospector/detail-extract.mjs';
import {
  fetchHtmlViaBrowser,
  fetchRuntimePage,
  loadSpec,
  createSpecUrlPolicy,
} from './prospector/spec-crawler.mjs';
import {
  resolveDetailOrListingSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { mapPool } from './prospector/polite-fetch.mjs';
import { readAttr, scanStartTags } from './html-attr.mjs';

export const TECHNIC_EMPLOIS_KEY = 'technic-emplois';
export const TECHNIC_EMPLOIS_COMPANY_NAME = 'Technic Emplois SA';
export const TECHNIC_EMPLOIS_COMPANY_DOMAIN = 'technic-emplois.ch';
export const TECHNIC_EMPLOIS_OFFICIAL_URL = 'https://technic-emplois.ch/offre-demploi/';

const OFFICIAL_HOST = 'technic-emplois.ch';
const OFFICIAL_WIDGET_HOST = 'blog.jobeo.ch';
const OFFICIAL_WIDGET_PATH = '/technicemploi';
const JOBEO_HOST = 'jobeo.ch';
const DEFAULT_WIDGET_URL = 'https://blog.jobeo.ch/technicemploi/';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}
function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCompany(value = '') {
  return normalize(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameOrSubdomain(host, domain) {
  const value = String(host || '').toLowerCase();
  return value === domain || value.endsWith(`.${domain}`);
}

function canonicalUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function isOfficialUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return sameOrSubdomain(url.hostname, OFFICIAL_HOST);
  } catch {
    return false;
  }
}

function isOfficialWidgetUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === OFFICIAL_WIDGET_HOST
      && url.pathname.replace(/\/+$/, '').toLowerCase() === OFFICIAL_WIDGET_PATH;
  } catch {
    return false;
  }
}

function isJobeoHost(host = '') {
  return sameOrSubdomain(host, JOBEO_HOST);
}

/**
 * Jobeo has used more than one public detail path over time. The path must
 * still identify an employment page; accepting every Jobeo URL would leak
 * blog, account and navigation links from the embedded tenant.
 */
export function isTechnicDetailUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    if (!isJobeoHost(url.hostname)) return false;
    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!path || path === OFFICIAL_WIDGET_PATH) return false;
    return path.split('/').filter(Boolean).length >= 2
      && /\/(?:offre|offres|emploi|emplois|job|jobs|candidat|postul|vacan|recrut)/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Check if a job belongs to the Technic Emplois slice.
 */
export function isTechnicEmploisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalizeCompany(job?.company || '');
  const url = String(job?.url || '');
  return key === TECHNIC_EMPLOIS_KEY
    || key.startsWith(`${TECHNIC_EMPLOIS_KEY}-`)
    || company.includes('technic emplois')
    || isOfficialUrl(url);
}

/**
 * Trusted source URLs are the employer's official site and the Jobeo host
 * explicitly embedded by that site. Aggregator domains are intentionally not
 * accepted as a fallback.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return sameOrSubdomain(host, OFFICIAL_HOST) || isJobeoHost(host);
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const value = normalize(title);
  if (/\b(soudeur|soudeuse|soudage|tuyauteur|tuyauterie|electric|electri|cv[cs]|techni|mecan|maintenance|install)/.test(value)) {
    return 'Tecnica';
  }
  if (/\b(admin|secre|compt|contab|buchhalt)/.test(value)) return 'Amministrazione';
  if (/\b(logist|magasin|entrep|warehouse)/.test(value)) return 'Logistica';
  if (/\b(commercial|vente|sales|verkauf)/.test(value)) return 'Commerciale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const value = normalize(title);
  if (/\b(junior|jr|debutant|apprenti|apprentie|stagiaire)/.test(value)) return 'junior';
  if (/\b(senior|sr|chef|responsable|lead|directeur|directrice)/.test(value)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const value = normalize(text);
  if (/\b(part.?time|temps partiel|teilzeit|50\s*%|80\s*%)/.test(value)) return 'PART_TIME';
  if (/\b(full.?time|temps plein|vollzeit|100\s*%)/.test(value)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Read only the iframe that the official page assigns to the Technic tenant.
 * A generic iframe/first-link fallback would make the crawler follow an
 * unrelated embedded asset when the page layout changes.
 */
export function extractOfficialWidgetUrl(html = '', baseUrl = TECHNIC_EMPLOIS_OFFICIAL_URL) {
  for (const tag of scanStartTags(html, 'iframe')) {
    const rawSrc = readAttr(tag.raw, 'src');
    if (!rawSrc) continue;
    let absolute;
    try { absolute = new URL(rawSrc, baseUrl).toString(); } catch { continue; }
    if (isOfficialWidgetUrl(absolute)) return canonicalUrl(absolute);
  }
  return '';
}

function addCandidate(byUrl, candidate, sourceUrl) {
  const url = canonicalUrl(candidate?.url || '');
  if (!isTechnicDetailUrl(url) || byUrl.has(url)) return;
  const title = normalizeSpace(candidate?.title || candidate?.text || '');
  byUrl.set(url, {
    title: title.length >= 3 ? title.slice(0, 180) : '',
    url,
    sourceUrl,
    company: normalizeSpace(candidate?.company || ''),
    location: normalizeSpace(candidate?.location || ''),
    description: candidate?.description || '',
    locationCandidates: Array.isArray(candidate?.locationCandidates)
      ? candidate.locationCandidates
      : [],
    ...mergeSourcePostingDates({}, candidate || {}),
  });
}

/**
 * Extract detail URLs from the rendered tenant page. JSON-LD is preferred,
 * while explicit cross-origin anchors/data URLs are accepted only when their
 * Jobeo path identifies a vacancy detail page.
 */
export function extractTechnicEmploisListings(html = '', pageUrl = DEFAULT_WIDGET_URL) {
  const byUrl = new Map();
  for (const candidate of extractJsonLd(html, pageUrl)) {
    addCandidate(byUrl, candidate, pageUrl);
  }
  for (const link of extractLinks(html, pageUrl, { sameOriginOnly: false })) {
    addCandidate(byUrl, { ...link, title: link.text }, pageUrl);
  }
  for (const tag of scanStartTags(html)) {
    const raw = readAttr(tag.raw, ['data-href', 'data-url', 'data-link']);
    if (!raw) continue;
    let absolute;
    try { absolute = new URL(raw, pageUrl).toString(); } catch { continue; }
    addCandidate(byUrl, { url: absolute }, pageUrl);
  }
  return [...byUrl.values()];
}

function pageFromResult(result, requestedUrl) {
  if (typeof result === 'string') return { body: result, url: requestedUrl };
  if (result && typeof result.body === 'string') {
    return { body: result.body, url: result.url || requestedUrl };
  }
  return { body: '', url: requestedUrl };
}

async function fetchSourcePage(url, {
  policy,
  runtime,
  accept,
}) {
  if (typeof runtime.fetchPageImpl === 'function') {
    return pageFromResult(await runtime.fetchPageImpl(url), url);
  }

  const page = await fetchRuntimePage(url, policy, runtime);
  if (accept(page.body, page.url || url)) return page;

  // A 200 JavaScript shell is not evidence of an empty board. Render the same
  // source page once, then apply the identical source-specific acceptance gate.
  const browserFetch = runtime.browserFetchImpl || fetchHtmlViaBrowser;
  if (typeof browserFetch === 'function') {
    const rendered = await browserFetch(url);
    if (typeof rendered === 'string' && rendered.trim() && accept(rendered, url)) {
      return { body: rendered, url };
    }
  }
  return page;
}

async function fetchTechnicPages({ spec, runtime, officialUrl }) {
  const policy = typeof runtime.fetchPageImpl === 'function'
    ? null
    : createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  const pageRuntime = {
    ...runtime,
    browserFetchImpl: runtime.browserFetchImpl || fetchHtmlViaBrowser,
  };
  try {
    const official = await fetchSourcePage(officialUrl, {
      policy,
      runtime: pageRuntime,
      accept: (html, url) => Boolean(extractOfficialWidgetUrl(html, url)),
    });
    const widgetUrl = extractOfficialWidgetUrl(official.body, official.url || officialUrl);
    if (!widgetUrl) return { listings: [], discoveredCount: 0 };

    const widget = await fetchSourcePage(widgetUrl, {
      policy,
      runtime: pageRuntime,
      accept: (html, url) => extractTechnicEmploisListings(html, url).length > 0,
    });
    const listings = extractTechnicEmploisListings(widget.body, widget.url || widgetUrl);
    return { listings, discoveredCount: listings.length };
  } finally {
    await policy?.dispatcher?.close?.().catch(() => {});
  }
}

function buildTechnicJob(listing, detail) {
  const title = normalizeSpace(detail.title || listing.title || '');
  if (title.length < 3) return null;

  const detailCompany = normalizeCompany(detail.company || '');
  if (detailCompany && !detailCompany.includes('technic emplois')) return null;

  const decision = resolveDetailOrListingSwissGeography(detail, listing);
  const geography = decision.geography
    ? sourceBackedSwissGeographyFields(decision.candidate, decision.geography)
    : null;
  if (!geography) return null;

  const description = stripHtml(detail.description || listing.description || '');
  if (!meetsSourceBodyFloor(description)) return null;

  const publicUrl = canonicalUrl(listing.url);
  if (!publicUrl || !isTechnicDetailUrl(publicUrl)) return null;

  const sourceLang = detectLang(description || title, 'fr');
  const employmentType = detectEmploymentType([
    detail.employmentType,
    title,
    description,
  ].filter(Boolean).join(' '));
  const publication = mergeSourcePostingDates(listing, detail);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} ${geography.location} technic emplois ch`);

  return {
    id: `${TECHNIC_EMPLOIS_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: TECHNIC_EMPLOIS_COMPANY_NAME,
    companyKey: TECHNIC_EMPLOIS_KEY,
    companyDomain: TECHNIC_EMPLOIS_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: geography.location,
    canton: geography.canton,
    addressLocality: geography.addressLocality,
    addressRegion: geography.addressRegion,
    ...(geography.addressCountry ? { addressCountry: geography.addressCountry, country: geography.addressCountry } : {}),
    ...(geography.postalCode ? { postalCode: geography.postalCode } : {}),
    ...(geography.streetAddress ? { streetAddress: geography.streetAddress } : {}),
    url: publicUrl,
    source: 'Technic Emplois SA (official site → Jobeo tenant)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    category: detectCategory(title),
    contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Tecnica',
    currency: 'CHF',
    featured: false,
    ...publication,
    postedAt: publication.postedDate || null,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/**
 * Fetch and parse the complete official-source vacancy snapshot.
 *
 * Only source-locale fields are emitted. The standard crawler pipeline owns
 * localization, validation, slug preservation and slice publication.
 */
export async function fetchAllTechnicEmploisJobs({
  spec = loadSpec(TECHNIC_EMPLOIS_KEY),
  runtime = {},
} = {}) {
  const officialUrl = (spec.seedUrls || []).find(isOfficialUrl) || TECHNIC_EMPLOIS_OFFICIAL_URL;
  console.log(`🔍 Fetching ${TECHNIC_EMPLOIS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${officialUrl}\n`);

  const { listings, discoveredCount } = await fetchTechnicPages({ spec, runtime, officialUrl });
  if (!listings.length) {
    console.warn('⚠️ No Technic Emplois detail links returned by the official iframe.');
    const empty = [];
    Object.defineProperties(empty, {
      discoveredCount: { value: discoveredCount, enumerable: false },
      fetchOutcome: { value: 'selector_miss', enumerable: false },
    });
    return empty;
  }

  console.log(`  📋 Detail links found: ${listings.length}`);
  const detailWorkers = Math.max(1, Math.min(4, Number(spec.detailFetchWorkers) || 2));
  const policy = typeof runtime.fetchPageImpl === 'function'
    ? null
    : createSpecUrlPolicy(spec, { lookupImpl: runtime.lookupImpl });
  const pageRuntime = {
    ...runtime,
    browserFetchImpl: runtime.browserFetchImpl || fetchHtmlViaBrowser,
  };
  try {
    const parsed = await mapPool(listings, detailWorkers, async (listing) => {
      const page = await fetchSourcePage(listing.url, {
        policy,
        runtime: pageRuntime,
        accept: (html, url) => {
          const detail = extractRuntimeDetailFields(spec, html, url, { recordUrl: listing.url });
          return Boolean(detail.title || detail.description || detail.locationCandidates?.length);
        },
      });
      const detail = extractRuntimeDetailFields(spec, page.body, page.url || listing.url, {
        recordUrl: listing.url,
      });
      return buildTechnicJob(listing, detail);
    });
    const jobs = parsed.filter(Boolean);
    console.log(`\n📋 Total ${TECHNIC_EMPLOIS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
    Object.defineProperties(jobs, {
      discoveredCount: { value: discoveredCount, enumerable: false },
      fetchOutcome: { value: jobs.length ? 'ok' : 'selector_miss', enumerable: false },
    });
    return jobs;
  } finally {
    await policy?.dispatcher?.close?.().catch(() => {});
  }
}
