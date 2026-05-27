#!/usr/bin/env node
/**
 * BMS Building Materials job parser — Fetcher and job builder.
 *
 * Source: https://jobs.bmsuisse.ch/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBmsBuildingJobs()  — Fetch and parse all jobs
 *   - isBmsBuildingJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BMS_BUILDING_KEY = 'bms-building';
export const BMS_BUILDING_COMPANY_NAME = 'BMS Building Materials';
export const BMS_BUILDING_COMPANY_DOMAIN = 'bmsuisse.ch';

const CAREER_URL = 'https://jobs.bmsuisse.ch/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to BMS Building Materials.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBmsBuildingJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BMS_BUILDING_KEY ||
    key.startsWith('bms-building') ||
    company.includes('bms building materials') ||
    url.includes('bmsuisse.ch')
  );
}

/**
 * Validate that a URL belongs to BMS Building Materials's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bmsuisse.ch' || host.endsWith('.bmsuisse.ch');
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
  'naters', 'brig', 'visp', 'sion', 'sierre', 'martigny',
  'monthey', 'glis', 'wallis', 'valais', 'conthey',
  'st-maurice', 'saxon', 'leuk', 'steg', 'raron',
];

/* ── HTTP helpers ─────────────────────────────────────────── */

const LISTING_URL = 'https://jobs.bmsuisse.ch/jobs/offene-stellen/';
const JOB_BASE = 'https://jobs.bmsuisse.ch';

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
 * Parse the BMS listing page HTML to extract job entries.
 * Each job appears as a link to /jobs/detail/{id}-{slug}/
 * with location info (postal code + city) and employment type.
 */
function parseListingPage(html = '') {
  const entries = [];

  // Match job detail links: /jobs/detail/{id}-{slug}/
  const linkPattern = /href="(\/jobs\/detail\/(\d+)-[^"]+)"/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const jobId = match[2];
    const fullUrl = `${JOB_BASE}${relUrl}`;

    // Look at the surrounding context (500 chars after the link) for metadata
    const context = html.slice(match.index, match.index + 800);

    // Extract title from the anchor tag content
    const titleMatch = context.match(/href="[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

    // Extract location (postal code + city pattern)
    const locMatch = context.match(/(\d{4})\s+([\w\u00C0-\u024F\s\-.]+?)(?:\s*<|,|\n)/);
    const postalCode = locMatch ? locMatch[1] : '';
    const city = locMatch ? normalizeSpace(locMatch[2]) : '';

    // Extract employment type (Full-time / Part-time)
    const empMatch = context.match(/(?:Full-time|Part-time|Vollzeit|Teilzeit)/i);
    const employmentRaw = empMatch ? empMatch[0] : '';

    if (title && title.length >= 3) {
      entries.push({
        jobId,
        url: fullUrl,
        title,
        city,
        postalCode,
        employmentRaw,
      });
    }
  }

  // Deduplicate by jobId
  const seen = new Set();
  return entries.filter((e) => {
    if (seen.has(e.jobId)) return false;
    seen.add(e.jobId);
    return true;
  });
}

/**
 * Check if a job is in a Valais location.
 */
function isValaisJob(entry) {
  const combined = `${entry.city} ${entry.postalCode}`.toLowerCase();
  // Valais postal codes: 1870-1997 (Bas-Valais) and 3900-3999 (Haut-Valais)
  const pc = parseInt(entry.postalCode, 10);
  if (pc >= 1870 && pc <= 1997) return true;
  if (pc >= 3900 && pc <= 3999) return true;
  return VALAIS_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Parse a BMS detail page to extract the full job description.
 * Tries multiple extraction strategies since the page structure varies.
 */
function parseDetailPage(html = '') {
  if (!html) return null;

  // Title from <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';

  // Try multiple extraction patterns for the job description content
  let description = '';

  // Strategy 1: Look for job-specific content sections
  const jobDescMatch = html.match(/<div[^>]*class="[^"]*(?:job[_-]?desc|job[_-]?content|job[_-]?detail|stellenbeschreibung|beschreibung)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (jobDescMatch) description = stripHtml(jobDescMatch[1]).trim();

  // Strategy 2: Extract body content between common landmarks
  if (!description || description.length < 30) {
    const bodyMatch = html.match(/<div[^>]*class="[^"]*(?:entry[_-]?content|page[_-]?content|main[_-]?content|post[_-]?content|text[_-]?content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (bodyMatch) {
      const text = stripHtml(bodyMatch[1]).trim();
      if (text.length > description.length) description = text;
    }
  }

  // Strategy 3: <main> or <article> content
  if (!description || description.length < 30) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch) {
      const text = stripHtml(mainMatch[1]).trim();
      if (text.length > description.length) description = text;
    }
  }

  // Strategy 4: Collect all paragraphs and list items from the page body
  if (!description || description.length < 30) {
    const paragraphs = [...html.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)]
      .map((m) => stripHtml(m[1]).trim())
      .filter((s) => s.length > 10);
    if (paragraphs.length > 0) {
      const combined = paragraphs.join('\n');
      if (combined.length > description.length) description = combined;
    }
  }

  // Strategy 5: JSON-LD structured data
  if (!description || description.length < 30) {
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const ldDesc = ld?.description || ld?.['@graph']?.[0]?.description || '';
        if (ldDesc && ldDesc.length > description.length) {
          description = stripHtml(ldDesc).trim();
        }
      } catch { /* ignore JSON parse errors */ }
    }
  }

  // Extract apply URL (Onlyfy pattern or generic apply link)
  const applyMatch = html.match(/href="(https:\/\/bmsuisse\.onlyfy\.jobs\/[^"]+)"/i)
    || html.match(/href="([^"]*(?:apply|bewerb|onlyfy)[^"]*)"/i);
  const applyUrl = applyMatch ? applyMatch[1] : '';

  // Extract requirements (look for list items in requirement sections)
  const reqMatch = html.match(/(?:Anforderungen|Requirements|Profil|bringst du mit)([\s\S]*?)(?:<h[23]|<\/section|$)/i);
  const requirements = reqMatch
    ? [...reqMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => stripHtml(m[1]).trim())
        .filter((s) => s.length > 3)
    : [];

  return { title, description, applyUrl, requirements };
}

/**
 * Fetch all BMS Building Materials jobs in Valais.
 * Strategy:
 *   1. Fetch the listing page HTML
 *   2. Parse job entries from HTML
 *   3. Filter for Valais locations
 *   4. Fetch detail pages for richer descriptions
 *
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBmsBuildingJobs() {
  console.log(`🔍 Fetching BMS Building Materials jobs`);
  console.log(`   Source: ${LISTING_URL}`);
  console.log(`   Strategy: Listing page → filter Valais → detail pages\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const allEntries = parseListingPage(listingHtml);
  console.log(`  📋 Total jobs on listing page: ${allEntries.length}`);

  const valaisEntries = allEntries.filter(isValaisJob);
  console.log(`  🏔️ Valais jobs: ${valaisEntries.length}`);

  if (valaisEntries.length === 0) {
    console.warn('⚠️ No Valais job listings found.');
    return [];
  }

  console.log(`\n  📋 Fetching ${valaisEntries.length} detail pages...\n`);

  const jobs = [];
  for (const entry of valaisEntries) {
    try {
      const detailHtml = await fetchHtml(entry.url);
      const detail = parseDetailPage(detailHtml);

      const title = detail?.title || entry.title;
      const location = entry.city || 'Naters';
      const canton = inferAnyCanton(location) || 'VS';
      // Ensure description has meaningful content (>30 chars) for SEO
      const rawDesc = detail?.description || '';
      const descriptionText = rawDesc.length >= 30
        ? rawDesc
        : `${title} — BMS Building Materials, ${location} (${canton}). ${rawDesc}`.trim();

      const sourceLang = detectLang(descriptionText || title, 'de');
      const jobSlug = slugify(`${title} bms-building ch`);
      const urlHash = createHash('sha1').update(entry.url).digest('hex').slice(0, 12);

      const job = {
        // ── Required fields ──
        id: `bms-building-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: BMS_BUILDING_COMPANY_NAME,
        companyKey: BMS_BUILDING_KEY,
        companyDomain: BMS_BUILDING_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText,
        descriptionByLocale: { [sourceLang]: descriptionText },
        location,
        canton,
        url: entry.url,
        source: 'BMS Building Materials Dedicated Parser',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        ...(entry.postalCode ? { postalCode: entry.postalCode } : {}),
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(entry.employmentRaw || title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Edilizia / Materiali da costruzione',
        currency: 'CHF',
        featured: false,
        postedDate: new Date().toISOString().split('T')[0],
        applyUrl: detail?.applyUrl || entry.url,
        requirements: detail?.requirements || [],
        requirementsByLocale: { [sourceLang]: detail?.requirements || [] },
      };

      jobs.push(job);
      console.log(`  ✅ #${entry.jobId} — ${title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping #${entry.jobId} — ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n📋 Total BMS Building Materials Valais jobs discovered: ${jobs.length}`);
  return jobs;
}
