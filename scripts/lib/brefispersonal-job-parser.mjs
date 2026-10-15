#!/usr/bin/env node
/**
 * brefis personal ag job parser — Fetcher and job builder.
 *
 * Source: https://brefis.ch/Vacancyboard/Detail/46980
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBrefispersonalJobs()  — Fetch and parse all jobs
 *   - isBrefispersonalJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, rescueSwissCityFromText } from './target-swiss-locations.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BREFISPERSONAL_KEY = 'brefispersonal';
export const BREFISPERSONAL_COMPANY_NAME = 'brefis personal ag';
export const BREFISPERSONAL_COMPANY_DOMAIN = 'brefis.ch';

const BREFISPERSONAL_LEGACY_DOMAIN = 'brefispersonal.ch';
const CAREER_URL = 'https://brefis.ch/Vacancyboard/Detail/46980';

// A free-text city is usable for this source only when the vacancy itself
// labels it as a workplace.  Employer HQ/office prose is not a job location.
const BREFIS_WORKPLACE_CONTEXT_RE = /(?:\b(?:arbeitsort|einsatzort|arbeitsplatz|t[aä]tigkeitsort|dienstort|lieu\s+de\s+travail|lieu\s+d['’]affectation|luogo\s+di\s+lavoro|sede\s+di\s+lavoro|posto\s+di\s+lavoro|localit[aà]\s+di\s+lavoro|work(?:place|ing\s+location)|based\s+(?:in|at)|location)\b\s*(?:(?:ist|is|[=:–—-])\s*)?|\b(?:einsatz|eins[aä]tze|t[aä]tigkeit|arbeiten|arbeit)\b\s+(?:in|am|bei)\s+|\b(?:im|in\s+der|aus\s+dem|in)\s+(?:raum|region|grossraum)\s+|\b(?:poste|posto|lavoro|travail)\b\s+(?:a|in|à)\s+)([^.;!?\n]{0,160})/giu;

function rescueBrefisWorkplaceCity(descriptionText = '') {
  if (!descriptionText) return '';
  for (const match of descriptionText.matchAll(BREFIS_WORKPLACE_CONTEXT_RE)) {
    const city = rescueSwissCityFromText(match[1] || '');
    if (city) return city;
  }
  return '';
}

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isBrefispersonalHost(rawHost = '') {
  const host = normalize(rawHost).replace(/\.$/, '');
  return [BREFISPERSONAL_COMPANY_DOMAIN, BREFISPERSONAL_LEGACY_DOMAIN]
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to brefis personal ag.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBrefispersonalJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BREFISPERSONAL_KEY ||
    key.startsWith('brefispersonal-') ||
    company.includes('brefis personal ag') ||
    isTrustedDomain(url)
  );
}

/**
 * Validate that a URL belongs to brefis personal ag's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return isBrefispersonalHost(host);
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
  const spec = loadSpec(BREFISPERSONAL_KEY);
  return runSpecInProduction(spec);
}

/**
 * Resolve the source-backed geography for a Brefis listing.
 *
 * Brefis currently emits the canton code (`ZH`) in both `location` and
 * `addressLocality`. The shared resolver correctly rejects that as a
 * municipality, so use a city from the same vacancy description only when it
 * corroborates the structured canton. If the description has no city, retain
 * the structured canton-only evidence instead of inventing an employer HQ.
 *
 * @param {Record<string, any>} listing
 * @param {string} descriptionText
 * @returns {{ location: string, canton: string, addressCountry?: string }|null}
 */
export function resolveBrefispersonalGeography(listing, descriptionText = '') {
  const addressLocality = normalizeSpace(listing?.addressLocality || '');
  const addressRegion = normalizeSpace(listing?.addressRegion || '');
  const structuredCanton = inferSwissTargetCanton(addressRegion || listing?.location || '');
  const cantonOnlyLocality = Boolean(
    addressLocality
    && structuredCanton
    && /^[A-Za-z]{2}$/.test(addressLocality)
    && inferSwissTargetCanton(addressLocality) === structuredCanton,
  );
  const structured = cantonOnlyLocality
    ? resolveSourceBackedSwissGeography({ ...listing, addressLocality: '' })
    : resolveSourceBackedSwissGeography(listing);
  if (!cantonOnlyLocality) return structured;

  const city = rescueBrefisWorkplaceCity(descriptionText);
  if (city && inferSwissTargetCanton(city) === structuredCanton) {
    const fromDescription = resolveSourceBackedSwissGeography({
      location: city,
      addressLocality: city,
      addressRegion,
      addressCountry: listing?.addressCountry || 'CH',
    });
    if (fromDescription) return fromDescription;
  }
  return structured;
}

/**
 * Fetch all brefis personal ag jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBrefispersonalJobs() {
  console.log(`🔍 Fetching brefis personal ag jobs`);
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

    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;
    const geography = resolveBrefispersonalGeography(listing, descriptionText);
    // Required structured-data geography must come from the vacancy source.
    // Missing, foreign or non-specific values are not replaced with an HQ.
    if (!geography) continue;
    const { location, canton } = geography;
    // The detail URL is the vacancy identity: falling back to the listing page
    // would give every posting the same `url`, `applyUrl` and `id` hash.
    if (!listing.url) continue;
    const publicUrl = listing.url;
    const employmentType = detectEmploymentType(listing.timeType || title);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${location} brefispersonal ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `brefispersonal-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BREFISPERSONAL_COMPANY_NAME,
      companyKey: BREFISPERSONAL_KEY,
      companyDomain: BREFISPERSONAL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'brefis personal ag Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      // Prospected runtime rows retain the selected structured candidate;
      // other ATS tiers use the same fields when their client exposes them.
      addressLocality: normalizeSpace(geography.location || listing.addressLocality || location.split(/[,;/|]/)[0]),
      addressRegion: normalizeSpace(listing.addressRegion || canton),
      addressCountry: normalizeSpace(listing.addressCountry || 'CH'),
      country: normalizeSpace(listing.addressCountry || 'CH'),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
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

  console.log(`\n📋 Total brefis personal ag jobs discovered: ${jobs.length}`);
  return jobs;
}
