#!/usr/bin/env node
/**
 * yellowshark AG job parser — Fetcher and job builder.
 *
 * Source: https://jobs.yellowshark.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllYellowsharkJobs()  — Fetch and parse all jobs
 *   - isYellowsharkJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import { coerceCountryField, isChCountry } from './ch-country-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const YELLOWSHARK_KEY = 'yellowshark';
export const YELLOWSHARK_COMPANY_NAME = 'yellowshark AG';
export const YELLOWSHARK_COMPANY_DOMAIN = 'jobs.yellowshark.com';

const CAREER_URL = 'https://jobs.yellowshark.com/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function resolveYellowsharkListingAdmission(listing = {}) {
  const countryEvidence = [
    listing.addressCountry,
    listing.country,
    listing.countryCode,
    listing.country_code,
  ].map(coerceCountryField).filter(Boolean);

  if (!countryEvidence.length) {
    return { accepted: false, reason: 'explicit source country is missing', countryEvidence };
  }
  if (!countryEvidence.every(isChCountry)) {
    return { accepted: false, reason: 'source country is foreign or conflicting', countryEvidence };
  }

  const sourceGeographyEvidence = { ...listing, addressCountry: 'CH' };
  const resolvedGeography = resolveSourceBackedSwissGeography(sourceGeographyEvidence);
  const geography = resolvedGeography
    && sourceBackedSwissGeographyFields(sourceGeographyEvidence, resolvedGeography);
  if (!geography) {
    return { accepted: false, reason: 'source location is foreign or unresolved', countryEvidence };
  }

  return { accepted: true, country: 'CH', geography, countryEvidence };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to yellowshark AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isYellowsharkJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === YELLOWSHARK_KEY ||
    key.startsWith('yellowshark-') ||
    company.includes('yellowshark ag') ||
    url.includes('jobs.yellowshark.com')
  );
}

/**
 * Validate that a URL belongs to yellowshark AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.yellowshark.com' || host.endsWith('.jobs.yellowshark.com');
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
async function fetchJobListings() {
  const spec = loadSpec(YELLOWSHARK_KEY);
  return runSpecInProduction(spec, { requireExplicitCountryEvidence: true });
}

/**
 * Fetch all yellowshark AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllYellowsharkJobs() {
  console.log(`🔍 Fetching yellowshark AG jobs`);
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

    const admission = resolveYellowsharkListingAdmission(listing);
    if (!admission.accepted) {
      const sourceId = listing.id || listing.jobId || listing.url || title;
      const country = admission.countryEvidence.join(', ') || '<missing>';
      const location = normalizeSpace(listing.location || listing.addressLocality || '') || '<missing>';
      console.log('  ⏭️  Quarantined source listing ' + sourceId + ': ' + admission.reason
        + '; country=' + country + '; location=' + location);
      continue;
    }
    const { geography } = admission;
    const {
      location,
      canton,
      addressLocality,
      addressRegion,
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
    const jobSlug = slugify(`${title} ${location} yellowshark ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `yellowshark-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: YELLOWSHARK_COMPANY_NAME,
      companyKey: YELLOWSHARK_KEY,
      companyDomain: YELLOWSHARK_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'yellowshark AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      // Prospected runtime rows retain the selected structured candidate;
      // other ATS tiers use the same fields when their client exposes them.
      addressLocality: normalizeSpace(addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(addressRegion || canton),
      addressCountry: admission.country,
      country: admission.country,
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
      // Publication evidence is distinct from the collection timestamp.
      ...mergeSourcePostingDates({}, listing),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total yellowshark AG jobs discovered: ${jobs.length}`);
  return jobs;
}
