#!/usr/bin/env node
/**
 * Fondation Domus job parser — Fetcher and job builder.
 *
 * Source: https://www.fondation-domus.ch/emploi-formation/offres-d-emploi
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFondationDomusJobs()  — Fetch and parse all jobs
 *   - isFondationDomusJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FONDATION_DOMUS_KEY = 'fondation-domus';
export const FONDATION_DOMUS_COMPANY_NAME = 'Fondation Domus';
export const FONDATION_DOMUS_COMPANY_DOMAIN = 'fondation-domus.ch';

const CAREER_URL = 'https://www.fondation-domus.ch/emploi-formation/offres-d-emploi';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Fondation Domus.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFondationDomusJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FONDATION_DOMUS_KEY ||
    key.startsWith('fondation-domus') ||
    company.includes('fondation domus') ||
    url.includes('fondation-domus.ch')
  );
}

/**
 * Validate that a URL belongs to Fondation Domus's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'fondation-domus.ch' ||
      host.endsWith('.fondation-domus.ch') ||
      host === 'www.jobup.ch' ||
      host === 'jobup.ch'
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

/* ── HTML Scraping ────────────────────────────────────────── */

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * Fondation Domus cities and their postal codes in Valais.
 */
const DOMUS_POSTAL_CODES = {
  ardon: '1957',
  'la tzoumaz': '1918',
  sion: '1950',
  sierre: '3960',
  riddes: '1908',
};

function inferPostalCode(location = '') {
  const loc = String(location || '').toLowerCase();
  for (const [city, code] of Object.entries(DOMUS_POSTAL_CODES)) {
    if (loc.includes(city)) return code;
  }
  return '1950'; // Sion default
}

function inferCity(location = '') {
  const loc = String(location || '').toLowerCase();
  if (loc.includes('tzoumaz')) return 'La Tzoumaz';
  if (loc.includes('ardon')) return 'Ardon';
  if (loc.includes('sierre')) return 'Sierre';
  if (loc.includes('riddes')) return 'Riddes';
  return 'Sion';
}

/**
 * Parse employment percentage from text like "60% à 80%" or "100%".
 * Returns { min, max, formatted }.
 */
function parseEmploymentPct(text = '') {
  const t = String(text || '');
  // "60% à 80%" or "60-80%"
  const rangeMatch = t.match(/(\d+)\s*%?\s*(?:à|[-–])\s*(\d+)\s*%/);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1]),
      max: parseInt(rangeMatch[2]),
      formatted: `${rangeMatch[1]} - ${rangeMatch[2]}%`,
    };
  }
  // "100%"
  const singleMatch = t.match(/(\d+)\s*%/);
  if (singleMatch) {
    const pct = parseInt(singleMatch[1]);
    return { min: pct, max: pct, formatted: `${pct}%` };
  }
  return { min: 100, max: 100, formatted: '100%' };
}

/**
 * Parse French date "17 mars 2026" → "2026-03-17".
 */
function parseFrenchDate(raw = '') {
  const months = {
    janvier: '01', février: '02', mars: '03', avril: '04',
    mai: '05', juin: '06', juillet: '07', août: '08',
    septembre: '09', octobre: '10', novembre: '11', décembre: '12',
  };
  const m = String(raw || '').trim().match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (!m) return '';
  const day = m[1].padStart(2, '0');
  const month = months[m[2].toLowerCase()];
  if (!month) return '';
  return `${m[3]}-${month}-${day}`;
}

/**
 * Fetch the career page HTML and extract job listings.
 * Fondation Domus renders jobs as HTML sections with h3 titles and
 * links to JobUp.ch for applications.
 *
 * Page structure:
 *   <h3>Job Title (percentage)</h3>
 *   <h5>Lieu de travail</h5> text
 *   <h5>Taux d'activité</h5> text
 *   <h5>Date de début</h5> text
 *   <a href="https://www.jobup.ch/...">Postuler</a>
 */
async function fetchCareerPage() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CAREER_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr-CH,fr;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from career page`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse job listings from the career page HTML.
 * Returns array of { title, location, percentage, contractType, date, applyUrl }.
 */
function parseJobsFromHtml(html = '') {
  const listings = [];

  // Split by <h3> tags to get individual job blocks
  // Each job starts with an <h3> containing the title
  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const h3Positions = [];
  let h3Match;
  while ((h3Match = h3Regex.exec(html)) !== null) {
    h3Positions.push({
      title: stripHtml(h3Match[1]),
      index: h3Match.index,
    });
  }

  for (let i = 0; i < h3Positions.length; i++) {
    const startIdx = h3Positions[i].index;
    const endIdx = i + 1 < h3Positions.length ? h3Positions[i + 1].index : html.length;
    const block = html.substring(startIdx, endIdx);
    const title = normalizeSpace(h3Positions[i].title);

    // Skip non-job headings (navigation, section titles, generic pages)
    if (!title || title.length < 5) continue;
    // Skip "Postulation spontanée" (open applications)
    if (/postulation spontan/i.test(title)) continue;
    // Skip generic section headings that aren't actual job titles
    if (/^postes?\s+ouverts?$/i.test(title)) continue;
    if (/^offres?\s+d['']emploi$/i.test(title)) continue;
    if (/^emploi\s+(?:et\s+)?formation$/i.test(title)) continue;
    if (/^nos\s+offres$/i.test(title)) continue;
    if (/^rejoignez/i.test(title)) continue;

    // Extract location: look for "Lieu de travail" followed by text
    let location = '';
    const lieuMatch = block.match(/lieu\s+de\s+travail\s*:?\s*<\/h[45]>\s*([\s\S]*?)(?:<h[45]|<a\s)/i)
      || block.match(/lieu\s*(?:de\s+travail)?\s*:?\s*<\/[^>]+>\s*([^<]+)/i);
    if (lieuMatch) location = normalizeSpace(stripHtml(lieuMatch[1]));

    // Extract percentage: look for "Taux d'activité" or percentage in title
    let percentage = '';
    const tauxMatch = block.match(/taux\s+d['']activit[eé]\s*:?\s*<\/h[45]>\s*([\s\S]*?)(?:<h[45]|<a\s)/i)
      || block.match(/taux\s*(?:d['']activit[eé])?\s*:?\s*<\/[^>]+>\s*([^<]+)/i);
    if (tauxMatch) percentage = normalizeSpace(stripHtml(tauxMatch[1]));
    if (!percentage) {
      const titlePct = title.match(/(\d+\s*%?\s*(?:à|[-–])\s*\d+\s*%|\d+\s*%)/);
      if (titlePct) percentage = titlePct[1];
    }

    // Extract contract type
    let contractType = '';
    const contratMatch = block.match(/type\s+de\s+contrat\s*:?\s*<\/h[45]>\s*([\s\S]*?)(?:<h[45]|<a\s)/i)
      || block.match(/contrat\s*:?\s*<\/[^>]+>\s*([^<]+)/i);
    if (contratMatch) contractType = normalizeSpace(stripHtml(contratMatch[1]));

    // Extract date
    let dateStr = '';
    const dateMatch = block.match(/date\s*(?:de\s+(?:d[ée]but|publication))?\s*:?\s*<\/h[45]>\s*([\s\S]*?)(?:<h[45]|<a\s)/i)
      || block.match(/(\d{1,2}\s+\w+\s+\d{4})/);
    if (dateMatch) dateStr = normalizeSpace(stripHtml(dateMatch[1]));

    // Extract apply URL (JobUp or fondation-domus.ch link)
    let applyUrl = '';
    const linkMatch = block.match(/<a[^>]+href=["']([^"']*(?:jobup\.ch|fondation-domus\.ch)[^"']*)["']/i)
      || block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:postuler|candidature|apply)/i);
    if (linkMatch) applyUrl = linkMatch[1];

    listings.push({ title, location, percentage, contractType, dateStr, applyUrl });
  }

  return listings;
}

/**
 * Fetch the JobUp.ch detail page and extract the description from
 * JSON-LD JobPosting schema or HTML fallback.
 */
async function fetchJobUpDescription(jobUpUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(jobUpUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr-CH,fr;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();

    // Try JSON-LD JobPosting first (most reliable).
    // JobUp wraps JSON-LD in an array: [{...}]
    const ldMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (ldMatch) {
      for (const block of ldMatch) {
        const jsonStr = block.replace(/<\/?script[^>]*>/gi, '').trim();
        try {
          const raw = JSON.parse(jsonStr);
          const items = Array.isArray(raw) ? raw : [raw];
          for (const ld of items) {
            if (ld['@type'] === 'JobPosting' && ld.description) {
              return stripHtml(ld.description).trim();
            }
          }
        } catch { /* not valid JSON-LD, skip */ }
      }
    }

    // HTML fallback: C_PBODYHTML container
    const bodyMatch = html.match(/<div[^>]*class="[^"]*C_PBODYHTML[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (bodyMatch) return stripHtml(bodyMatch[1]).trim();

    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetch all Fondation Domus jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch career page HTML
 *   2. Parse job listings from HTML structure
 *   3. For each listing with a JobUp URL, fetch the detail description
 *   4. Build ParsedJob objects
 */
export async function fetchAllFondationDomusJobs() {
  console.log(`🔍 Fetching Fondation Domus jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const html = await fetchCareerPage();
  const listings = parseJobsFromHtml(html);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on career page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = listing.title;
    if (!title || title.length < 3) continue;

    const city = inferCity(listing.location);
    const canton = inferAnyCanton(city) || 'VS';
    const pct = parseEmploymentPct(listing.percentage || title);
    const postedDate = parseFrenchDate(listing.dateStr);

    // Use the career page URL as primary; applyUrl for application link
    const publicUrl = listing.applyUrl || CAREER_URL;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} fondation-domus ch`);

    // Fetch rich description from JobUp detail page
    let descriptionText = '';
    if (listing.applyUrl && listing.applyUrl.includes('jobup.ch')) {
      console.log(`  📄 Fetching detail from JobUp: ${listing.applyUrl.substring(0, 60)}...`);
      descriptionText = await fetchJobUpDescription(listing.applyUrl) || '';
      await new Promise((r) => setTimeout(r, 300));
    }

    // Fallback to metadata-based description if detail fetch failed
    if (!descriptionText || descriptionText.length < 50) {
      const descParts = [`${title} — Fondation Domus`];
      if (city) descParts.push(`Lieu: ${city} (VS)`);
      if (pct.formatted) descParts.push(`Taux d'activité: ${pct.formatted}`);
      if (listing.contractType) descParts.push(`Contrat: ${listing.contractType}`);
      descriptionText = descParts.join('. ');
    }

    const sourceLang = 'fr';
    const empType = pct.max < 80 ? 'PART_TIME' : 'FULL_TIME';

    const job = {
      // ── Required fields ──
      id: `fondation-domus-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FONDATION_DOMUS_COMPANY_NAME,
      companyKey: FONDATION_DOMUS_KEY,
      companyDomain: FONDATION_DOMUS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: publicUrl,
      source: 'Fondation Domus Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode: inferPostalCode(listing.location || city),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: pct.max >= 80 ? 'full-time' : 'part-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Social / Fondation',
      currency: 'CHF',
      featured: false,
      postedDate: postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl || CAREER_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${city} (${descriptionText.length} chars)`);
  }

  console.log(`\n📋 Total Fondation Domus jobs discovered: ${jobs.length}`);
  return jobs;
}
