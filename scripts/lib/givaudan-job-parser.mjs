#!/usr/bin/env node
/**
 * Givaudan job parser — Fetcher and job builder.
 *
 * Source: https://careers.givaudan.com/global/en/europe
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGivaudanJobs()  — Fetch and parse all jobs
 *   - isGivaudanJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GIVAUDAN_KEY = 'givaudan';
export const GIVAUDAN_COMPANY_NAME = 'Givaudan';
export const GIVAUDAN_COMPANY_DOMAIN = 'givaudan.com';

const CAREER_URL = 'https://careers.givaudan.com/global/en/europe';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Givaudan.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGivaudanJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GIVAUDAN_KEY ||
    key.startsWith('givaudan') ||
    company.includes('givaudan') ||
    url.includes('givaudan.com')
  );
}

/**
 * Validate that a URL belongs to Givaudan's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'givaudan.com' || host.endsWith('.givaudan.com');
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

// TODO: Implement the actual fetching logic for Givaudan's career page.
// This is a placeholder. Replace with the actual API/scraping logic.
//
// Common patterns:
//   - JSON API:     use --source api for a ready-made paginated API template
//   - Workday API:  re-scaffold with --ats=workday for a ready-made template
//   - Greenhouse:   --ats=greenhouse
//   - Lever:        --ats=lever
//   - SuccessFactors: --ats=successfactors
//   - Generic HTML: fetch + parse with regex or cheerio

/* ── Givaudan / Phenom People notes ────────────────────────────
 * Givaudan careers run on Phenom People (CareerConnect). The site is a
 * client-rendered SPA — `careers.givaudan.com/global/en/europe` returns
 * 0 job links via plain `fetch`. The Phenom REST APIs we probed
 * (/api/jobs, /api/jobs/locations/Switzerland, /widgets) all return
 * 500 / "Tenant not identified" / 404 from a server-side caller without
 * a browser session that primes the Phenom tenant cookie + CSRF token.
 *
 * Implementation plan (Playwright path — workflow already installs Chromium):
 *   1. Launch headless Chromium.
 *   2. Navigate to https://careers.givaudan.com/global/en/europe.
 *   3. Use the on-page country filter to narrow to Switzerland (or post-
 *      filter via `inferSwissTargetCanton(locationsText)` after the listing
 *      loads — Phenom renders job cards with `data-ph-id="ph-page-element-...
 *      job-list-card"` once the SPA hydrates).
 *   4. Loop pagination ("Load more") until exhausted or until 100 cards.
 *   5. For each card, read title / locationsText / job URL out of the DOM
 *      and push to the `out` array.
 *   6. Be polite: 600ms inter-page delay, abort on a single network error.
 *
 * Reference: scripts/lib/playwright-runtime.mjs (already used by
 * --playwright-tier crawlers).
 */

async function fetchJobListings() {
  // TODO: implement Playwright-based Phenom scraper per the notes above.
  console.log(`   Fetching from: ${CAREER_URL}`);
  console.warn('   ⚠️ Phenom SPA scraper not implemented yet — returning [].');
  return [];
}

/**
 * Fetch all Givaudan jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGivaudanJobs() {
  console.log(`🔍 Fetching Givaudan jobs`);
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

    const location = listing.location || 'Vernier'; // Givaudan global HQ
    const canton = inferSwissTargetCanton(location) || 'GE';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} givaudan ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `givaudan-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GIVAUDAN_COMPANY_NAME,
      companyKey: GIVAUDAN_KEY,
      companyDomain: GIVAUDAN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Givaudan`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Givaudan` },
      location,
      canton,
      url: publicUrl,
      source: 'Givaudan Dedicated Parser',
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
      sector: 'Industria', // Flavours & fragrances / specialty chemicals
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

  console.log(`\n📋 Total Givaudan jobs discovered: ${jobs.length}`);
  return jobs;
}
