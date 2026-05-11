#!/usr/bin/env node
/**
 * Spital Thusis job parser — Rukzuk CMS static HTML pages.
 *
 * Source: https://www.spitalthusis.ch/karriere-jobs/offene-stellen/
 *
 * Spital Thusis (part of Gesundheit Mittelbünden) is a regional hospital
 * in Thusis, Graubünden. The career page is a simple Rukzuk CMS listing
 * with ~11 static job pages under /karriere-jobs/offene-stellen/{slug}/.
 *
 * Flow:
 *   1. Fetch listing page → extract all <a> links with <h3> titles
 *   2. For each link, fetch the detail page for full description
 *   3. Parse pensum from title (e.g. "80-100%")
 *   4. Build ParsedJob objects with healthcare-specific category detection
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalThusisJobs()  — Fetch and parse all jobs
 *   - isSpitalThusisJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_THUSIS_KEY = 'spital-thusis';
export const SPITAL_THUSIS_COMPANY_NAME = 'Spital Thusis';
export const SPITAL_THUSIS_COMPANY_DOMAIN = 'spitalthusis.ch';

const CAREER_URL = 'https://www.spitalthusis.ch/karriere-jobs/offene-stellen/';
const BASE_URL = 'https://www.spitalthusis.ch';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}


/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Spital Thusis.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSpitalThusisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_THUSIS_KEY ||
    key.startsWith('spital-thusis') ||
    company.includes('spital thusis') ||
    url.includes('spitalthusis.ch')
  );
}

/**
 * Validate that a URL belongs to Spital Thusis's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'spitalthusis.ch' || host.endsWith('.spitalthusis.ch');
  } catch {
    return false;
  }
}

/* ── Pensum Parsing ───────────────────────────────────────── */

/**
 * Extract pensum percentage range from title.
 *
 * Patterns:
 *   "80-100%"   → { min: 80, max: 100 }
 *   "80–100%"   → { min: 80, max: 100 }
 *   "80 - 100%" → { min: 80, max: 100 }
 *   "100%"      → { min: 100, max: 100 }
 *   "40–50%"    → { min: 40, max: 50 }
 *   "Pensum flexibel" → null
 */
export function parsePensum(text = '') {
  // Range: "80-100%", "80–100%", "80 - 100%"
  const rangeMatch = String(text).match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }

  // Single: "100%"
  const singleMatch = String(text).match(/(\d+)\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }

  return null;
}

/**
 * Build a human-readable pensum string.
 */
export function formatPensum(pensum) {
  if (!pensum) return '';
  if (pensum.min === pensum.max) return `${pensum.min}%`;
  return `${pensum.min} - ${pensum.max}%`;
}

/* ── Category Detection (Healthcare-focused) ─────────────── */

/**
 * Detect job category from title. Tuned for a regional hospital
 * with roles in medicine, nursing, physiotherapy, logistics, etc.
 */
export function detectCategory(title = '') {
  const t = normalize(title);

  // Education / apprenticeship — check FIRST because titles like
  // "Ausbildungsplatz als Pflegefachperson" contain both education
  // and nursing keywords; the primary role is the apprenticeship.
  if (/\b(ausbildung|lehrstelle|lernend|lehrling|praktik)/.test(t)) return 'Formazione';
  // Medical doctors
  if (/\b(arzt|ärztin|ärzt|oberarzt|oberärztin|assistenzarzt|assistenzärztin|medizin)/.test(t)) return 'Medicina';
  // Anaesthesia — check before nursing (anästhesiepflege contains "pflege")
  if (/\b(anästhesie|anaesthesie|anästhesiepflege)/.test(t)) return 'Anestesia';
  // Nursing / care
  if (/\b(pflege|pflegefach|fage|fachperson gesundheit|pflegehilfe|betreu)/.test(t)) return 'Infermieristica';
  // Physiotherapy
  if (/\b(physiotherap)/.test(t)) return 'Fisioterapia';
  // Radiology
  if (/\b(radiolog)/.test(t)) return 'Radiologia';
  // Emergency / Rescue
  if (/\b(rettung|notfall|rettungsdienst)/.test(t)) return 'Emergenza';
  // Hospitality / housekeeping
  if (/\b(hotellerie|hauswirtschaft|küche|raumpflege|gastro|koch)/.test(t)) return 'Ristorazione';
  // Logistics / purchasing
  if (/\b(logist|einkauf|lager|warehouse)/.test(t)) return 'Logistica';
  // Administration
  if (/\b(admin|segret|contab|buchhalt|account|sekretär|verwaltung)/.test(t)) return 'Amministrazione';
  // IT
  if (/\b(it\b|software|develop|programm|informatik)/.test(t)) return 'IT';
  // SPITEX (home care)
  if (/\bspitex\b/.test(t)) return 'Spitex';

  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|lehrstelle|ausbildung)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|stv|stellvert)/.test(t)) return 'senior';
  return 'mid';
}

/* ── HTML Fetching ────────────────────────────────────────── */

/**
 * Fetch an HTML page with timeout and standard headers.
 */
async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── HTML Parsing — Listing Page ─────────────────────────── */

/**
 * Parse job links from the listing page HTML.
 *
 * Each listing is structured as:
 *   <li>
 *     <a href="/karriere-jobs/offene-stellen/{slug}/">
 *       <h3>Job Title</h3>
 *     </a>
 *   </li>
 *
 * Filters out:
 *   - "Initiativbewerbung" (spontaneous application placeholder)
 *   - Links not under /karriere-jobs/offene-stellen/
 */
export function parseListingPage(html = '') {
  const links = [];

  // Match <a href="/karriere-jobs/offene-stellen/{slug}/"> with <h3> title inside
  const linkRegex = /<a\s+href="(\/karriere-jobs\/offene-stellen\/[^"]+\/)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const title = normalizeSpace(stripHtml(match[2]));

    // Skip spontaneous applications
    if (/initiativbewerbung/i.test(title)) continue;

    // Skip if title too short
    if (!title || title.length < 3) continue;

    // Build absolute URL
    const detailUrl = `${BASE_URL}${href}`;

    links.push({ title, detailUrl });
  }

  return links;
}

/* ── HTML Parsing — Detail Page ──────────────────────────── */

/**
 * Extract job description from a detail page.
 *
 * The Rukzuk CMS pages have content in the main body area.
 * We extract all meaningful text content, looking for typical
 * German job posting sections:
 *   - "Aufgabengebiet" / "Aufgaben" (duties)
 *   - "Anforderungsprofil" / "Anforderungen" (requirements)
 *   - "Wir bieten" (benefits)
 *   - Contact information
 */
export function parseDetailPage(html = '') {
  const result = {
    description: '',
    requirements: [],
  };

  // Strategy: extract the main content between the title and the footer/nav.
  // Rukzuk pages don't use standard semantic HTML, so we extract text
  // from the body, stripping navigation and scripts.

  // Remove script, style, nav, header, footer tags and their content
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // Look for the main content area between job sections
  const sections = [];

  // Try to extract structured sections by headings
  const sectionPatterns = [
    { pattern: /(?:Dein(?:e)?|Ihr(?:e)?)\s*Aufgaben(?:gebiet)?:?\s*/i, heading: 'Aufgaben' },
    { pattern: /(?:Dein(?:e)?|Ihr(?:e)?|Unser(?:e)?)\s*Anforderung(?:en|sprofil):?\s*/i, heading: 'Anforderungen' },
    { pattern: /Wir\s+bieten:?\s*/i, heading: 'Wir bieten' },
  ];

  // Extract bullet points / list items from the page
  const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;
  const allListItems = [];
  while ((liMatch = listItemRegex.exec(cleaned)) !== null) {
    const text = normalizeDescriptionSpace(stripHtml(liMatch[1]));
    if (text.length > 5) allListItems.push(text);
  }

  // Extract paragraph content
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let paraMatch;
  const allParagraphs = [];
  while ((paraMatch = paraRegex.exec(cleaned)) !== null) {
    const text = normalizeDescriptionSpace(stripHtml(paraMatch[1]));
    if (text.length > 10) allParagraphs.push(text);
  }

  // Build description from headings content
  for (const { pattern, heading } of sectionPatterns) {
    // Find content between this heading and the next heading or end
    const headingRegex = new RegExp(
      `(?:<[^>]*>)*${pattern.source}(?:<[^>]*>)*([\\s\\S]*?)(?=(?:Dein|Ihr|Unser|Wir bieten|Kontakt|Auskünfte|Bewerbung)[^<]*:|$)`,
      'i',
    );
    const sectionMatch = cleaned.match(headingRegex);
    if (sectionMatch) {
      const sectionText = normalizeDescriptionSpace(stripHtml(sectionMatch[1]));
      if (sectionText.length > 10) {
        sections.push(`${heading}: ${sectionText}`);
      }
    }
  }

  if (sections.length > 0) {
    result.description = sections.join(' | ');
  } else if (allListItems.length > 0) {
    // Fallback: combine list items and paragraphs
    const combined = [...allParagraphs.slice(0, 5), ...allListItems.slice(0, 10)];
    result.description = combined.join('. ');
  } else if (allParagraphs.length > 0) {
    result.description = allParagraphs.slice(0, 8).join('. ');
  }

  // Extract requirements from list items under "Anforderung" section
  const reqSectionMatch = cleaned.match(
    /(?:Anforderung(?:en|sprofil))[^<]*(?:<[^>]*>)*([\s\S]*?)(?=(?:Wir bieten|Kontakt|Auskünfte|Bewerbung)[^<]*:|$)/i,
  );
  if (reqSectionMatch) {
    const reqListRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let reqMatch;
    while ((reqMatch = reqListRegex.exec(reqSectionMatch[1])) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(reqMatch[1]));
      if (text.length > 5) result.requirements.push(text);
    }
  }

  return result;
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Spital Thusis jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML and parse all job links
 *   2. For each link, fetch detail page for full description
 *   3. Build ParsedJob objects with healthcare metadata
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSpitalThusisJobs() {
  console.log(`🔍 Fetching Spital Thusis jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listingHtml = await fetchPage(CAREER_URL);
  const listings = parseListingPage(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on listing page.');
    return [];
  }

  console.log(`  📋 Job listings found: ${listings.length}`);

  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const listing of listings) {
    const title = listing.title;
    if (!title || title.length < 3) continue;

    // Fetch detail page for full description
    let detail = { description: '', requirements: [] };
    try {
      const detailHtml = await fetchPage(listing.detailUrl);
      detail = parseDetailPage(detailHtml);
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
    }

    const location = 'Thusis';
    const canton = inferAnyCanton(location) || 'GR';
    const publicUrl = listing.detailUrl;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} spital-thusis ch`);

    // Build description: prefer detail page, fall back to title-based
    let descriptionText = detail.description;
    if (!descriptionText || descriptionText.length < 30) {
      const parts = [`${title} — Spital Thusis (Gesundheit Mittelbünden)`];
      parts.push('Arbeitsort: Thusis (GR)');
      const pensum = parsePensum(title);
      if (pensum) {
        parts.push(`Pensum: ${formatPensum(pensum)}`);
      }
      descriptionText = parts.join('. ');
    }

    // Determine employment type from pensum
    const pensum = parsePensum(title);
    let employmentType = 'OTHER';
    let contract = 'full-time';
    if (pensum) {
      employmentType = pensum.max >= 80 ? 'FULL_TIME' : 'PART_TIME';
      contract = pensum.max >= 80 ? 'full-time' : 'part-time';
    }

    const sourceLang = 'de';

    const job = {
      // ── Required fields ──
      id: `spital-thusis-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_THUSIS_COMPANY_NAME,
      companyKey: SPITAL_THUSIS_KEY,
      companyDomain: SPITAL_THUSIS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Spital Thusis Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '7430',
      streetAddress: 'Alte Strasse 31',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Assistenza',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: detail.requirements || [],
      requirementsByLocale: { [sourceLang]: detail.requirements || [] },
    };

    // Optional pensum enrichment
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = formatPensum(pensum);
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${location} (${pensum ? formatPensum(pensum) : 'flexible'})`);
  }

  console.log(`\n📋 Total Spital Thusis jobs discovered: ${jobs.length}`);
  return jobs;
}
