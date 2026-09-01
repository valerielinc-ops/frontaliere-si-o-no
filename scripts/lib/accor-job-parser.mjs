#!/usr/bin/env node
/**
 * Ibis Budget job parser — Fetcher and job builder.
 *
 * Source: https://careers.accor.com/fr/fr/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAccorJobs()  — Fetch and parse all jobs
 *   - isAccorJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  extractDetailFields,
  isSufficientVacancyDescription,
} from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { politeFetch } from './prospector/polite-fetch.mjs';
import { createSpecUrlPolicy, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ACCOR_KEY = 'accor';
export const ACCOR_COMPANY_NAME = 'Ibis Budget';
export const ACCOR_COMPANY_DOMAIN = 'careers.accor.com';

const CAREER_URL = 'https://careers.accor.com/fr/fr/jobs?ln=Switzerland&li=CH&page=1';
const ACCOR_MAX_LISTING_PAGES = 20;
const ACCOR_REQUEST_HEADERS = {
  // Node's custom public-DNS dispatcher currently exposes Attrax's Brotli body
  // as compressed bytes instead of decoded HTML. Identity encoding keeps the
  // SSRF-safe socket binding and the shared identifying User-Agent intact.
  'Accept-Encoding': 'identity',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Attrax exposes both the total result count and the selected page size. The
 * semantic last-page control is authoritative when present. Without it, only
 * a complete single-page or zero-result envelope can be published; otherwise
 * stopping at page one would silently retire later jobs.
 */
export function accorPageCount(html = '') {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const lastPageValues = [...doc.querySelectorAll('.attrax-pagination__results-of--2')]
    .map((node) => Number.parseInt(node.textContent || '', 10))
    .filter(Number.isInteger);
  const totalNode = doc.querySelector('.attrax-pagination__total-results');
  const pageSizeNode = doc.querySelector('.attrax-pagination__resultsperpage .active');
  const totalText = totalNode?.textContent || '';
  const totalDigits = totalText.replace(/\D/g, '');
  const totalResults = Number.parseInt(totalDigits, 10);
  const pageSizeLabel = pageSizeNode?.getAttribute('aria-label') || '';
  const pageSize = Number.parseInt(pageSizeLabel, 10);
  dom.window.close();

  const distinctLastPages = [...new Set(lastPageValues)];
  if (distinctLastPages.length > 1) {
    throw new Error(`Accor pagination disagrees on the last page: ${distinctLastPages.join(', ')}`);
  }
  const markerPage = distinctLastPages.length === 1 && distinctLastPages[0] >= 1
    ? distinctLastPages[0]
    : null;
  if (distinctLastPages.length && markerPage === null) {
    throw new Error('Accor pagination has an invalid last-page marker');
  }
  if (Boolean(totalNode) !== Boolean(pageSizeNode)
    || (totalNode && (!Number.isInteger(totalResults) || totalResults < 0
      || !Number.isInteger(pageSize) || pageSize < 1))) {
    throw new Error('Accor pagination has unreadable total or page-size metadata');
  }
  const countPage = totalNode
    ? Math.max(1, Math.ceil(totalResults / pageSize))
    : null;
  if (markerPage !== null) return Math.max(markerPage, countPage || 1);
  if (countPage === 1) return 1;
  throw new Error('Accor pagination is missing a trustworthy last-page marker');
}

export function accorPageUrl(seedUrl, page) {
  const url = new URL(seedUrl);
  url.searchParams.set('page', String(page));
  return url.toString();
}

/**
 * A listing can reorder while it is being walked. Every page up to the
 * greatest source-declared bound is therefore fetched once; a short page and
 * a decreasing later counter never act as an end signal. A missing counter,
 * failed intermediate page, or cap overflow rejects the complete snapshot.
 */
export async function collectAccorPageUrls(
  seedUrl,
  fetchPage,
  maxPages = ACCOR_MAX_LISTING_PAGES,
  pageSnapshots = null,
) {
  let lastPage = 1;
  const pages = [];
  for (let page = 1; page <= lastPage; page += 1) {
    const pageUrl = accorPageUrl(seedUrl, page);
    const fetched = await fetchPage(pageUrl);
    const body = typeof fetched === 'string' ? fetched : fetched?.body;
    if (typeof body !== 'string' || !body) {
      throw new Error(`Accor pagination returned an empty snapshot for ${pageUrl}`);
    }
    const effectiveUrl = typeof fetched === 'string' ? pageUrl : (fetched.url || pageUrl);
    const status = typeof fetched === 'string' ? 200 : Number(fetched.status);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(`Accor pagination returned invalid snapshot status ${status} for ${effectiveUrl}`);
    }
    const declaredLastPage = accorPageCount(body);
    if (declaredLastPage > maxPages) {
      throw new Error(`Accor pagination declares ${declaredLastPage} pages, above the safe limit ${maxPages}`);
    }
    lastPage = Math.max(lastPage, declaredLastPage);
    if (pageSnapshots?.has(effectiveUrl)) {
      throw new Error(`Accor pagination resolved multiple pages to ${effectiveUrl}`);
    }
    pageSnapshots?.set(effectiveUrl, {
      body,
      status,
      contentType: 'text/html; charset=utf-8',
    });
    pages.push(effectiveUrl);
  }
  return pages;
}

function createAccorSnapshotFetch(pageSnapshots, fallbackFetch) {
  return async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input?.url;
    const snapshot = pageSnapshots.get(url);
    if (!snapshot) return fallbackFetch(input, init);
    return new Response(snapshot.body, {
      status: snapshot.status,
      headers: { 'Content-Type': snapshot.contentType },
    });
  };
}

/**
 * Accor/Attrax renders several `job-details__job` widgets around the vacancy.
 * The generic extractor deliberately considers all of them, but joining those
 * candidates makes navigation, metadata and share controls longer than the
 * actual description. Accor exposes one exact semantic boundary, so publish
 * only that body. A missing or degraded widget stays empty and is quarantined
 * by the shared detail-enrichment floor instead of falling back to a teaser.
 *
 * @param {string} html
 * @param {string} pageUrl
 */
export function extractAccorDetailFields(html = '', pageUrl = '') {
  const detail = extractDetailFields(html, pageUrl);
  const dom = new JSDOM(html);
  const descriptionNode = dom.window.document.querySelector(
    '[data-type="DescriptionWidget"] [aria-label="Job description"]',
  );
  const description = normalizeSpace(descriptionNode?.textContent || '');
  dom.window.close();
  return {
    ...detail,
    description: isSufficientVacancyDescription(description) ? description : '',
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Ibis Budget.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAccorJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ACCOR_KEY ||
    key.startsWith('accor') ||
    company.includes('ibis budget') ||
    url.includes('careers.accor.com')
  );
}

/**
 * Validate that a URL belongs to Ibis Budget's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careers.accor.com' || host.endsWith('.careers.accor.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
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
 * Spec: data/prospector/crawlers/{key}.json — seed, modalita' di estrazione e
 * template degli URL di dettaglio, appresi dalla pagina reale.
 */
async function fetchJobListings({ fetchImpl = fetch } = {}) {
  const spec = loadSpec(ACCOR_KEY);
  const seedUrl = spec.seedUrls?.[0];
  if (!seedUrl || spec.seedUrls.length !== 1) {
    throw new Error('Accor requires exactly one Swiss listing seed for dynamic pagination');
  }
  const urlPolicy = createSpecUrlPolicy(spec);
  try {
    const pageSnapshots = new Map();
    const seedUrls = await collectAccorPageUrls(seedUrl, async (url) => {
      const page = await politeFetch(url, {
        urlPolicy,
        dispatcher: urlPolicy.dispatcher,
        headers: ACCOR_REQUEST_HEADERS,
      });
      if (!page.ok || !page.body) {
        const reason = page.blockedByRobots ? 'blocked by robots.txt'
          : page.policyBlocked ? (page.error || 'blocked by public URL policy')
            : `HTTP ${page.status || 0}`;
        throw new Error(`Accor listing pagination fetch failed for ${page.url || url}: ${reason}`);
      }
      return page;
    }, ACCOR_MAX_LISTING_PAGES, pageSnapshots);
    return runSpecInProduction({ ...spec, seedUrls }, {
      headers: ACCOR_REQUEST_HEADERS,
      detailExtractor: extractAccorDetailFields,
      fetchImpl: createAccorSnapshotFetch(pageSnapshots, fetchImpl),
    });
  } finally {
    await urlPolicy.dispatcher.close();
  }
}

/**
 * Fetch all Ibis Budget jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAccorJobs(runtime = {}) {
  console.log(`🔍 Fetching Ibis Budget jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(runtime);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const geography = resolveSourceBackedSwissGeography(listing.location);
    if (!geography) continue;
    const { location, canton } = geography;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} accor ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `accor-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ACCOR_COMPANY_NAME,
      companyKey: ACCOR_KEY,
      companyDomain: ACCOR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Ibis Budget Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || "CH"),
      country: normalizeSpace(listing.addressCountry || "CH"),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Ibis Budget jobs discovered: ${jobs.length}`);
  return jobs;
}
