#!/usr/bin/env node
/**
 * INTEGRA Biosciences job parser — Fetcher and job builder.
 *
 * Source: https://www.integra-biosciences.com/global/en/careers/open-positions
 *
 * INTEGRA Biosciences is a Drupal site behind Cloudflare bot protection.
 * The listing page uses a Drupal Views table with columns:
 *   Title (linked to detail page), Business Area, Country.
 *
 * Filter: ?field_job_country_value=CH for Swiss jobs only.
 *
 * Detail pages at /global/en/careers/{slug} contain full job descriptions.
 *
 * Cloudflare challenge may block automated requests. The crawler handles
 * 403 responses gracefully and logs a warning when blocked.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllIntegraBiosciencesJobs()  — Fetch and parse all jobs
 *   - isIntegraBiosciencesJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()                — Validate URLs belong to this company
 *   - slugify() / stripHtml()          — Re-exported from crawler-template.mjs
 *
 * Also exports helpers for testing:
 *   - parseListingTable()        — Parse Drupal Views table HTML
 *   - parseDetailPage()          — Extract description from detail page HTML
 *   - detectCategory()           — Detect job category from title/business area
 *   - detectExperienceLevel()    — Detect experience level from title
 *   - inferEmploymentType()      — Infer FULL_TIME/PART_TIME from title
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const INTEGRA_BIOSCIENCES_KEY = 'integra-biosciences';
export const INTEGRA_BIOSCIENCES_COMPANY_NAME = 'INTEGRA Biosciences';
export const INTEGRA_BIOSCIENCES_COMPANY_DOMAIN = 'integra-biosciences.com';

/**
 * Career page URL — global/en shows all locations.
 * Append ?field_job_country_value=CH to filter Swiss positions only.
 */
const CAREER_URL = 'https://www.integra-biosciences.com/global/en/careers/open-positions';
const CAREER_URL_CH = `${CAREER_URL}?field_job_country_value=CH`;

const BASE_URL = 'https://www.integra-biosciences.com';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to INTEGRA Biosciences.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isIntegraBiosciencesJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === INTEGRA_BIOSCIENCES_KEY ||
    key.startsWith('integra-biosciences') ||
    company.includes('integra biosciences') ||
    url.includes('integra-biosciences.com')
  );
}

/**
 * Validate that a URL belongs to INTEGRA Biosciences's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'integra-biosciences.com' || host.endsWith('.integra-biosciences.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Business area values from the Drupal Views filter:
 *   Engineering, Finance & Administration, HR, Innovation, IT,
 *   Logistics, Production, Quality & Safety Management, Sales
 */
const BUSINESS_AREA_MAP = {
  engineering: 'Ingegneria',
  'finance & administration': 'Amministrazione',
  'finance': 'Finanza',
  'administration': 'Amministrazione',
  hr: 'Risorse Umane',
  innovation: 'Ricerca e Sviluppo',
  it: 'IT',
  logistics: 'Logistica',
  production: 'Produzione',
  'quality & safety management': 'Qualità',
  quality: 'Qualità',
  sales: 'Commerciale',
};

/**
 * Detect job category from title and business area.
 * INTEGRA is a life sciences company — categories are biotech-oriented.
 */
export function detectCategory(title = '', businessArea = '') {
  // First, try business area mapping (from Drupal Views column)
  const area = normalize(businessArea);
  if (BUSINESS_AREA_MAP[area]) return BUSINESS_AREA_MAP[area];

  // Partial matches for business area
  for (const [key, category] of Object.entries(BUSINESS_AREA_MAP)) {
    if (area.includes(key)) return category;
  }

  // Fall back to title-based detection.
  // Order matters: more specific compound terms BEFORE generic roots.
  // "Software-Entwickler" must match IT before "entwickl" matches engineering.
  const t = normalize(title);
  if (/\b(software|develop|programm|sharepoint|erp|it.?analyst|system.?engineer|it.?system|firmware)/.test(t)) return 'IT';
  if (/\b(ingegner|engineer|entwickl|mechanical|design engineer|projektleiter)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|elektronik|service)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|controller|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|commercial|account manager)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply chain)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|production|automation|verfahren)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality|supplier quality)/.test(t)) return 'Qualità';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|content|marketing)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(scien|research|innovat|application scientist|r&d)/.test(t)) return 'Ricerca e Sviluppo';
  return 'Altro';
}

export function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|principal)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Infer employment type from title (percentage patterns common in Swiss job ads).
 * Examples: "80-100%", "100%", "60-100%"
 */
export function inferEmploymentType(title = '') {
  const t = normalize(title);
  // Match range patterns like "80-100%", "80 - 100 %"
  const rangeMatch = t.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (rangeMatch) {
    const max = parseInt(rangeMatch[2], 10);
    return max >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  // Match single percentage like "100%"
  const singleMatch = t.match(/(\d+)\s*%/);
  if (singleMatch) {
    const pct = parseInt(singleMatch[1], 10);
    return pct >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  return 'FULL_TIME'; // Default for INTEGRA (most positions are full-time)
}

/* ── HTML Parsing — Listing Page ──────────────────────────── */

/**
 * Fetch the listing page HTML.
 * Uses the CH-filtered URL to get only Swiss positions.
 */
async function fetchListingPage() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CAREER_URL_CH, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9,de-CH;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    clearTimeout(timer);

    if (res.status === 403) {
      console.warn('⚠️ Cloudflare challenge blocked the request (HTTP 403).');
      console.warn('   The crawler will return 0 jobs. This is expected when CF is active.');
      return '';
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} from listing page`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      console.warn('⚠️ Request timed out.');
      return '';
    }
    throw err;
  }
}

/**
 * Parse job rows from the Drupal Views table HTML.
 *
 * The table structure (from Wayback Machine analysis):
 * ```html
 * <table class="cols-3">
 *   <thead><tr>
 *     <th class="views-field views-field-title">Title</th>
 *     <th class="views-field views-field-field-business-area">Business Area</th>
 *     <th class="views-field views-field-field-job-country">Country</th>
 *   </tr></thead>
 *   <tbody>
 *     <tr>
 *       <td class="views-field views-field-title">
 *         <a href="/global/en/careers/{slug}">Job Title</a>
 *       </td>
 *       <td class="views-field views-field-field-business-area">Engineering</td>
 *       <td class="views-field views-field-field-job-country">Switzerland</td>
 *     </tr>
 *   </tbody>
 * </table>
 * ```
 */
export function parseListingTable(html = '') {
  const jobs = [];
  if (!html || html.length < 100) return jobs;

  // Match each table row in the tbody
  const rowRegex = /<tr>\s*([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];

    // Skip header rows (contain <th>)
    if (row.includes('<th')) continue;

    // Extract title and link from the title cell
    const titleCellMatch = row.match(
      /<td[^>]*views-field-title[^>]*>\s*<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!titleCellMatch) continue;

    let detailPath = titleCellMatch[1];
    const title = normalizeSpace(stripHtml(titleCellMatch[2]));

    if (!title || title.length < 3) continue;

    // Normalize the detail URL (remove Wayback Machine prefix if present)
    detailPath = detailPath.replace(/^\/web\/\d+\//, '');
    if (detailPath.startsWith('/')) {
      detailPath = `${BASE_URL}${detailPath}`;
    }

    // Extract business area
    const areaMatch = row.match(
      /<td[^>]*views-field-field-business-area[^>]*>([\s\S]*?)<\/td>/
    );
    const businessArea = areaMatch ? normalizeSpace(stripHtml(areaMatch[1])) : '';

    // Extract country
    const countryMatch = row.match(
      /<td[^>]*views-field-field-job-country[^>]*>([\s\S]*?)<\/td>/
    );
    const country = countryMatch ? normalizeSpace(stripHtml(countryMatch[1])) : '';

    jobs.push({
      title,
      detailUrl: detailPath,
      businessArea,
      country,
    });
  }

  return jobs;
}

/* ── HTML Parsing — Detail Page ───────────────────────────── */

/**
 * Fetch a job detail page and extract the full description.
 */
async function fetchDetailPageHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9,de-CH;q=0.8',
      },
    });
    clearTimeout(timer);

    if (res.status === 403) {
      console.warn(`  ⚠️ Cloudflare blocked detail page: ${url}`);
      return '';
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} from detail page: ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return '';
    throw err;
  }
}

/**
 * Extract description and metadata from a job detail page.
 *
 * Drupal detail pages for INTEGRA typically contain:
 *   - Main body text with job description
 *   - JSON-LD structured data (if Metatag module is configured)
 *   - Drupal field content
 */
export function parseDetailPage(html = '') {
  const result = {
    description: '',
    datePosted: '',
  };

  if (!html || html.length < 100) return result;

  // Try to extract JSON-LD first (most structured)
  const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      if (data['@type'] === 'JobPosting') {
        if (data.description) {
          result.description = normalizeSpace(stripHtml(data.description));
        }
        if (data.datePosted) {
          result.datePosted = data.datePosted;
        }
      }
    } catch {
      // JSON parse failure — continue to HTML extraction
    }
  }

  // Fall back to extracting the main content area
  if (!result.description || result.description.length < 30) {
    // Try Drupal field body
    const bodyMatch = html.match(/<div[^>]*class="[^"]*field--name-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (bodyMatch) {
      const bodyText = normalizeSpace(stripHtml(bodyMatch[1]));
      if (bodyText.length > 30) {
        result.description = bodyText;
      }
    }
  }

  // Try article or main content region
  if (!result.description || result.description.length < 30) {
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      const articleText = normalizeSpace(stripHtml(articleMatch[1]));
      if (articleText.length > 50) {
        // Truncate very long content to a reasonable description length
        result.description = articleText.length > 2000
          ? articleText.substring(0, 2000)
          : articleText;
      }
    }
  }

  return result;
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all INTEGRA Biosciences Swiss jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch the listing page HTML (filtered for Switzerland)
 *   2. Parse the Drupal Views table for job cards
 *   3. For each card, attempt to fetch detail page for description
 *   4. Build ParsedJob objects with all available metadata
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllIntegraBiosciencesJobs() {
  console.log(`🔍 Fetching INTEGRA Biosciences jobs`);
  console.log(`   Source: ${CAREER_URL_CH}`);
  console.log(`   Note: Site is behind Cloudflare — 403 responses are expected.\n`);

  const listingHtml = await fetchListingPage();
  const cards = parseListingTable(listingHtml);

  if (!cards || cards.length === 0) {
    console.warn('⚠️ No job cards found. Cloudflare may be blocking the request.');
    return [];
  }

  console.log(`  📋 Job cards found: ${cards.length}`);

  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const card of cards) {
    const title = card.title;
    if (!title || title.length < 3) continue;

    // Only process Swiss jobs
    const country = normalize(card.country);
    if (country && country !== 'switzerland' && country !== 'ch') continue;

    // Attempt to fetch detail page for richer description
    let detail = { description: '', datePosted: '' };
    if (card.detailUrl) {
      try {
        const detailHtml = await fetchDetailPageHtml(card.detailUrl);
        detail = parseDetailPage(detailHtml);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
      }
    }

    // INTEGRA HQ is in Zizers, GR — all Swiss jobs are in Zizers
    const location = 'Zizers';
    const canton = 'GR';

    const publicUrl = card.detailUrl || CAREER_URL;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} integra-biosciences ch`);

    // Build description: prefer detail page, fall back to metadata
    let descriptionText = detail.description;
    if (!descriptionText || descriptionText.length < 30) {
      const parts = [`${title} — INTEGRA Biosciences`];
      if (card.businessArea) parts.push(`Business Area: ${card.businessArea}`);
      parts.push(`Location: ${location} (${canton}), Switzerland`);
      parts.push('INTEGRA Biosciences develops and manufactures innovative laboratory instruments for liquid handling and media preparation.');
      descriptionText = parts.join('. ');
    }

    // Determine employment type from title
    const employmentType = inferEmploymentType(title);

    // Contract type from percentage
    const rangeMatch = normalize(title).match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
    const singleMatch = normalize(title).match(/(\d+)\s*%/);
    let pensumMin, pensumMax, pensum;
    if (rangeMatch) {
      pensumMin = parseInt(rangeMatch[1], 10);
      pensumMax = parseInt(rangeMatch[2], 10);
      pensum = pensumMin === pensumMax ? `${pensumMin}%` : `${pensumMin} - ${pensumMax}%`;
    } else if (singleMatch) {
      pensumMin = parseInt(singleMatch[1], 10);
      pensumMax = pensumMin;
      pensum = `${pensumMin}%`;
    }
    const contract = (pensumMax && pensumMax < 90) ? 'part-time' : 'full-time';

    // Source language: titles are often German or English (mixed)
    const sourceLang = detectLang(title, 'en');

    const job = {
      // ── Required fields ──
      id: `integra-biosciences-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: INTEGRA_BIOSCIENCES_COMPANY_NAME,
      companyKey: INTEGRA_BIOSCIENCES_KEY,
      companyDomain: INTEGRA_BIOSCIENCES_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'INTEGRA Biosciences Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '7205',
      streetAddress: 'Tardisstrasse 201',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, card.businessArea),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Scienze della Vita / Biotecnologia',
      currency: 'CHF',
      featured: false,
      postedDate: detail.datePosted || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },

      // ── Optional enrichment ──
      ...(card.businessArea ? { department: card.businessArea } : {}),
      ...(pensum ? { pensum, pensumMin, pensumMax } : {}),
    };

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} — ${card.businessArea || 'N/A'} (${employmentType})`);
  }

  console.log(`\n📋 Total INTEGRA Biosciences jobs discovered: ${jobs.length}`);
  return jobs;
}
