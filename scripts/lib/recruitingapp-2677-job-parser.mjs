#!/usr/bin/env node
/**
 * E-Recruiting LLB-Gruppe Stellen job parser — Fetcher and job builder.
 *
 * Source: https://recruitingapp-2677.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRecruitingapp2677Jobs()  — Fetch and parse all jobs
 *   - isRecruitingapp2677Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { isAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import {
  runUmantisSpecWithEmptyProof,
  umantisAuthoritativeEmptyOrNull,
} from './umantis-empty-listing.mjs';
import {
  resolveDetailOrListingSwissGeography,
  resolveSourceBackedSwissGeography,
} from './prospector/location-evidence.mjs';
import { extractLinks } from './prospector/careers-trail.mjs';
import { umantisVacancyIdentity } from './prospector/umantis-detail.mjs';
import { extractRuntimeDetailFields } from './prospector/detail-extract.mjs';
import { isSufficientVacancyDescription } from './prospector/extract.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RECRUITINGAPP_2677_KEY = 'recruitingapp-2677';
export const RECRUITINGAPP_2677_COMPANY_NAME = 'E-Recruiting LLB-Gruppe Stellen';
export const RECRUITINGAPP_2677_COMPANY_DOMAIN = 'recruitingapp-2677.umantis.com';
export const MAX_INTRO_BLOCKS = 8;

const CAREER_URL = 'https://recruitingapp-2677.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
// Only these source-backed workplace localities can authorize retiring the
// previous Swiss slice. A new locality must fail closed until it is reviewed.
const AUTHORITATIVE_NON_SWISS_LOCATIONS = new Set(['eschen', 'salzburg', 'vaduz', 'wien']);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeComparableTitle(value = '') {
  return normalizeSpace(value).normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Stable identity for the source's location candidates. Candidate order is
 * not a source contract: a parser or upstream HTML change may reorder the
 * same locations without changing the vacancy.
 */
export function stableLocationCandidatesKey(candidates = []) {
  const fields = ['location', 'addressLocality', 'addressRegion', 'addressCountry', 'postalCode', 'streetAddress'];
  const values = (Array.isArray(candidates) ? candidates : [candidates])
    .map((candidate) => {
      if (typeof candidate === 'string') return normalizeComparableTitle(candidate);
      if (!candidate || typeof candidate !== 'object') return '';
      return fields.map((field) => normalizeComparableTitle(candidate[field])).join('\u001e');
    })
    .filter((value) => value && /[^\u001e]/.test(value));
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en')).join('\u001f');
}

/**
 * The LLB Umantis detail header is `workload ◆ workplace ◆ employment mode`.
 * The generic Umantis cascade can mistake the first segment for a location
 * (`38,5h` / `80-100`), so this tenant reads the source's middle segment.
 */
function extractRecruitingapp2677DetailFields(html = '', pageUrl = '') {
  const detail = extractRuntimeDetailFields({ platform: 'umantis.com' }, html, pageUrl);
  const introRx = /<(?:div|section)\b[^>]*\bclass\s*=\s*["'][^"']*\bintro\b[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi;
  const rawHtml = String(html || '');
  let introLine = '';
  let introBlocks = 0;
  let match;
  while (introBlocks < MAX_INTRO_BLOCKS && (match = introRx.exec(rawHtml))) {
    introBlocks += 1;
    const candidate = stripHtml(match[0]).split('\n').find((line) => line.includes('◆'));
    if (candidate) {
      introLine = candidate;
      break;
    }
  }
  const parts = introLine.split('◆').map(normalizeSpace).filter(Boolean);
  const location = parts.length >= 3 ? parts[1] : '';
  if (location) {
    detail.locationCandidates = [{
      location,
      addressLocality: location,
      addressRegion: '',
      addressCountry: '',
      postalCode: '',
      streetAddress: '',
    }];
  }
  return detail;
}

function attachSnapshotProof(rows, proof) {
  Object.defineProperties(rows, {
    authoritativeSnapshotProof: { value: proof, enumerable: false },
    discoveredCount: { value: proof.discoveredCount, enumerable: false },
  });
  return rows;
}

function emptySnapshotProof() {
  return {
    discoveredCount: 0,
    attemptedDetailCount: 0,
    detailCount: 0,
    publishedCount: 0,
    complete: false,
    details: [],
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to E-Recruiting LLB-Gruppe Stellen.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRecruitingapp2677Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RECRUITINGAPP_2677_KEY ||
    key.startsWith('recruitingapp-2677') ||
    company.includes('e-recruiting llb-gruppe stellen') ||
    url.includes('recruitingapp-2677.umantis.com')
  );
}

/**
 * Validate that a URL belongs to E-Recruiting LLB-Gruppe Stellen's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-2677.umantis.com' || host.endsWith('.recruitingapp-2677.umantis.com');
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
async function fetchJobListings(runtime = {}) {
  const attemptedDetailIds = new Set();
  const listingTitles = new Map();
  const conflictingListingIds = new Set();
  const observedDetails = new Map();
  const invalidDetailIds = new Set();
  const conflictingDetailIds = new Set();
  // Keep the same Undici implementation that the production polite-fetch
  // dispatcher uses; the built-in fetch can silently return empty bodies here.
  const sourceFetch = runtime.fetchImpl || undiciFetch;

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
        let pathname = '';
        try { pathname = new URL(link.url).pathname; } catch { continue; }
        if (!id || title.length < 4 || !/^\/Vacancies\/\d+\/Description\/1\/?$/i.test(pathname)) {
          continue;
        }
        if (conflictingListingIds.has(id)) continue;
        const previousTitle = listingTitles.get(id);
        if (previousTitle !== undefined && normalizeComparableTitle(previousTitle) !== normalizeComparableTitle(title)) {
          conflictingListingIds.add(id);
          continue;
        }
        listingTitles.set(id, title);
      }
    }
    return response;
  };

  const observingDetailExtractor = (html, pageUrl) => {
    const detail = extractRecruitingapp2677DetailFields(html, pageUrl);
    const vacancyId = umantisVacancyIdentity(pageUrl);
    if (vacancyId) {
      const decision = resolveDetailOrListingSwissGeography(detail, {});
      const observation = {
        id: vacancyId,
        title: normalizeSpace(detail.title || ''),
        rich: isSufficientVacancyDescription(detail.description),
        swiss: Boolean(decision.geography),
        locations: (detail.locationCandidates || [])
          .map((candidate) => normalizeSpace(candidate?.addressLocality || candidate?.location || ''))
          .filter(Boolean),
        locationKey: stableLocationCandidatesKey(detail.locationCandidates || []),
      };
      const previous = observedDetails.get(vacancyId);
      if (!observation.title || !observation.rich || observation.locations.length === 0) {
        invalidDetailIds.add(vacancyId);
      }
      if (previous) {
        if (!previous.title || !previous.rich || previous.locations.length === 0) {
          invalidDetailIds.add(vacancyId);
        }
        if (normalizeComparableTitle(previous.title) !== normalizeComparableTitle(observation.title)
          || previous.rich !== observation.rich
          || previous.swiss !== observation.swiss
          || previous.locationKey !== observation.locationKey) {
          conflictingDetailIds.add(vacancyId);
        }
      } else {
        observedDetails.set(vacancyId, observation);
      }
    }
    return detail;
  };

  const rows = await runUmantisSpecWithEmptyProof(RECRUITINGAPP_2677_KEY, {
    ...runtime,
    fetchImpl: observingFetch,
    detailExtractor: observingDetailExtractor,
  });
  const details = [...observedDetails.values()];
  const proof = {
    discoveredCount: listingTitles.size,
    attemptedDetailCount: attemptedDetailIds.size,
    detailCount: details.length,
    complete: listingTitles.size > 0
      && attemptedDetailIds.size === listingTitles.size
      && details.length === listingTitles.size
      && conflictingListingIds.size === 0
      && invalidDetailIds.size === 0
      && conflictingDetailIds.size === 0
      && details.every((detail) => detail.rich && detail.locations.length > 0)
      && details.every((detail) => attemptedDetailIds.has(detail.id)
        && normalizeComparableTitle(listingTitles.get(detail.id)) === normalizeComparableTitle(detail.title)),
    details,
  };
  if ((proof.discoveredCount > 0 || proof.attemptedDetailCount > 0) && !proof.complete) {
    throw new Error(
      `recruitingapp-2677: incomplete detail snapshot (${proof.detailCount}/${proof.discoveredCount})`,
    );
  }
  return attachSnapshotProof(rows, proof);
}

export function assertCompleteRecruitingapp2677Snapshot(jobs) {
  if (isAuthoritativeEmptySnapshot(jobs)) return true;
  if (!Array.isArray(jobs) || jobs.length !== 0) return false;
  const proof = jobs.authoritativeSnapshotProof;
  if (!proof?.complete || proof.discoveredCount <= 0 || proof.publishedCount !== 0) return false;
  return proof.details.every((detail) => !detail.swiss
    && detail.locations.length > 0
    && detail.locations.every((location) => location.split(/[,;&/|]/)
      .map(normalize)
      .filter(Boolean)
      .every((locality) => AUTHORITATIVE_NON_SWISS_LOCATIONS.has(locality))));
}

/**
 * Fetch all E-Recruiting LLB-Gruppe Stellen jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRecruitingapp2677Jobs(runtime = {}) {
  console.log(`🔍 Fetching E-Recruiting LLB-Gruppe Stellen jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(runtime);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    const authoritativeEmpty = umantisAuthoritativeEmptyOrNull(listings, RECRUITINGAPP_2677_COMPANY_NAME);
    if (authoritativeEmpty) return authoritativeEmpty;
    const proof = listings?.authoritativeSnapshotProof || emptySnapshotProof();
    return attachSnapshotProof([], { ...proof, publishedCount: 0 });
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

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} recruitingapp-2677 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `recruitingapp-2677-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RECRUITINGAPP_2677_COMPANY_NAME,
      companyKey: RECRUITINGAPP_2677_KEY,
      companyDomain: RECRUITINGAPP_2677_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'E-Recruiting LLB-Gruppe Stellen Dedicated Parser',
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

  console.log(`\n📋 Total E-Recruiting LLB-Gruppe Stellen jobs discovered: ${jobs.length}`);
  const proof = listings.authoritativeSnapshotProof || emptySnapshotProof();
  return attachSnapshotProof(jobs, { ...proof, publishedCount: jobs.length });
}
