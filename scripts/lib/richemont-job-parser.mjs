#!/usr/bin/env node
/**
 * Richemont job parser — Fetcher and job builder.
 *
 * Source: https://careers.richemont.com/en/jobs/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRichemontJobs()  — Fetch and parse all jobs
 *   - isRichemontJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RICHEMONT_KEY = 'richemont';
export const RICHEMONT_COMPANY_NAME = 'Richemont';
export const RICHEMONT_COMPANY_DOMAIN = 'richemont.com';

const CAREER_URL = 'https://careers.richemont.com/en/jobs/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Richemont.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRichemontJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RICHEMONT_KEY ||
    key.startsWith('richemont') ||
    company.includes('richemont') ||
    url.includes('richemont.com')
  );
}

/**
 * Validate that a URL belongs to Richemont's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'richemont.com' ||
      host.endsWith('.richemont.com')
    );
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

// TODO: Implement the actual fetching logic for Richemont's career page.
// This is a placeholder. Replace with the actual API/scraping logic.
//
// Common patterns:
//   - JSON API:     use --source api for a ready-made paginated API template
//   - Workday API:  re-scaffold with --ats=workday for a ready-made template
//   - Greenhouse:   --ats=greenhouse
//   - Lever:        --ats=lever
//   - SuccessFactors: --ats=successfactors
//   - Generic HTML: fetch + parse with regex or cheerio

async function fetchJobListings() {
  // TODO: Replace with actual fetch logic
  console.log(`   Fetching from: ${CAREER_URL}`);

  // Example for a JSON API:
  // const res = await fetch(CAREER_URL, {
  //   headers: { 'User-Agent': 'FrontaliereTicino-JobCrawler/2.0' },
  // });
  // if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // return await res.json();

  return [];
}

/**
 * Fetch all Richemont jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRichemontJobs() {
  console.log(`🔍 Fetching Richemont jobs`);
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

    const location = listing.location || 'Bellevue'; // HQ: Bellevue (GE)
    const canton = inferSwissTargetCanton(location) || 'GE';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} richemont ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `richemont-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RICHEMONT_COMPANY_NAME,
      companyKey: RICHEMONT_KEY,
      companyDomain: RICHEMONT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Richemont`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Richemont` },
      location,
      canton,
      url: publicUrl,
      source: 'Richemont Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Lusso', // Luxury goods (Cartier, IWC, Van Cleef & Arpels, ...)
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

  console.log(`\n📋 Total Richemont jobs discovered: ${jobs.length}`);
  return jobs;
}
