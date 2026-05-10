#!/usr/bin/env node
/**
 * Stadtspital Zürich (Triemli + Waid) job parser — PLACEHOLDER.
 *
 * Source: https://www.stadtspital.ch/karriere
 *
 * ⚠️ Follow-up needed: the public site geo-blocks non-CH egress at the
 * TCP level (connect timeouts from the dev tunnel + Anthropic egress IPs),
 * so the ATS could not be fingerprinted from this scaffold session.
 * Likely candidates for the city of Zürich's municipal portal:
 *   1. Umantis (`recruitingapp-XXXX.umantis.com`) — same flavour as
 *      Inselspital + Spital Davos. Clone `inselspital-job-parser.mjs` once
 *      tenant ID is known.
 *   2. Prospective (`ohws.prospective.ch/careercenter/{tenant}/`) — same
 *      flavour as USZ + Universitätsspital Basel. Clone the USZ Prospective
 *      adapter and swap the tenant ID.
 *   3. SAP SuccessFactors Career Site Builder. Clone the KSSG/HOCH adapter.
 *
 * Action item: probe `https://www.stadtspital.ch/karriere` from a CH IP
 * (or via Playwright on a CH-hosted runner) to read the embedded ATS link,
 * then replace `fetchJobListings()` below with the correct adapter.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStadtspitalZuerichJobs()  — Fetch and parse all jobs
 *   - isStadtspitalZuerichJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()                 — Validate URLs belong to this company
 *   - STADTSPITAL_ZUERICH_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STADTSPITAL_ZUERICH_KEY = 'stadtspital-zuerich';
export const STADTSPITAL_ZUERICH_COMPANY_NAME = 'Stadtspital Zürich';
export const STADTSPITAL_ZUERICH_COMPANY_DOMAIN = 'stadtspital.ch';

const CAREER_URL = 'https://www.stadtspital.ch/karriere';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Stadtspital Zürich.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isStadtspitalZuerichJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STADTSPITAL_ZUERICH_KEY ||
    key.startsWith('stadtspital-zuerich') ||
    company.includes('stadtspital zürich') ||
    url.includes('stadtspital.ch')
  );
}

/**
 * Validate that a URL belongs to Stadtspital Zürich's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'stadtspital.ch' || host.endsWith('.stadtspital.ch');
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

// TODO: Implement the actual fetching logic for Stadtspital Zürich's career page.
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
 * Fetch all Stadtspital Zürich jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllStadtspitalZuerichJobs() {
  console.log(`🔍 Fetching Stadtspital Zürich jobs`);
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

    const location = listing.location || 'Zürich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} stadtspital-zuerich ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `stadtspital-zuerich-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STADTSPITAL_ZUERICH_COMPANY_NAME,
      companyKey: STADTSPITAL_ZUERICH_KEY,
      companyDomain: STADTSPITAL_ZUERICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Stadtspital Zürich`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Stadtspital Zürich` },
      location,
      canton,
      url: publicUrl,
      source: 'Stadtspital Zürich Dedicated Parser',
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

  console.log(`\n📋 Total Stadtspital Zürich jobs discovered: ${jobs.length}`);
  return jobs;
}
