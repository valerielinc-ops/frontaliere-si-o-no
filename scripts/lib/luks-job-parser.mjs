#!/usr/bin/env node
/**
 * Luzerner Kantonsspital (LUKS) job parser — PLACEHOLDER.
 *
 * Source: https://www.luks.ch/stellen-und-karriere/offene-stellen
 *
 * ⚠️ Follow-up needed: at the time of scaffolding (2026-05-10) the LUKS
 * Gatsby site (`gatsby-source-silverback` build, Drupal 10 CMS at
 * `cms.luks.ch`) renders the open-positions page with an empty
 * `advertCollection` — i.e. the public site is currently NOT exposing
 * job adverts at all (corroborated by the May newsroom note
 * "Wiedereinführung des JobAbos am Luzerner Kantonsspital").
 *
 * Once LUKS re-introduces public job listings, two likely shapes:
 *   1. Drupal-sourced adverts baked into Gatsby `page-data` JSONs under
 *      `/page-data/stellen-und-karriere/offene-stellen/.../page-data.json`.
 *      Walk the sitemap (`/sitemap-0.xml`) for advert URLs once they
 *      reappear and read each `page-data.json`.
 *   2. An external ATS link embedded in the page (Prospective / Umantis /
 *      SuccessFactors) — clone the matching adapter (USZ / Inselspital /
 *      KSSG) and swap the tenant ID.
 *
 * Action item: re-probe `https://www.luks.ch/stellen-und-karriere/offene-stellen`
 * monthly. When the page returns a populated advert list, replace
 * `fetchJobListings()` below with the correct adapter.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLuksJobs()  — Fetch and parse all jobs
 *   - isLuksJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company
 *   - LUKS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LUKS_KEY = 'luks';
export const LUKS_COMPANY_NAME = 'Luzerner Kantonsspital (LUKS)';
export const LUKS_COMPANY_DOMAIN = 'luks.ch';

const CAREER_URL = 'https://www.luks.ch/stellen-und-karriere/offene-stellen';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Luzerner Kantonsspital (LUKS).
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLuksJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LUKS_KEY ||
    key.startsWith('luks') ||
    company.includes('luzerner kantonsspital (luks)') ||
    url.includes('luks.ch')
  );
}

/**
 * Validate that a URL belongs to Luzerner Kantonsspital (LUKS)'s domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'luks.ch' || host.endsWith('.luks.ch');
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

// TODO: Implement the actual fetching logic for Luzerner Kantonsspital (LUKS)'s career page.
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
 * Fetch all Luzerner Kantonsspital (LUKS) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLuksJobs() {
  console.log(`🔍 Fetching Luzerner Kantonsspital (LUKS) jobs`);
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

    const location = listing.location || 'Luzern';
    const canton = inferSwissTargetCanton(location) || 'LU';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} luks ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `luks-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LUKS_COMPANY_NAME,
      companyKey: LUKS_KEY,
      companyDomain: LUKS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Luzerner Kantonsspital (LUKS)`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Luzerner Kantonsspital (LUKS)` },
      location,
      canton,
      url: publicUrl,
      source: 'Luzerner Kantonsspital (LUKS) Dedicated Parser',
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
      sector: 'Sanità / Ospedali',
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

  console.log(`\n📋 Total Luzerner Kantonsspital (LUKS) jobs discovered: ${jobs.length}`);
  return jobs;
}
