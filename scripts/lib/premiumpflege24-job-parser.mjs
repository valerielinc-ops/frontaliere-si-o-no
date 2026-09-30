#!/usr/bin/env node
/**
 * PremiumPflege24 GmbH job parser — Fetcher and job builder.
 *
 * Source: https://premiumpflege24.ch/job-registrierung/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllPremiumpflege24Jobs()  — Fetch and parse all jobs
 *   - isPremiumpflege24Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { hardenJobsWithStructuredSalary } from './structured-salary.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  createSpecUrlPolicy,
  fetchRuntimePage,
  loadSpec,
  runSpecInProduction,
} from './prospector/spec-crawler.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PREMIUMPFLEGE24_KEY = 'premiumpflege24';
export const PREMIUMPFLEGE24_COMPANY_NAME = 'PremiumPflege24 GmbH';
export const PREMIUMPFLEGE24_COMPANY_DOMAIN = 'premiumpflege24.ch';

const CAREER_URL = 'https://premiumpflege24.ch/job-registrierung/';
const NATIONWIDE_LOCATION = 'Schweiz';
const NATIONWIDE_SCOPE_RX = /\b(?:in der ganzen Schweiz|ganzen Schweiz)\b/i;
const CARE_ROLE_RX = /\b(?:seniorenbetreuung|betreuungskräfte|betreuungskraft|haushaltshilfe)\b/i;
const APPLICATION_RX = /\b(?:bewerb\w*|bewerben|bewerbung|bewerbungen)\b/i;
const JOB_TITLE_RX = /\b(?:job\w*|stelle\w*|seniorenbetreuung|betreuung|pflege)\b/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function extractPageTitle(html = '', fallback = '') {
  const documentTitle = normalizeSpace(stripHtml(
    /<title\b[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(String(html || ''))?.[1] || '',
  ));
  const headings = [...String(html || '').matchAll(
    /<h[1-6]\b[^>]*>([\s\S]{0,500}?)<\/h[1-6]>/gi,
  )].map((match) => normalizeSpace(stripHtml(match[1] || '')));
  return [documentTitle, ...headings, normalizeSpace(fallback)]
    .find((candidate) => candidate.length >= 8 && JOB_TITLE_RX.test(candidate))
    || documentTitle
    || normalizeSpace(fallback);
}

/**
 * Recover PremiumPflege24's source-backed nationwide application page when
 * its generic JobPosting extraction has no rows. The page is a real caregiver
 * recruitment funnel, not a company footer: it explicitly names nationwide
 * work, the care role and the application flow. Keep the location country-wide
 * because the source does not identify one workplace; never substitute the
 * Subingen employer address as a vacancy location.
 */
export function extractPremiumpflege24NationwideApplicationListing(
  html = '',
  pageUrl = CAREER_URL,
) {
  if (!isTrustedDomain(pageUrl)) return null;

  const detail = extractDetailFields(html, pageUrl);
  const description = normalizeSpace(detail.description || '');
  const title = extractPageTitle(html, detail.title);
  const sourceText = `${title} ${description}`;

  if (!NATIONWIDE_SCOPE_RX.test(sourceText)
    || !CARE_ROLE_RX.test(sourceText)
    || !APPLICATION_RX.test(sourceText)
    || !meetsSourceBodyFloor(description)) {
    return null;
  }

  return {
    title,
    url: pageUrl,
    location: NATIONWIDE_LOCATION,
    addressLocality: NATIONWIDE_LOCATION,
    addressCountry: 'CH',
    country: 'CH',
    description,
    postedAt: detail.postedDate || null,
    nationwide: true,
  };
}

/**
 * Resolve a PremiumPflege24 row without turning the employer's HQ into a
 * workplace. Country-only source evidence is a valid nationwide posting; all
 * other rows still require the shared source-backed Swiss geography resolver.
 */
export function resolvePremiumpflege24Geography(listing) {
  const location = normalizeSpace(listing?.location || '');
  const country = normalizeSpace(listing?.addressCountry || listing?.country || '').toUpperCase();
  if (listing?.nationwide === true && location === NATIONWIDE_LOCATION && country === 'CH') {
    return { location: NATIONWIDE_LOCATION, canton: '' };
  }
  return resolveSourceBackedSwissGeography(listing);
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to PremiumPflege24 GmbH.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isPremiumpflege24Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === PREMIUMPFLEGE24_KEY ||
    key.startsWith('premiumpflege24-') ||
    company.includes('premiumpflege24 gmbh') ||
    url.includes('premiumpflege24.ch')
  );
}

/**
 * Validate that a URL belongs to PremiumPflege24 GmbH's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'premiumpflege24.ch' || host.endsWith('.premiumpflege24.ch');
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
  const spec = loadSpec(PREMIUMPFLEGE24_KEY);
  const listings = await runSpecInProduction(spec);
  if (listings.length > 0) return listings;

  // The promoted spec remains the first-line extractor. Only after it has
  // observed a successful zero do we inspect the same seed as a source-backed
  // application page, so transport failures still fail closed and preserve the
  // prior slice in the crawler template.
  const fallbackUrl = spec.seedUrls?.[0] || CAREER_URL;
  const validateUrl = createSpecUrlPolicy(spec);
  try {
    const page = await fetchRuntimePage(fallbackUrl, validateUrl, {});
    const fallback = page?.body
      ? extractPremiumpflege24NationwideApplicationListing(page.body, page.url || fallbackUrl)
      : null;
    if (fallback) {
      console.log('  ℹ️ Using the source-backed nationwide application page fallback.');
      return [fallback];
    }
    return listings;
  } finally {
    await validateUrl.dispatcher.close().catch(() => {});
  }
}

/**
 * Fetch all PremiumPflege24 GmbH jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllPremiumpflege24Jobs() {
  console.log(`🔍 Fetching PremiumPflege24 GmbH jobs`);
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

    const geography = resolvePremiumpflege24Geography(listing);
    // Required structured-data geography must come from the vacancy source.
    // Missing, foreign or non-specific values are not replaced with an HQ.
    if (!geography) continue;
    const { location, canton } = geography;
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;
    // The detail URL is the vacancy identity: falling back to the listing page
    // would give every posting the same `url`, `applyUrl` and `id` hash.
    if (!listing.url) continue;
    const publicUrl = listing.url;
    const employmentType = detectEmploymentType(listing.timeType || title);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} premiumpflege24 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `premiumpflege24-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PREMIUMPFLEGE24_COMPANY_NAME,
      companyKey: PREMIUMPFLEGE24_KEY,
      companyDomain: PREMIUMPFLEGE24_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'PremiumPflege24 GmbH Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      // Prospected runtime rows retain the selected structured candidate;
      // other ATS tiers use the same fields when their client exposes them.
      addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || 'CH'),
      country: normalizeSpace(listing.addressCountry || 'CH'),
      // Keep mandatory address keys on every row; the job-page JSON-LD
      // normalizer supplies safe fallbacks when the source omits them.
      postalCode: normalizeSpace(listing.postalCode || ''),
      streetAddress: normalizeSpace(listing.streetAddress || ''),
      baseSalary: null,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME'
        ? 'part-time'
        : employmentType === 'FULL_TIME' ? 'full-time' : 'other',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      // Preserve the source date; the shared merge assigns a stable first-seen
      // date when the source does not publish one.
      postedDate: listing.postedAt || null,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total PremiumPflege24 GmbH jobs discovered: ${jobs.length}`);
  return hardenJobsWithStructuredSalary(jobs).jobs;
}
