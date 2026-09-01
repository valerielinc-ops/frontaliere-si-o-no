#!/usr/bin/env node
/**
 * Cippà Trasporti SA job parser — Fetcher and job builder.
 *
 * Source: https://cippatrasporti.altamiraweb.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCippatrasportiJobs()  — Fetch and parse all jobs
 *   - isCippatrasportiJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml } from './crawler-template.mjs';
import { isSufficientVacancyDescription } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CIPPATRASPORTI_KEY = 'cippatrasporti';
export const CIPPATRASPORTI_COMPANY_NAME = 'Cippà Trasporti SA';
export const CIPPATRASPORTI_COMPANY_DOMAIN = 'cippatrasporti.altamiraweb.com';

export const CIPPATRASPORTI_CAREER_URL = 'https://cippatrasporti.altamiraweb.com/';
export const CIPPATRASPORTI_MAX_LISTINGS = 50;
export const CIPPATRASPORTI_DETAIL_CONCURRENCY = 3;

const DETAIL_PATH_RE = /^\/annunci-lavoro\/[^/]+\.htm$/i;
const SNAPSHOT_STATE = 'complete-altamira-inventory';
const SOURCE_IDENTITY_RE = /cipp[aà]\s+trasporti\s+s\.?a\.?/i;
const MIN_DESCRIPTION_WORDS = 50;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeIdentity(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isoDateFromItalian(value = '') {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(normalizeSpace(value));
  if (!match) return '';
  const [, day, month, year] = match;
  const candidate = `${year}-${month}-${day}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : '';
}

function assertCippatrasportiSourceUrl(rawUrl = '', expectedPath = '') {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Cippà Trasporti: invalid source URL (${rawUrl})`);
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== CIPPATRASPORTI_COMPANY_DOMAIN
    || url.port
    || url.username
    || url.password
    || url.hash
    || url.search
    || (expectedPath && url.pathname !== expectedPath)
  ) {
    throw new Error(`Cippà Trasporti: source URL escaped the approved boundary (${url.href})`);
  }
  return url;
}

async function fetchCippatrasportiPage(url, {
  fetchPage = fetchHtml,
  timeoutMs = 20000,
} = {}) {
  const expected = assertCippatrasportiSourceUrl(url);
  return fetchPage(expected.href, {
    timeoutMs,
    validateRedirectUrl: (redirectUrl) => assertCippatrasportiSourceUrl(redirectUrl, expected.pathname),
  });
}

function findJobPosting(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.includes('JobPosting')) return value;
  for (const child of Object.values(value)) {
    const found = findJobPosting(child);
    if (found) return found;
  }
  return null;
}

function schemaText(value = '') {
  if (typeof value === 'string') return normalizeSpace(value);
  if (Array.isArray(value)) return schemaText(value[0]);
  if (value && typeof value === 'object') return schemaText(value.name || value['@value'] || value.value || '');
  return '';
}

function markCompleteSnapshot(jobs, discoveredCount) {
  Object.defineProperties(jobs, {
    cippatrasportiSnapshotState: { value: SNAPSHOT_STATE, enumerable: false },
    discoveredCount: { value: discoveredCount, enumerable: false },
  });
  return jobs;
}

export function assertCompleteCippatrasportiSnapshot(jobs) {
  if (
    !Array.isArray(jobs)
    || Reflect.get(jobs, 'cippatrasportiSnapshotState') !== SNAPSHOT_STATE
    || Reflect.get(jobs, 'discoveredCount') !== jobs.length
  ) {
    throw new Error('Cippà Trasporti snapshot is not a proven complete Altamira inventory');
  }
  return true;
}

/**
 * Parse only the authoritative Altamira grid. A valid, branded grid with no
 * data rows proves source zero; missing headers or malformed rows are parser
 * errors and must preserve the existing slice.
 */
export function parseCippatrasportiListingPage(html = '', pageUrl = CIPPATRASPORTI_CAREER_URL) {
  assertCippatrasportiSourceUrl(pageUrl, '/');
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    const title = normalizeSpace(document.title || '');
    const heading = normalizeSpace(document.querySelector('.adtitle h1')?.textContent || '');
    const table = document.querySelector('table.GRID');
    const headers = table
      ? [...table.querySelectorAll('tr.GRID_HDR_ROW [data-title]')]
        .map((node) => normalizeIdentity(node.getAttribute('data-title') || node.textContent || ''))
      : [];
    const requiredHeaders = ['titolo', 'data di pubblicazione', 'sedi', 'business unit'];
    if (
      !SOURCE_IDENTITY_RE.test(title)
      || normalizeIdentity(heading) !== 'posizioni aperte'
      || !table
      || requiredHeaders.some((header) => !headers.includes(header))
    ) {
      throw new Error('Cippà Trasporti: authoritative listing boundary missing or unbranded');
    }

    const rows = [...table.querySelectorAll('tr.GRID_DAT_ROW, tr.GRID_DAT_ROW_Alter')];
    if (rows.length > CIPPATRASPORTI_MAX_LISTINGS) {
      throw new Error(`Cippà Trasporti: listing count ${rows.length} exceeds bounded cap ${CIPPATRASPORTI_MAX_LISTINGS}`);
    }
    const listings = rows.map((row, index) => {
      const link = row.querySelector('td.titleCell a[href]');
      const titleText = normalizeSpace(link?.textContent || link?.getAttribute('aria-label') || '');
      const rawHref = link?.getAttribute('href') || '';
      const location = normalizeSpace(row.querySelector('[data-title="Sedi"]')?.textContent || '');
      const businessUnit = normalizeSpace(row.querySelector('[data-title="Business unit"]')?.textContent || '');
      const postedDate = isoDateFromItalian(
        row.querySelector('[data-title="Data di pubblicazione"]')?.textContent || '',
      );
      let url;
      try {
        url = new URL(rawHref, CIPPATRASPORTI_CAREER_URL);
        assertCippatrasportiSourceUrl(url.href);
      } catch {
        throw new Error(`Cippà Trasporti: malformed listing row ${index + 1} (invalid URL)`);
      }
      if (!titleText || !DETAIL_PATH_RE.test(url.pathname) || !location || !businessUnit || !postedDate) {
        throw new Error(`Cippà Trasporti: malformed listing row ${index + 1}`);
      }
      return { title: titleText, url: url.href, location, businessUnit, postedDate };
    });
    if (new Set(listings.map((listing) => listing.url)).size !== listings.length) {
      throw new Error('Cippà Trasporti: duplicate detail URL in authoritative listing');
    }
    return listings;
  } finally {
    dom.window.close();
  }
}

/** Parse and validate one source-backed Altamira JobPosting detail. */
export function parseCippatrasportiDetailPage(html = '', pageUrl = '', listing = {}) {
  const sourceUrl = assertCippatrasportiSourceUrl(pageUrl);
  if (!DETAIL_PATH_RE.test(sourceUrl.pathname)) {
    throw new Error(`Cippà Trasporti: unsupported detail path (${sourceUrl.pathname})`);
  }
  const dom = new JSDOM(String(html || ''));
  try {
    const scripts = [...dom.window.document.querySelectorAll('script[type="application/ld+json"]')];
    let jobPosting = null;
    let malformedJobPosting = false;
    for (const script of scripts) {
      const source = script.textContent || '';
      try {
        jobPosting ||= findJobPosting(JSON.parse(source));
      } catch {
        if (/"@type"\s*:\s*"JobPosting"/i.test(source)) malformedJobPosting = true;
      }
    }
    if (!jobPosting) {
      throw new Error(`Cippà Trasporti: ${malformedJobPosting ? 'malformed' : 'missing'} JobPosting JSON-LD`);
    }

    const title = schemaText(jobPosting.title || jobPosting.name);
    const description = stripHtml(schemaText(jobPosting.description));
    const organization = schemaText(jobPosting.hiringOrganization);
    const locationNode = Array.isArray(jobPosting.jobLocation) ? jobPosting.jobLocation[0] : jobPosting.jobLocation;
    const address = locationNode?.address || locationNode || {};
    const location = schemaText(address.addressLocality || address.name);
    const addressRegion = schemaText(address.addressRegion);
    const addressCountry = schemaText(address.addressCountry);
    const postalCode = schemaText(address.postalCode);
    const streetAddress = schemaText(address.streetAddress);
    const detailPostedDate = String(jobPosting.datePosted || '').slice(0, 10);
    const postedDate = detailPostedDate || listing.postedDate || '';

    if (!SOURCE_IDENTITY_RE.test(organization)) {
      throw new Error('Cippà Trasporti: JobPosting hiring organization is missing or foreign');
    }
    if (!title || (listing.title && normalizeIdentity(title) !== normalizeIdentity(listing.title))) {
      throw new Error('Cippà Trasporti: detail title does not match the authoritative listing');
    }
    if (
      !isSufficientVacancyDescription(description)
      || description.split(/\s+/).filter(Boolean).length < MIN_DESCRIPTION_WORDS
    ) {
      throw new Error(`Cippà Trasporti: source-backed detail description is thin for ${sourceUrl.href}`);
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(postedDate)
      || (detailPostedDate && listing.postedDate && detailPostedDate !== listing.postedDate)
    ) {
      throw new Error(`Cippà Trasporti: detail date disagrees with the authoritative listing for ${sourceUrl.href}`);
    }
    const listingGeography = resolveSourceBackedSwissGeography(listing.location);
    const geography = resolveSourceBackedSwissGeography({
      location: location || listing.location,
      addressLocality: location || listing.location,
      addressRegion,
      addressCountry,
      postalCode,
      streetAddress,
    });
    if (
      !geography
      || !listingGeography
      || geography.canton !== listingGeography.canton
      || normalizeIdentity(geography.location) !== normalizeIdentity(listingGeography.location)
    ) {
      throw new Error(`Cippà Trasporti: source-backed Swiss geography is missing or contradictory for ${sourceUrl.href}`);
    }
    return {
      title,
      description,
      location: geography.location,
      canton: geography.canton,
      addressLocality: location || geography.location,
      addressRegion: addressRegion || geography.canton,
      addressCountry: addressCountry || geography.addressCountry || 'CH',
      country: addressCountry || geography.addressCountry || 'CH',
      ...(postalCode ? { postalCode } : {}),
      ...(streetAddress ? { streetAddress } : {}),
      postedDate,
      employmentType: schemaText(jobPosting.employmentType),
    };
  } finally {
    dom.window.close();
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Cippà Trasporti SA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCippatrasportiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CIPPATRASPORTI_KEY ||
    key.startsWith('cippatrasporti') ||
    company.includes('cippà trasporti sa') ||
    url.includes('cippatrasporti.altamiraweb.com')
  );
}

/**
 * Validate that a URL belongs to Cippà Trasporti SA's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'cippatrasporti.altamiraweb.com' || host.endsWith('.cippatrasporti.altamiraweb.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(logist|freight|transport|spedizion|warehouse|magazz|lager)/.test(t)) return 'Logistica';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetcher guidato dalla spec ───────────────────────────────
 * The branded listing grid and every JobPosting detail form one bounded,
 * source-backed inventory; no generic extraction or fabricated fallback.
 */
/**
 * Fetch all Cippà Trasporti SA jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCippatrasportiJobs({
  fetchPage = fetchHtml,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  detailConcurrency = CIPPATRASPORTI_DETAIL_CONCURRENCY,
} = {}) {
  console.log(`🔍 Fetching Cippà Trasporti SA jobs`);
  console.log(`   Source: ${CIPPATRASPORTI_CAREER_URL}\n`);

  const listingHtml = await fetchCippatrasportiPage(CIPPATRASPORTI_CAREER_URL, {
    fetchPage,
    timeoutMs: 20000,
  });
  const listings = parseCippatrasportiListingPage(listingHtml, CIPPATRASPORTI_CAREER_URL);
  if (listings.length === 0) {
    console.log('  ✅ Authoritative Altamira grid reports zero open positions.');
    return markCompleteSnapshot([], 0);
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = new Array(listings.length);
  let next = 0;
  const concurrency = Math.max(1, Math.min(
    CIPPATRASPORTI_DETAIL_CONCURRENCY,
    Number(detailConcurrency) || CIPPATRASPORTI_DETAIL_CONCURRENCY,
  ));
  const worker = async () => {
    while (next < listings.length) {
      const index = next++;
      const listing = listings[index];
      const detailHtml = await fetchCippatrasportiPage(listing.url, {
        fetchPage,
        timeoutMs: 20000,
      });
      const detail = parseCippatrasportiDetailPage(detailHtml, listing.url, listing);
      const title = detail.title;
      const descriptionText = detail.description;
      const publicUrl = listing.url;
      const sourceLang = detectLang(descriptionText || title, 'it');
      const jobSlug = slugify(`${title} cippatrasporti ch`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      jobs[index] = {
        id: `cippatrasporti-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: CIPPATRASPORTI_COMPANY_NAME,
        companyKey: CIPPATRASPORTI_KEY,
        companyDomain: CIPPATRASPORTI_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText,
        descriptionByLocale: { [sourceLang]: descriptionText },
        location: detail.location,
        canton: detail.canton,
        url: publicUrl,
        source: 'Cippà Trasporti SA Dedicated Parser',
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: detail.addressLocality,
        addressRegion: detail.addressRegion,
        addressCountry: detail.addressCountry,
        country: detail.country,
        ...(detail.postalCode ? { postalCode: detail.postalCode } : {}),
        ...(detail.streetAddress ? { streetAddress: detail.streetAddress } : {}),
        category: detectCategory(`${title} ${listing.businessUnit}`),
        contract: 'full-time',
        employmentType: detectEmploymentType(detail.employmentType || title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Logistica e trasporti',
        currency: 'CHF',
        featured: false,
        postedDate: detail.postedDate,
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };
      await sleep(300);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, listings.length) }, worker));

  console.log(`\n📋 Total Cippà Trasporti SA jobs discovered: ${jobs.length}`);
  return markCompleteSnapshot(jobs, listings.length);
}
