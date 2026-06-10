#!/usr/bin/env node
/**
 * SBB CFF FFS job parser — Fetcher and job builder.
 *
 * Source: https://company.sbb.ch/de/jobs-karriere/jobs/offene-stellen.html
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSbbJobs()  — Fetch and parse all jobs
 *   - isSbbJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SBB_KEY = 'sbb';
export const SBB_COMPANY_NAME = 'SBB CFF FFS';
export const SBB_COMPANY_DOMAIN = 'sbb.ch';

const CAREER_URL = 'https://company.sbb.ch/de/jobs-karriere/jobs/offene-stellen.html';

// Custom AEM job-filter endpoint: returns a flat JSON array of ALL open jobs in
// one response (no pagination — offset/keyword params are ignored, filtering is
// client-side). The entire feed is Switzerland-only, so no CH filter is needed.
const JOBS_API_URL =
  'https://company.sbb.ch/content/internet/corporate/de/jobs-karriere/jobs/job-suche/jcr:content/parmain/jobfilter.results.json';

// Real job-posting host (from links.directlink, e.g.
// https://jobs.sbb.ch/v2/offene-stellen/{slug}/{viewkey}).
const JOBS_POSTING_HOST = 'jobs.sbb.ch';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to SBB CFF FFS.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSbbJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SBB_KEY ||
    key.startsWith('sbb') ||
    company.includes('sbb cff ffs') ||
    url.includes('sbb.ch')
  );
}

/**
 * Validate that a URL belongs to SBB CFF FFS's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'sbb.ch' ||
      host.endsWith('.sbb.ch') || // covers company.sbb.ch + jobs.sbb.ch (real posting host)
      host === JOBS_POSTING_HOST
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

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'de-CH,de;q=0.9',
  Referer: CAREER_URL,
};

/**
 * Pull the first 2-letter canton code out of an SBB region label such as
 * 'Tessin (TI)' or 'Zürich (ZH/AG/SH/ZG)' → 'TI' / 'ZH'.
 */
function cantonFromRegionLabel(label = '') {
  const m = String(label).match(/\(([A-Z]{2})(?:[/)]|\s)/);
  return m ? m[1] : null;
}

/**
 * Fetch the SBB job-filter JSON feed (flat array of all open CH jobs).
 * Returns raw listing objects normalized to {title, location, url, postedAt, description, jobReqId}.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${JOBS_API_URL}`);

  const data = await fetchJson(JOBS_API_URL, { headers: REQUEST_HEADERS });
  const rows = Array.isArray(data) ? data : data?.jobs || data?.results || [];

  const listings = [];
  for (const row of rows) {
    const attrs = row?.attributes || {};
    const cities = Array.isArray(attrs['100']) ? attrs['100'] : [];
    const regions = Array.isArray(attrs['110']) ? attrs['110'] : [];
    const pensum = Array.isArray(attrs['50']) ? attrs['50'].join(' ') : '';
    const workload = Array.isArray(attrs['160']) ? attrs['160'][0] : '';

    const city = cities.find(Boolean) || '';
    const regionLabel = regions.find(Boolean) || '';
    const url = row?.links?.directlink || '';

    listings.push({
      title: row?.title || '',
      location: city || regionLabel,
      regionCanton: cantonFromRegionLabel(regionLabel),
      url,
      postedAt: row?.start_date || row?.last_modification_timestamp || '',
      // The feed has no real description body (`text` is keyword soup); the AI
      // localization pipeline enriches downstream. Seed with title context.
      description: '',
      employmentHint: `${pensum} ${workload}`.trim(),
      jobReqId: row?.id || row?.viewkey || '',
    });
  }

  return listings;
}

/**
 * Fetch all SBB CFF FFS jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSbbJobs() {
  console.log(`🔍 Fetching SBB CFF FFS jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url || CAREER_URL;
    if (publicUrl !== CAREER_URL && !isTrustedDomain(publicUrl)) continue;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const location = normalizeSpace(listing.location) || 'Bern';
    // City first (more precise), then the 2-letter code from the region label,
    // finally the HQ canton (Bern / BE). Whole feed is CH-only per recon.
    const canton =
      inferSwissTargetCanton(location) || listing.regionCanton || 'BE';

    const descriptionText = stripHtml(listing.description || '');
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} sbb ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const description = descriptionText || `${title} — SBB / CFF / FFS, ${location}`;

    const job = {
      // ── Required fields ──
      id: `sbb-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SBB_COMPANY_NAME,
      companyKey: SBB_KEY,
      companyDomain: SBB_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'SBB CFF FFS Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      // Postal code / region only reliable for the HQ canton; otherwise leave to
      // the geocoding/normalization step.
      ...(canton === 'BE' ? { postalCode: '3000', addressRegion: 'Bern' } : {}),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.employmentHint || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Public transport / Rail',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt
        ? new Date(listing.postedAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total SBB CFF FFS jobs discovered: ${jobs.length}`);
  return jobs;
}
