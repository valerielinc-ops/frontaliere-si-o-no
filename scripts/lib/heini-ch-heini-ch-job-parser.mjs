#!/usr/bin/env node
/**
 * Heini Conditorei AG job parser — Fetcher and job builder.
 *
 * Source: https://www.yousty.ch/de-CH/lehrstellen/firmen/2237470-heini-conditorei-ag
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHeiniChHeiniChJobs()  — Fetch and parse all jobs
 *   - isHeiniChHeiniChJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { canonicalizeJobUrl, detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import {
  copySpecFetchMetadata,
  loadSpec,
  runSpecInProduction,
} from './prospector/spec-crawler.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissJobAddressFields,
} from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HEINI_CH_HEINI_CH_KEY = 'heini-ch-heini-ch';
export const HEINI_CH_HEINI_CH_COMPANY_NAME = 'Heini Conditorei AG';
export const HEINI_CH_HEINI_CH_COMPANY_DOMAIN = 'yousty.ch';

const CAREER_URL = 'https://www.yousty.ch/de-CH/lehrstellen/firmen/2237470-heini-conditorei-ag';
const HEINI_CH_HEINI_CH_VACANCY_PATH_RE = /^\/(?:[a-z]{2}-[a-z]{2}\/)?(?:lehrstellen\/profile|places-d-apprentissage\/profils|posti-di-apprendistato\/profili)\/[^/?#]+-heini-conditorei-ag\/?$/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isHeiniChHeiniChVacancyUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    return (host === HEINI_CH_HEINI_CH_COMPANY_DOMAIN
      || host === `www.${HEINI_CH_HEINI_CH_COMPANY_DOMAIN}`)
      && HEINI_CH_HEINI_CH_VACANCY_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Heini Conditorei AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHeiniChHeiniChJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');

  return (
    key === HEINI_CH_HEINI_CH_KEY ||
    key.startsWith('heini-ch-heini-ch-') ||
    company.includes('heini conditorei ag') ||
    isHeiniChHeiniChVacancyUrl(job?.url)
  );
}

/**
 * Validate that a URL belongs to Heini Conditorei AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'yousty.ch' || host.endsWith('.yousty.ch');
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
  const spec = loadSpec(HEINI_CH_HEINI_CH_KEY);
  return runSpecInProduction(spec);
}

/**
 * Fetch all Heini Conditorei AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHeiniChHeiniChJobs() {
  console.log(`🔍 Fetching Heini Conditorei AG jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return copySpecFetchMetadata([], listings || []);
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
    const resolvedGeography = resolveSourceBackedSwissGeography(listing);
    const geography = resolvedGeography
      && sourceBackedSwissJobAddressFields(sourceGeographyEvidence, resolvedGeography);
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
    const rawUrl = String(listing.url || '').trim();
    if (!rawUrl) continue;
    const publicUrl = canonicalizeJobUrl(rawUrl) || rawUrl;
    const employmentType = detectEmploymentType(listing.timeType || title);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} heini-ch-heini-ch ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `heini-ch-heini-ch-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HEINI_CH_HEINI_CH_COMPANY_NAME,
      companyKey: HEINI_CH_HEINI_CH_KEY,
      companyDomain: HEINI_CH_HEINI_CH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Heini Conditorei AG Dedicated Parser',
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

  console.log(`\n📋 Total Heini Conditorei AG jobs discovered: ${jobs.length}`);
  return copySpecFetchMetadata(jobs, listings || []);
}
