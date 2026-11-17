#!/usr/bin/env node
/**
 * Careanesth AG job parser — Fetcher and job builder.
 *
 * Source: https://careanesth.com/de/fuer-stellensuchende/stellen/?mainDivision=acute&amp;profession%5B%5D=14926&amp;profession%5B%5D=7849&amp;profession%5B%5D=7851&amp;profession%5B%5D=7852&amp;profession%5B%5D=10252&amp;profession%5B%5D=7850&amp;profession%5B%5D=1092&amp;profession%5B%5D=1124&amp;profession%5B%5D=7853&amp;profession%5B%5D=10251&amp;profession%5B%5D=7855&amp;profession%5B%5D=14912&amp;division%5B%5D=1211&amp;division%5B%5D=1199&amp;division%5B%5D=1200&amp;division%5B%5D=1207&amp;division%5B%5D=1206&amp;division%5B%5D=1209&amp;division%5B%5D=1210&amp;division%5B%5D=1214&amp;division%5B%5D=10239&amp;division%5B%5D=10451&amp;division%5B%5D=1216&amp;sort=
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCareanesthComJobs()  — Fetch and parse all jobs
 *   - isCareanesthComJob()         — Match jobs belonging to this company
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

export const CAREANESTH_COM_KEY = 'careanesth-com';
export const CAREANESTH_COM_COMPANY_NAME = 'Careanesth AG';
export const CAREANESTH_COM_COMPANY_DOMAIN = 'careanesth.com';

const CAREER_URL = 'https://careanesth.com/de/fuer-stellensuchende/stellen/?mainDivision=acute&amp;profession%5B%5D=14926&amp;profession%5B%5D=7849&amp;profession%5B%5D=7851&amp;profession%5B%5D=7852&amp;profession%5B%5D=10252&amp;profession%5B%5D=7850&amp;profession%5B%5D=1092&amp;profession%5B%5D=1124&amp;profession%5B%5D=7853&amp;profession%5B%5D=10251&amp;profession%5B%5D=7855&amp;profession%5B%5D=14912&amp;division%5B%5D=1211&amp;division%5B%5D=1199&amp;division%5B%5D=1200&amp;division%5B%5D=1207&amp;division%5B%5D=1206&amp;division%5B%5D=1209&amp;division%5B%5D=1210&amp;division%5B%5D=1214&amp;division%5B%5D=10239&amp;division%5B%5D=10451&amp;division%5B%5D=1216&amp;sort=';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Careanesth AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCareanesthComJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CAREANESTH_COM_KEY ||
    key.startsWith('careanesth-com-') ||
    company.includes('careanesth ag') ||
    url.includes('careanesth.com')
  );
}

/**
 * Validate that a URL belongs to Careanesth AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'careanesth.com' || host.endsWith('.careanesth.com');
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
  const spec = loadSpec(CAREANESTH_COM_KEY);
  return runSpecInProduction(spec);
}

/**
 * Fetch all Careanesth AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCareanesthComJobs() {
  console.log(`🔍 Fetching Careanesth AG jobs`);
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
    const jobSlug = slugify(`${title} ${location} careanesth-com ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `careanesth-com-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CAREANESTH_COM_COMPANY_NAME,
      companyKey: CAREANESTH_COM_KEY,
      companyDomain: CAREANESTH_COM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Careanesth AG Dedicated Parser',
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

  console.log(`\n📋 Total Careanesth AG jobs discovered: ${jobs.length}`);
  return copySpecFetchMetadata(jobs, listings || []);
}
