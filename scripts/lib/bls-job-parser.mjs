#!/usr/bin/env node
/**
 * BLS AG job parser — Fetcher and job builder.
 *
 * Source: https://www.bls.ch/en/unternehmen/jobs-und-karriere/offene-stellen
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBlsJobs()  — Fetch and parse all jobs
 *   - isBlsJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BLS_KEY = 'bls';
export const BLS_COMPANY_NAME = 'BLS AG';
export const BLS_COMPANY_DOMAIN = 'bls.ch';

const CAREER_URL = 'https://www.bls.ch/en/unternehmen/jobs-und-karriere/offene-stellen';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to BLS AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBlsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BLS_KEY ||
    key.startsWith('bls') ||
    company.includes('bls ag') ||
    url.includes('bls.ch')
  );
}

/**
 * Validate that a URL belongs to BLS AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bls.ch' || host.endsWith('.bls.ch');
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

/* ── Valais keywords for location filtering ──────────────── */

const VALAIS_KEYWORDS = [
  'brig', 'visp', 'sion', 'sierre', 'martigny', 'monthey',
  'naters', 'glis', 'wallis', 'valais', 'steg', 'raron',
  'leuk', 'gampel', 'kandersteg', 'lötschberg',
];

/* ── HTTP helpers ─────────────────────────────────────────── */

const LISTING_URL = 'https://www.bls.ch/en/unternehmen/jobs-und-karriere/offene-stellen';
const JOBS_BASE = 'https://jobs.bls.ch';

/**
 * Fetch a URL and return HTML text with timeout handling.
 */
async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse the BLS listing page HTML to extract job links.
 * Job detail links have the pattern:
 *   https://jobs.bls.ch/offene-stellen/{slug}/{uuid}
 *
 * Each link is accompanied by location and employment percentage.
 */
function parseListingPage(html = '') {
  const entries = [];

  // Match job links: jobs.bls.ch/offene-stellen/{slug}/{uuid}
  const linkPattern = /href="(https:\/\/jobs\.bls\.ch\/offene-stellen\/([^/]+)\/([0-9a-f-]{36}))"/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const fullUrl = match[1];
    const slug = decodeURIComponent(match[2]);
    const uuid = match[3];

    // Look at the surrounding context for metadata
    const start = Math.max(0, match.index - 200);
    const context = html.slice(start, match.index + 500);

    // Extract link text (title)
    const afterLink = html.slice(match.index, match.index + 500);
    const titleMatch = afterLink.match(/href="[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : slug.replace(/-/g, ' ');

    // Extract location from the context
    const locMatch = context.match(/(?:Brig|Visp|Sion|Bern|Thun|Spiez|Frutigen|Interlaken|Bönigen|Givisiez|Emmental|Oberaargau|Belgium|Germany)[^<]*/i);
    const locationRaw = locMatch ? normalizeSpace(locMatch[0]) : '';

    // Extract employment percentage
    const pctMatch = context.match(/(\d{1,3})\s*(?:[-–]\s*(\d{1,3}))?\s*%/);
    const pensum = pctMatch
      ? pctMatch[2]
        ? `${pctMatch[1]}-${pctMatch[2]}%`
        : `${pctMatch[1]}%`
      : '';

    entries.push({ url: fullUrl, slug, uuid, title, locationRaw, pensum });
  }

  // Deduplicate by uuid
  const seen = new Set();
  return entries.filter((e) => {
    if (seen.has(e.uuid)) return false;
    seen.add(e.uuid);
    return true;
  });
}

/**
 * Check if a job is in a Valais location based on listing page context.
 */
function isValaisJob(entry) {
  const combined = `${entry.locationRaw} ${entry.title}`.toLowerCase();
  return VALAIS_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Extract JSON-LD JobPosting data from a detail page HTML.
 */
function extractJsonLd(html = '') {
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      if (parsed?.['@type'] === 'JobPosting') return parsed;
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return null;
}

/**
 * Build a plain-text description from JSON-LD fields.
 */
function buildDescription(jsonLd = {}) {
  const parts = [];

  const mainDesc = stripHtml(jsonLd.description || '');
  if (mainDesc) parts.push(mainDesc);

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
 * Extract requirements from JSON-LD qualifications HTML.
 */
function extractRequirements(jsonLd = {}) {
  const qualHtml = jsonLd.qualifications || '';
  if (!qualHtml) return [];
  return [...qualHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => stripHtml(m[1]).trim())
    .filter((s) => s.length > 3);
}

/**
 * Extract location from JSON-LD jobLocation.
 */
function extractLocation(jsonLd = {}) {
  const loc = jsonLd.jobLocation || {};
  const address = loc?.address || {};
  const locality = normalizeSpace(address.addressLocality || '');
  const postalCode = normalizeSpace(address.postalCode || '');
  const streetAddress = normalizeSpace(address.streetAddress || '');
  const region = normalizeSpace(address.addressRegion || '');

  return { locality, postalCode, streetAddress, region };
}

/**
 * Detect employment type from JSON-LD and pensum info.
 */
function detectBlsEmploymentType(jsonLdType = '', pensum = '') {
  if (jsonLdType === 'PART_TIME') return 'PART_TIME';
  if (jsonLdType === 'FULL_TIME') return 'FULL_TIME';

  const pctMatch = pensum.match(/(\d+)/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    if (pct < 100) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Fetch all BLS AG jobs in Valais.
 * Strategy:
 *   1. Fetch the BLS listing page (inline HTML with job links)
 *   2. Filter for Valais locations
 *   3. Fetch each detail page at jobs.bls.ch for JSON-LD data
 *   4. Build ParsedJob objects
 *
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBlsJobs() {
  console.log(`🔍 Fetching BLS AG jobs`);
  console.log(`   Listing: ${LISTING_URL}`);
  console.log(`   Detail:  ${JOBS_BASE}/offene-stellen/{slug}/{uuid}`);
  console.log(`   Strategy: Listing page → filter Valais → detail JSON-LD\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const allEntries = parseListingPage(listingHtml);
  console.log(`  📋 Total jobs on listing page: ${allEntries.length}`);

  const valaisEntries = allEntries.filter(isValaisJob);
  console.log(`  🏔️ Valais jobs: ${valaisEntries.length}`);

  if (valaisEntries.length === 0) {
    console.warn('⚠️ No Valais BLS job listings found.');
    return [];
  }

  console.log(`\n  📋 Fetching ${valaisEntries.length} detail pages...\n`);

  const jobs = [];
  for (const entry of valaisEntries) {
    try {
      const detailHtml = await fetchHtml(entry.url);
      const jsonLd = extractJsonLd(detailHtml);

      if (!jsonLd) {
        console.warn(`  ⚠️ No JSON-LD found for: ${entry.url}`);
        continue;
      }

      const title = normalizeSpace(jsonLd.title || entry.title);
      if (!title || title.length < 3) continue;

      const loc = extractLocation(jsonLd);
      const location = loc.locality || entry.locationRaw || 'Brig';
      const canton = inferSwissTargetCanton(location) || 'VS';
      const descriptionText = buildDescription(jsonLd);
      const requirements = extractRequirements(jsonLd);

      const sourceLang = detectLang(descriptionText || title, 'de');
      const jobSlug = slugify(`${title} bls ch`);
      const urlHash = createHash('sha1').update(entry.url).digest('hex').slice(0, 12);

      const postedDate = normalizeSpace(jsonLd.datePosted || '').slice(0, 10)
        || new Date().toISOString().split('T')[0];
      const validThrough = normalizeSpace(jsonLd.validThrough || '').slice(0, 10);
      const employmentType = detectBlsEmploymentType(
        jsonLd.employmentType || '',
        entry.pensum
      );

      // Salary from JSON-LD baseSalary
      const salary = jsonLd.baseSalary?.value?.value || '';
      const salaryCurrency = jsonLd.baseSalary?.currency || 'CHF';

      const applyUrl = `${JOBS_BASE}/apply/ats/${entry.uuid}`;

      const job = {
        // ── Required fields ──
        id: `bls-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: BLS_COMPANY_NAME,
        companyKey: BLS_KEY,
        companyDomain: BLS_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — BLS AG`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — BLS AG` },
        location,
        canton,
        url: entry.url,
        source: 'BLS AG Dedicated Parser',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Location details ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        ...(loc.postalCode ? { postalCode: loc.postalCode } : {}),
        ...(loc.streetAddress ? { streetAddress: loc.streetAddress } : {}),

        // ── Job metadata ──
        category: detectCategory(title),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        sector: 'Trasporti / Ferrovia',
        currency: salaryCurrency,
        featured: false,
        postedDate,
        ...(validThrough ? { validThrough } : {}),
        ...(entry.pensum ? { pensum: entry.pensum } : {}),
        ...(salary ? { salary: String(salary) } : {}),
        applyUrl,
        requirements,
        requirementsByLocale: { [sourceLang]: requirements },
      };

      jobs.push(job);
      console.log(`  ✅ ${entry.uuid.slice(0, 8)} — ${title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${entry.uuid.slice(0, 8)} — ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n📋 Total BLS AG Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
