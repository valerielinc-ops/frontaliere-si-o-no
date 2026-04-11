#!/usr/bin/env node
/**
 * Somedia AG job parser — rexx systems ATS HTML scraper + JSON-LD.
 *
 * Source: https://jobs.somedia.ch/stellenangebote.html
 *
 * Strategy:
 *   1. Fetch the listing page HTML
 *   2. Extract job detail links (pattern: *-de-j{ID}.html)
 *   3. Fetch each detail page and extract the JobPosting JSON-LD
 *   4. Build ParsedJob objects from structured data
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSomediaJobs()  — Fetch and parse all jobs
 *   - isSomediaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SOMEDIA_KEY = 'somedia';
export const SOMEDIA_COMPANY_NAME = 'Somedia AG';
export const SOMEDIA_COMPANY_DOMAIN = 'somedia.ch';

const CAREER_URL = 'https://jobs.somedia.ch/stellenangebote.html';
const BASE_URL = 'https://jobs.somedia.ch';
const HQ = getCompanyDefaults(SOMEDIA_KEY);

/* ── Graubünden postal codes ─────────────────────────────── */

const GR_POSTAL_CODES = {
  chur: '7000',
  davos: '7270',
  'st. moritz': '7500',
  'saint moritz': '7500',
  arosa: '7050',
  ilanz: '7130',
  thusis: '7430',
  scuol: '7550',
  poschiavo: '7742',
  landquart: '7302',
  maienfeld: '7304',
  samedan: '7503',
  disentis: '7180',
  klosters: '7250',
  lenzerheide: '7078',
  flims: '7018',
  laax: '7031',
  domat: '7013',
  'domat/ems': '7013',
  ems: '7013',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Somedia AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSomediaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SOMEDIA_KEY ||
    key.startsWith('somedia') ||
    company.includes('somedia ag') ||
    company.includes('somedia') ||
    url.includes('somedia.ch')
  );
}

/**
 * Validate that a URL belongs to Somedia AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'somedia.ch' || host.endsWith('.somedia.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const t = normalize(`${title} ${description}`);
  if (/\b(redakt|journalist|reporter|text|autor|editor|korrespond)/.test(t)) return 'Media / Giornalismo';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|druck|print)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|berater|kundenberater)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualita';
  if (/\b(it|software|develop|programm|web|digital|system|informatik)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|werbung|media.?berat)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|hochschulpraktik)/.test(t)) return 'intern';
  if (/\b(junior|jr|quereinsteig)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|teamleit)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '', jsonLdType = '') {
  const t = normalize(title);

  // Extract percentage range from title
  const pctMatch = t.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (pctMatch) {
    const hi = parseInt(pctMatch[2], 10);
    if (hi < 100) return 'PART_TIME';
  }

  // Use JSON-LD employmentType if available
  if (jsonLdType) {
    const ldType = normalize(jsonLdType);
    if (ldType === 'full_time') return 'FULL_TIME';
    if (ldType === 'part_time') return 'PART_TIME';
    if (ldType === 'intern') return 'INTERN';
  }

  if (/\b(teilzeit|part.?time|tempo parziale)/.test(t)) return 'PART_TIME';
  if (/\b(vollzeit|full.?time|tempo pieno)/.test(t)) return 'FULL_TIME';
  if (/\b(praktik|intern|stage)/.test(t)) return 'INTERN';
  return 'OTHER';
}

/**
 * Infer postal code from a locality name.
 */
function inferPostalCode(locality = '') {
  const key = normalize(locality)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  for (const [name, code] of Object.entries(GR_POSTAL_CODES)) {
    const normName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (key.includes(normName) || normName.includes(key)) return code;
  }
  return HQ.postalCode; // Default to Chur (Somedia headquarters)
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Extract job detail links from the rexx systems listing page HTML.
 * Links follow the pattern: *-de-j{ID}.html
 */
export function extractJobLinks(html = '') {
  const links = new Map();
  // Match href attributes pointing to job detail pages
  const pattern = /href="([^"]*-de-j(\d+)\.html)(?:\?[^"]*)?"[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const path = match[1];
    const jobId = match[2];
    if (!links.has(jobId)) {
      // Build absolute URL, stripping any session ID query params
      const cleanPath = path.replace(/\?.*$/, '');
      const url = cleanPath.startsWith('http') ? cleanPath : `${BASE_URL}/${cleanPath.replace(/^\//, '')}`;
      links.set(jobId, url);
    }
  }
  return Array.from(links.entries()).map(([id, url]) => ({ rexxId: id, detailUrl: url }));
}

/**
 * Extract JSON-LD JobPosting data from a detail page HTML.
 */
export function extractJsonLd(html = '') {
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      if (parsed?.['@type'] === 'JobPosting') return parsed;
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }
  return null;
}

/**
 * Build a plain-text description from the JSON-LD description HTML.
 */
function buildDescription(jsonLd = {}) {
  const parts = [];

  const mainDesc = stripHtml(jsonLd.description || '');
  if (mainDesc) parts.push(mainDesc);

  // responsibilities, qualifications, and jobBenefits may duplicate content
  // from the main description — only append if they add new info
  const mainLower = mainDesc.toLowerCase();

  const responsibilities = stripHtml(jsonLd.responsibilities || '');
  if (responsibilities && !mainLower.includes(responsibilities.toLowerCase().slice(0, 40))) {
    parts.push(`Aufgaben:\n${responsibilities}`);
  }

  const qualifications = stripHtml(jsonLd.qualifications || '');
  if (qualifications && !mainLower.includes(qualifications.toLowerCase().slice(0, 40))) {
    parts.push(`Anforderungen:\n${qualifications}`);
  }

  const benefits = stripHtml(jsonLd.jobBenefits || '');
  if (benefits && !mainLower.includes(benefits.toLowerCase().slice(0, 40))) {
    parts.push(`Vorteile:\n${benefits}`);
  }

  return parts.join('\n\n').trim();
}

/**
 * Extract the primary location from JSON-LD jobLocation.
 * Returns { locality, postalCode, streetAddress, canton }.
 */
function extractLocation(jsonLd = {}) {
  const locations = Array.isArray(jsonLd.jobLocation) ? jsonLd.jobLocation : [jsonLd.jobLocation].filter(Boolean);
  if (locations.length === 0) {
    return { locality: HQ.city, postalCode: HQ.postalCode, streetAddress: HQ.city, canton: HQ.canton };
  }

  // Use the first location as primary
  const primary = locations[0];
  const address = primary?.address || {};
  const locality = normalizeSpace(address.addressLocality || HQ.city);
  const postalCode = normalizeSpace(address.postalCode || '') || inferPostalCode(locality);
  const streetAddress = normalizeSpace(address.streetAddress || '');

  // Infer canton from locality
  let canton = HQ.canton;
  const inferred = inferSwissTargetCanton(locality);
  if (inferred) canton = inferred;

  // Build combined location string for multi-location jobs
  const allLocalities = locations
    .map((loc) => normalizeSpace(loc?.address?.addressLocality || ''))
    .filter(Boolean);
  const locationStr = allLocalities.length > 1 ? allLocalities.join(', ') : locality;

  return { locality: locationStr, postalCode, streetAddress, canton };
}

/**
 * Extract requirements from JSON-LD qualifications HTML.
 */
function extractRequirements(jsonLd = {}) {
  const qualHtml = jsonLd.qualifications || '';
  if (!qualHtml) return [];

  // Extract list items from HTML
  const items = [...qualHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => stripHtml(m[1]).trim())
    .filter((s) => s.length > 2);

  return items;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch the listing page and extract job links.
 */
async function fetchJobLinks() {
  console.log(`   Fetching listing page: ${CAREER_URL}`);
  const html = await fetchHtml(CAREER_URL);
  const links = extractJobLinks(html);
  console.log(`   Found ${links.length} job links on listing page`);
  return links;
}

/**
 * Fetch a job detail page and extract structured data.
 */
async function fetchJobDetail(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const jsonLd = extractJsonLd(html);
  return { html, jsonLd };
}

/**
 * Build a ParsedJob from JSON-LD data and detail page info.
 */
function buildJobFromJsonLd(jsonLd, detailUrl, rexxId) {
  const title = normalizeSpace(jsonLd.title || '');
  if (!title || title.length < 3) return null;

  const location = extractLocation(jsonLd);
  const descriptionText = buildDescription(jsonLd);
  const requirements = extractRequirements(jsonLd);
  const sourceLang = detectLang(descriptionText || title, 'de');
  const jobSlug = slugify(`${title} ${SOMEDIA_KEY} ch`);
  const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

  const postedDate = normalizeSpace(jsonLd.datePosted || '').slice(0, 10);
  const validThrough = normalizeSpace(jsonLd.validThrough || '').slice(0, 10);

  return {
    // ── Required fields ──
    id: `${SOMEDIA_KEY}-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: SOMEDIA_COMPANY_NAME,
    companyKey: SOMEDIA_KEY,
    companyDomain: SOMEDIA_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || `${title} — ${SOMEDIA_COMPANY_NAME}`,
    descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${SOMEDIA_COMPANY_NAME}` },
    location: location.locality,
    canton: location.canton,
    url: detailUrl,
    source: 'Somedia AG Dedicated Parser (Rexx Systems)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: location.locality,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: location.postalCode,
    streetAddress: location.streetAddress || location.locality,
    category: detectCategory(title, descriptionText),
    sector: 'Media / Editoria',
    contract: 'full-time',
    employmentType: detectEmploymentType(title, jsonLd.employmentType || ''),
    experienceLevel: detectExperienceLevel(title),
    currency: 'CHF',
    featured: false,
    postedDate: postedDate || new Date().toISOString().split('T')[0],
    validThrough: validThrough || '',
    applyUrl: detailUrl.replace(/-de-j(\d+)\.html$/, `-de-f$1.html`),
    requirements,
    requirementsByLocale: { [sourceLang]: requirements },

    // ── Internal metadata ──
    _somediaMeta: {
      rexxId,
      identifier: normalizeSpace(jsonLd.identifier || ''),
      hiringOrganization: normalizeSpace(jsonLd.hiringOrganization?.name || ''),
    },
  };
}

/**
 * Fetch all Somedia AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSomediaJobs() {
  console.log(`🔍 Fetching Somedia AG jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const jobLinks = await fetchJobLinks();
  if (!jobLinks || jobLinks.length === 0) {
    console.warn('⚠️ No job links found on listing page.');
    return [];
  }

  console.log(`\n  📋 Job links found: ${jobLinks.length}. Fetching detail pages...\n`);

  const jobs = [];
  for (const { rexxId, detailUrl } of jobLinks) {
    try {
      const { jsonLd } = await fetchJobDetail(detailUrl);

      if (!jsonLd) {
        console.warn(`  ⚠️ No JSON-LD found for j${rexxId}: ${detailUrl}`);
        continue;
      }

      const job = buildJobFromJsonLd(jsonLd, detailUrl, rexxId);
      if (!job) {
        console.warn(`  ⚠️ Could not build job from j${rexxId}: ${detailUrl}`);
        continue;
      }

      jobs.push(job);
      console.log(`  ✅ j${rexxId} — ${job.title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping j${rexxId} — fetch failed: ${err?.message || err}`);
    }

    // Rate limit: 500ms between detail page fetches
    await new Promise((r) => setTimeout(r, 500));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total Somedia AG jobs discovered: ${deduped.length}`);
  return deduped;
}
