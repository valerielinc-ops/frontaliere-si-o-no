#!/usr/bin/env node
/**
 * Scandit AG job parser — Fetcher and job builder.
 *
 * Source: https://job-boards.greenhouse.io/scandit
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllScanditJobs()  — Fetch and parse all jobs
 *   - isScanditJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchGreenhouseJobs,
  extractGreenhouseBoardToken,
} from './ats-clients/greenhouse-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SCANDIT_KEY = 'scandit';
export const SCANDIT_COMPANY_NAME = 'Scandit AG';
export const SCANDIT_COMPANY_DOMAIN = 'scandit.com';

const CAREER_URL = 'https://job-boards.greenhouse.io/scandit';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Scandit AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isScanditJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SCANDIT_KEY ||
    key.startsWith('scandit') ||
    company.includes('scandit ag') ||
    url.includes('scandit.com')
  );
}

/**
 * Validate that a URL belongs to Scandit AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'scandit.com' || host.endsWith('.scandit.com');
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

/* ── Greenhouse fetcher ───────────────────────────────────────
 * Pass either a boards.greenhouse.io URL (auto-extracts board token) or
 * override GREENHOUSE_BOARD_TOKEN below. Location filter is a list of
 * substrings matched (case-insensitive) against `location.name`.
 */
const GREENHOUSE_BOARD_TOKEN =
  extractGreenhouseBoardToken(CAREER_URL) || SCANDIT_KEY;
// Scandit is HQ'd in Zurich but hires globally (Boston, Tampere, London,
// Warsaw, Poland, Italy, Germany, UK…). Many of those requisitions are
// posted per-country from a single "Remote - Europe" pool whose `offices[]`
// metadata always lists the Zurich HQ office alongside the actual target
// country — so filtering via the shared client's `locationContains` (which
// also matches against `offices[]`) would false-positive on e.g. "Germany"
// or "Warsaw" postings. We fetch unfiltered and match only the resolved
// primary `location` string ourselves instead.
const SWISS_LOCATION_RE = /zurich|zürich|switzerland|schweiz|suisse|svizzera/i;

async function fetchJobListings() {
  const jobs = await fetchGreenhouseJobs(GREENHOUSE_BOARD_TOKEN, {
    includeContent: true,
    companyName: SCANDIT_COMPANY_NAME,
  });
  return jobs
    .filter((j) => SWISS_LOCATION_RE.test(j.location || ''))
    .map((j) => ({
      title: j.title,
      location: j.location,
      url: j.applyUrl,
      postedAt: j.postedAt,
      description: j.descriptionHtml || '',
      jobReqId: j.jobReqId,
    }));
}

/**
 * Fetch all Scandit AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllScanditJobs() {
  console.log(`🔍 Fetching Scandit AG jobs`);
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

    const location = listing.location || 'Zürich'; // Scandit HQ; Swiss listings default here
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} scandit ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `scandit-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SCANDIT_COMPANY_NAME,
      companyKey: SCANDIT_KEY,
      companyDomain: SCANDIT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Scandit AG`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Scandit AG` },
      location,
      canton,
      url: publicUrl,
      source: 'Scandit AG Dedicated Parser',
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
      sector: 'IT', // Computer vision / smart data capture software
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

  console.log(`\n📋 Total Scandit AG jobs discovered: ${jobs.length}`);
  return jobs;
}
