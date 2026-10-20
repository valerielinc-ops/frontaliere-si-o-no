#!/usr/bin/env node
/**
 * Medimeo AG job parser — Fetcher and job builder.
 *
 * Source: https://medimeo.ch/offene-jobs/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMedimeoJobs()  — Fetch and parse all jobs
 *   - isMedimeoJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, normalizeSwissCantonCode } from './target-swiss-locations.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { classifyCountryValue } from './prospector/country-inventory.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MEDIMEO_KEY = 'medimeo';
export const MEDIMEO_COMPANY_NAME = 'Medimeo AG';
export const MEDIMEO_COMPANY_DOMAIN = 'medimeo.ch';

const CAREER_URL = 'https://medimeo.ch/offene-jobs/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function hasConflictingCountryEvidence(evidence) {
  const identities = [evidence.addressCountry, evidence.country]
    .map((value) => classifyCountryValue(value))
    .filter((identity) => identity !== 'unknown');
  return new Set(identities).size > 1;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Medimeo AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMedimeoJob(job) {
  // Both Medimeo crawlers share the company name and domain. Only the
  // crawler key identifies which slice owns a record; company/url fallbacks
  // would let the sibling crawler claim the same job.
  const key = normalize(job?.companyKey || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return key === MEDIMEO_KEY;
}

/**
 * Validate that a URL belongs to Medimeo AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'medimeo.ch' || host.endsWith('.medimeo.ch');
  } catch {
    return false;
  }
}

/**
 * Medimeo also advertises broad jobs in the Ostschweiz/Liechtenstein area.
 * The shared Swiss geography gate intentionally rejects that mixed location
 * because it cannot prove a Swiss canton for the vacancy. That is an expected
 * source filter, not a failed detail extraction; exclude it from the detail
 * completeness denominator while retaining the fail-closed behavior for
 * missing or broken detail pages.
 */
export function isMedimeoExpectedDetailFilter({ reason, decision } = {}) {
  return reason === 'geography' && decision?.explicitlyForeign === true;
}

/**
 * Resolve a Medimeo listing's source-backed geography. The detail extractor
 * may expose a broad display region (for example `Region Basel`) in
 * `addressLocality` while the location string itself is a valid canton signal.
 * Try the complete evidence first, then retry without that broad structured
 * locality/region pair so it cannot veto the already source-backed location.
 */
export function resolveMedimeoGeography(listing = {}) {
  const evidence = {
    location: listing.location || listing.addressLocality,
    addressLocality: listing.addressLocality,
    addressRegion: listing.addressRegion,
    addressCountry: listing.addressCountry,
    country: listing.country,
    postalCode: listing.postalCode,
    streetAddress: listing.streetAddress,
  };
  // `addressCountry` and `country` are independent source fields. Never let
  // the preferred Swiss field hide a contradictory foreign field before the
  // fallback re-resolves the location.
  if (hasConflictingCountryEvidence(evidence)) return null;

  const structuredCanton = normalizeSwissCantonCode(evidence.addressRegion);
  if (structuredCanton) {
    // An explicit structured canton must agree with the independently parsed
    // locality. Otherwise a wrong region (for example ZH on a Lugano listing)
    // would be accepted merely because the locality is absent from the
    // structured address fields.
    const locationOnly = resolveSourceBackedSwissGeography({
      location: evidence.location,
      addressLocality: evidence.addressLocality,
      addressCountry: evidence.addressCountry || evidence.country,
      postalCode: evidence.postalCode,
      streetAddress: evidence.streetAddress,
    });
    if (locationOnly?.canton && locationOnly.canton !== structuredCanton) return null;
  }

  const resolved = resolveSourceBackedSwissGeography(evidence);
  if (resolved) return resolved;

  // The fallback is only for a Swiss country plus a verified canton marker:
  // never let it override a foreign country/region conflict by re-inferencing
  // a canton from a broad display string.
  const country = String(evidence.addressCountry || evidence.country || '').trim().toLowerCase();
  const region = String(evidence.addressRegion || '').trim();
  const swissCountry = new Set(['ch', 'switzerland', 'schweiz', 'suisse', 'svizzera', 'svizra']).has(country);
  if (!swissCountry || (region && !normalizeSwissCantonCode(region))) return null;

  return resolveSourceBackedSwissGeography({
    location: evidence.location,
    addressCountry: evidence.addressCountry || evidence.country,
    postalCode: evidence.postalCode,
    streetAddress: evidence.streetAddress,
  });
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
async function fetchJobListings() {
  const spec = loadSpec(MEDIMEO_KEY);
  return runSpecInProduction(spec, {
    isExpectedDetailFilter: isMedimeoExpectedDetailFilter,
  });
}

/**
 * Fetch all Medimeo AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMedimeoJobs() {
  console.log(`🔍 Fetching Medimeo AG jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
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

    const sourceGeographyEvidence = {
      location: listing.location,
      addressLocality: listing.addressLocality,
      addressRegion: listing.addressRegion,
      addressCountry: listing.addressCountry,
      country: listing.country,
      postalCode: listing.postalCode,
      streetAddress: listing.streetAddress,
    };
    const resolvedGeography = resolveMedimeoGeography(listing);
    const geography = resolvedGeography
      && (typeof sourceBackedSwissGeographyFields === 'function'
        ? sourceBackedSwissGeographyFields(sourceGeographyEvidence, resolvedGeography)
        : resolvedGeography);
    // Required structured-data geography must come from the vacancy source.
    // Missing, foreign or non-specific values are not replaced with an HQ.
    if (!geography) continue;
    const {
      location,
      canton,
      addressLocality,
      addressRegion,
      addressCountry,
      postalCode,
      streetAddress,
    } = geography;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;
    // The detail URL is the vacancy identity: falling back to the listing page
    // would give every posting the same `url`, `applyUrl` and `id` hash.
    if (!listing.url) continue;
    const publicUrl = listing.url;
    const employmentType = detectEmploymentType(listing.timeType || title);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} medimeo ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `medimeo-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MEDIMEO_COMPANY_NAME,
      companyKey: MEDIMEO_KEY,
      companyDomain: MEDIMEO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Medimeo AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      // Prospected runtime rows retain the selected structured candidate;
      // other ATS tiers use the same fields when their client exposes them.
      addressLocality: normalizeSpace(addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(addressRegion || canton),
      addressCountry: normalizeSpace(addressCountry || 'CH'),
      country: normalizeSpace(addressCountry || 'CH'),
      ...(postalCode ? { postalCode: normalizeSpace(postalCode) } : {}),
      ...(streetAddress ? { streetAddress: normalizeSpace(streetAddress) } : {}),
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME'
        ? 'part-time'
        : employmentType === 'FULL_TIME' ? 'full-time' : 'other',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      // Keep publication evidence separate from observation/creation aliases.
      ...mergeSourcePostingDates({}, listing),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Medimeo AG jobs discovered: ${jobs.length}`);
  return jobs;
}
