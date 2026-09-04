#!/usr/bin/env node
/**
 * Alexander von Humboldt-Stiftung Stellen job parser — Fetcher and job builder.
 *
 * Source: https://recruitingapp-2649.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRecruitingapp2649Jobs()  — Fetch and parse all jobs
 *   - isRecruitingapp2649Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  extractDetailFields,
  isSufficientVacancyDescription,
} from './prospector/extract.mjs';
import {
  resolveDetailOrListingSwissGeography,
  resolveSourceBackedSwissGeography,
} from './prospector/location-evidence.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { extractLinks } from './prospector/careers-trail.mjs';
import {
  extractUmantisDetailFields,
  umantisVacancyIdentity,
} from './prospector/umantis-detail.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RECRUITINGAPP_2649_KEY = 'recruitingapp-2649';
export const RECRUITINGAPP_2649_COMPANY_NAME = 'Alexander von Humboldt-Stiftung Stellen';
export const RECRUITINGAPP_2649_COMPANY_DOMAIN = 'recruitingapp-2649.umantis.com';

const CAREER_URL = 'https://recruitingapp-2649.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
const AUTHORITATIVE_NON_SWISS_LOCATIONS = new Set(['berlin', 'bonn']);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function canonicalRecruitingapp2649Url(rawUrl = '') {
  try {
    const vacancyId = umantisVacancyIdentity(rawUrl);
    if (!vacancyId) return '';
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== RECRUITINGAPP_2649_COMPANY_DOMAIN) return '';
    url.protocol = 'https:';
    url.hostname = RECRUITINGAPP_2649_COMPANY_DOMAIN;
    url.port = '';
    url.pathname = `/Vacancies/${vacancyId}/Description/1`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Alexander von Humboldt-Stiftung Stellen.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRecruitingapp2649Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RECRUITINGAPP_2649_KEY ||
    key.startsWith('recruitingapp-2649') ||
    company.includes('alexander von humboldt-stiftung stellen') ||
    url.includes('recruitingapp-2649.umantis.com')
  );
}

/**
 * Validate that a URL belongs to Alexander von Humboldt-Stiftung Stellen's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-2649.umantis.com' || host.endsWith('.recruitingapp-2649.umantis.com');
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
function attachSnapshotProof(rows, proof) {
  Object.defineProperty(rows, 'authoritativeSnapshotProof', {
    value: proof,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(rows, 'discoveredCount', {
    value: proof.discoveredCount,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return rows;
}

/**
 * A source-proven zero is the only safe way to retire the stale Lugano/TI
 * records once every current Umantis vacancy is demonstrably outside
 * Switzerland. Any missing, thin or unidentifiable detail invalidates the
 * whole batch, so the standard pipeline keeps the previous slice.
 */
async function fetchJobListings(runtime = {}) {
  const spec = loadSpec(RECRUITINGAPP_2649_KEY);
  const attemptedDetailIds = new Set();
  const listingTitles = new Map();
  const observedDetails = new Map();
  const sourceFetch = runtime.fetchImpl || globalThis.fetch;

  const observingFetch = async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input?.url || '');
    const vacancyId = umantisVacancyIdentity(rawUrl);
    if (vacancyId) attemptedDetailIds.add(vacancyId);
    const response = await sourceFetch(input, init);
    let pathname = '';
    try { pathname = new URL(rawUrl).pathname; } catch { /* not a URL */ }
    if (/^\/Jobs\/1\/?$/i.test(pathname) && response?.ok && typeof response.clone === 'function') {
      const copy = response.clone();
      const html = await copy.text();
      for (const link of extractLinks(html, response.url || rawUrl)) {
        const id = umantisVacancyIdentity(link.url);
        const title = normalizeSpace(link.text || '');
        if (!id || title.length < 4 || !/\/Vacancies\/\d+\/Description\/1\/?$/i.test(new URL(link.url).pathname)) {
          continue;
        }
        const previousTitle = listingTitles.get(id);
        listingTitles.set(id, previousTitle && normalize(previousTitle) !== normalize(title) ? '' : title);
      }
    }
    return response;
  };

  const observingDetailExtractor = (html, pageUrl) => {
    const detail = extractDetailFields(html, pageUrl);
    const umantisDetail = extractUmantisDetailFields(html);
    if (isSufficientVacancyDescription(umantisDetail.description)) {
      detail.description = umantisDetail.description;
    }
    if (!detail.locationCandidates.length && umantisDetail.locationCandidates.length) {
      detail.locationCandidates = umantisDetail.locationCandidates;
      const [candidate] = umantisDetail.locationCandidates;
      detail.location = candidate.location;
      detail.addressCountry = candidate.addressCountry;
    }

    const vacancyId = umantisVacancyIdentity(pageUrl);
    if (vacancyId) {
      const decision = resolveDetailOrListingSwissGeography(detail, {});
      observedDetails.set(vacancyId, {
        id: vacancyId,
        title: normalizeSpace(detail.title || ''),
        rich: isSufficientVacancyDescription(detail.description),
        swiss: Boolean(decision.geography),
        locations: detail.locationCandidates
          .map((candidate) => normalizeSpace(candidate?.addressLocality || candidate?.location || ''))
          .filter(Boolean),
      });
    }
    return detail;
  };

  const rows = await runSpecInProduction(spec, {
    ...runtime,
    fetchImpl: observingFetch,
    detailExtractor: observingDetailExtractor,
  });
  const details = [...observedDetails.values()];
  const proof = {
    discoveredCount: listingTitles.size,
    attemptedDetailCount: attemptedDetailIds.size,
    detailCount: details.length,
    publishedCount: rows.length,
    complete: listingTitles.size > 0
      && attemptedDetailIds.size === listingTitles.size
      && details.length === listingTitles.size
      && details.every((detail) => detail.rich && detail.locations.length > 0)
      && details.every((detail) => attemptedDetailIds.has(detail.id)
        && normalize(listingTitles.get(detail.id)) === normalize(detail.title)),
    details,
  };
  if ((proof.discoveredCount > 0 || proof.attemptedDetailCount > 0) && !proof.complete) {
    throw new Error(
      `recruitingapp-2649: incomplete detail snapshot (${proof.detailCount}/${proof.discoveredCount})`,
    );
  }
  return attachSnapshotProof(rows, proof);
}

export function assertCompleteRecruitingapp2649Snapshot(jobs) {
  if (!Array.isArray(jobs) || jobs.length !== 0) return false;
  const proof = jobs.authoritativeSnapshotProof;
  if (!proof?.complete || proof.discoveredCount <= 0 || proof.publishedCount !== 0) return false;
  return proof.details.every((detail) => !detail.swiss
    && detail.locations.length > 0
    && detail.locations.every((location) => {
      const locality = normalize(location).split(/[,;/|]/)[0].trim();
      return AUTHORITATIVE_NON_SWISS_LOCATIONS.has(locality);
    }));
}

/**
 * Fetch all Alexander von Humboldt-Stiftung Stellen jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRecruitingapp2649Jobs(runtime = {}) {
  console.log(`🔍 Fetching Alexander von Humboldt-Stiftung Stellen jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(runtime);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return attachSnapshotProof([], listings?.authoritativeSnapshotProof || {
      discoveredCount: 0,
      detailCount: 0,
      publishedCount: 0,
      complete: false,
      details: [],
    });
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
    const publicUrl = canonicalRecruitingapp2649Url(listing.url || '');
    if (!publicUrl) {
      throw new Error('recruitingapp-2649: source vacancy has no canonical Umantis identity');
    }

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} recruitingapp-2649 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `recruitingapp-2649-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RECRUITINGAPP_2649_COMPANY_NAME,
      companyKey: RECRUITINGAPP_2649_KEY,
      companyDomain: RECRUITINGAPP_2649_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Alexander von Humboldt-Stiftung Stellen Dedicated Parser',
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

  console.log(`\n📋 Total Alexander von Humboldt-Stiftung Stellen jobs discovered: ${jobs.length}`);
  return attachSnapshotProof(jobs, listings.authoritativeSnapshotProof);
}
