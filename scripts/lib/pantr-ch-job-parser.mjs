#!/usr/bin/env node
/**
 * Pantr GmbH job parser — Fetcher and job builder.
 *
 * Source: https://pantr.ch/jobs/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllPantrChJobs()  — Fetch and parse all jobs
 *   - isPantrChJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { stripHtml } from './crawler-template.mjs';
import { buildSlug as buildCanonicalSlug } from './regenerate-slugs-helpers.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PANTR_CH_KEY = 'pantr-ch';
export const PANTR_CH_COMPANY_NAME = 'Pantr GmbH';
export const PANTR_CH_COMPANY_DOMAIN = 'pantr.ch';
export const PANTR_CH_SECTOR = 'Finanza / Revisione contabile e servizi fiduciari';

const CAREER_URL = 'https://pantr.ch/jobs/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Pantr GmbH.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isPantrChJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === PANTR_CH_KEY ||
    key.startsWith('pantr-ch-') ||
    company.includes('pantr gmbh') ||
    url.includes('pantr.ch')
  );
}

/**
 * Validate that a URL belongs to Pantr GmbH's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'pantr.ch' || host.endsWith('.pantr.ch');
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
  if (/\b(it\b|software\b|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior\b|jr\b)/.test(t)) return 'junior';
  if (/\b(senior\b|sr\b|lead\b|head\b|director\b|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
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
  const spec = loadSpec(PANTR_CH_KEY);
  return runSpecInProduction(spec);
}

/** Build one valid source-locale job from a Pantr listing without fetching. */
export function buildPantrChJobFromListing(listing) {
  if (!listing || typeof listing !== 'object') return null;

  const title = normalizeSpace(listing.title || '');
  if (!title || title.length < 3) return null;

  const geography = resolveSourceBackedSwissGeography(listing);
  // Required structured-data geography must come from the vacancy source.
  // Missing, foreign or non-specific values are not replaced with an HQ.
  if (!geography) return null;
  const { location, canton } = geography;
  const descriptionHtml = listing.description || '';
  const descriptionText = stripHtml(descriptionHtml);
  if (!meetsSourceBodyFloor(descriptionText)) return null;
  // The detail URL is the vacancy identity: falling back to the listing page
  // would give every posting the same `url`, `applyUrl` and `id` hash.
  const publicUrl = String(listing.url || '').trim();
  if (!publicUrl) return null;
  const employmentType = detectEmploymentType(listing.timeType || title);

  const sourceLang = detectLang(descriptionText || title, 'de');
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = buildCanonicalSlug(title, PANTR_CH_COMPANY_NAME, location, urlHash);

  return {
    // ── Required fields ──
    id: `pantr-ch-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    slugDisambiguator: urlHash,
    company: PANTR_CH_COMPANY_NAME,
    companyKey: PANTR_CH_KEY,
    companyDomain: PANTR_CH_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText,
    descriptionByLocale: { [sourceLang]: descriptionText },
    location,
    canton,
    url: publicUrl,
    source: 'Pantr GmbH Dedicated Parser',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    // Prospected runtime rows retain the selected structured candidate;
    // other ATS tiers use the same fields when their client exposes them.
    addressLocality: normalizeSpace(listing.addressLocality || location.split(/[,;/|]/)[0]),
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
    // The promoted Pantr sample is consistently audit, tax and fiduciary work;
    // use that evidence-backed sector instead of dropping these jobs into Altro.
    sector: PANTR_CH_SECTOR,
    currency: 'CHF',
    featured: false,
    // Publication evidence is distinct from the collection timestamp.
    ...mergeSourcePostingDates({}, listing),
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/**
 * Fetch all Pantr GmbH jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllPantrChJobs() {
  console.log(`🔍 Fetching Pantr GmbH jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);
  const jobs = listings.map(buildPantrChJobFromListing).filter(Boolean);
  console.log(`\n📋 Total Pantr GmbH jobs discovered: ${jobs.length}`);
  return jobs;
}
