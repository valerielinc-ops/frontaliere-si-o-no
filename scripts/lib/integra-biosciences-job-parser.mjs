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
 * We fetch the UNFILTERED global open-positions page and select Swiss rows
 * client-side by the Country column (value "Switzerland"). The Drupal Views
 * exposed country filter uses full country names ("Switzerland", "United
 * States", …) submitted via AJAX, so a naive `?field_job_country_value=CH`
 * query param was invalid and silently ignored (the old "CH" scaffold value).
 *
 * The vacancies now come from INTEGRA's Umantis tenant: the page ships them
 * as `drupalSettings.jobsAllData` (title, country, department, onlineSince,
 * publicationUrl on jobs.integra-biosciences.com) and the browser renders the
 * table from that array. The server-side table body is ALWAYS empty and is
 * always followed by the "There are currently no job offers available."
 * panel, also while 13 offers (8 in Switzerland) are live (verified through
 * the Jina proxy on 2026-10-01). Reading only the table made the crawler
 * report 0 jobs forever (`lastSuccessfulRunAt=null`, crawler-health advisory
 * in run 36717595714). `parseJobsAllData` reads the array; the table parser
 * remains the fallback for a server-rendered table.
 *
 * Detail pages are Umantis vacancy pages
 * (jobs.integra-biosciences.com/Vacancies/{id}/Description/{n}); legacy
 * Drupal detail pages (/global/en/careers/{slug}) are still parsed.
 *
 * Cloudflare serves a hard HTTP 403 "Just a moment…" challenge to datacenter
 * egress IPs (GitHub Actions), so a direct fetch always returns 0 — this is
 * why the crawler never produced a job (lastSuccessfulRunAt=null). We route
 * the request through the shared Jina Reader clean-IP proxy on a 403 /
 * challenge body, exactly like the jobup/cambiavalute IP-reputation class.
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
import { sourcePostingDateFields, sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { fetchHtmlViaJinaWithRetry, looksLikeAntiBotChallenge } from './jina-proxy.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { readMetaContent } from './html-attr.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const INTEGRA_BIOSCIENCES_KEY = 'integra-biosciences';
export const INTEGRA_BIOSCIENCES_COMPANY_NAME = 'INTEGRA Biosciences';
export const INTEGRA_BIOSCIENCES_COMPANY_DOMAIN = 'integra-biosciences.com';

/**
 * Career page URL — global/en shows all locations. Swiss rows are selected
 * client-side by the Country column (the exposed Drupal Views filter uses full
 * country names and AJAX submission, so a query-string filter is unreliable).
 */
const CAREER_URL = 'https://www.integra-biosciences.com/global/en/careers/open-positions';

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
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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
 * Fetch a page's HTML, trying a direct browser-shaped request first and
 * transparently falling back to the Jina Reader clean-IP proxy when Cloudflare
 * serves its "Just a moment…" 403 challenge to the datacenter egress IP.
 *
 * Returns the real page HTML on success, or '' when neither path yields a
 * usable page (the caller then gracefully returns 0 jobs — the source is
 * preserved, never a hard failure).
 */
async function fetchHtmlWithJinaFallback(url, { label = 'page' } = {}) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let blocked = false;
  try {
    const res = await fetch(url, {
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

    if (res.status === 403 || res.status === 429 || res.status === 503) {
      blocked = true;
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${label}`);
    } else {
      const html = await res.text();
      // A CF challenge can also arrive on a 200 body — treat it as blocked.
      if (looksLikeAntiBotChallenge(html)) blocked = true;
      else return html;
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      console.warn(`⚠️ Direct request to ${label} timed out — trying Jina proxy.`);
      blocked = true;
    } else {
      // Network-level failure: still worth a clean-IP proxy attempt.
      console.warn(`⚠️ Direct request to ${label} failed (${err.message}) — trying Jina proxy.`);
      blocked = true;
    }
  }

  if (!blocked) return '';

  console.warn(`⚠️ Cloudflare blocked ${label} from this IP — routing through Jina clean-IP proxy.`);
  const viaJina = await fetchHtmlViaJinaWithRetry(url, { timeoutMs });
  if (viaJina != null && !looksLikeAntiBotChallenge(viaJina)) return viaJina;

  console.warn(`⚠️ Jina proxy could not retrieve ${label} either — returning empty (0 jobs, source preserved).`);
  return '';
}

/**
 * Fetch the global open-positions listing page HTML.
 */
async function fetchListingPage() {
  return fetchHtmlWithJinaFallback(CAREER_URL, { label: 'listing page' });
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

/**
 * Read the vacancy array the open-positions page ships in its Drupal settings
 * (`<script type="application/json" data-drupal-selector="drupal-settings-json">`
 * → `jobsAllData`). It is the complete listing the page renders client-side,
 * so an array without a Swiss row is the source's own zero.
 *
 * @param {string} html
 * @returns {null | Array<{ title: string, detailUrl: string, businessArea: string, country: string, postedDate: string }>}
 *   null when the page carries no such array (not this layout, or not read);
 *   otherwise one card per entry with a title and a trusted https detail URL.
 */
export function parseJobsAllData(html = '') {
  const match = /<script\b[^>]*data-drupal-selector\s*=\s*["']drupal-settings-json["'][^>]*>([\s\S]*?)<\/script>/i
    .exec(String(html || ''));
  if (!match) return null;
  let settings;
  try {
    settings = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const entries = settings?.jobsAllData;
  if (!Array.isArray(entries)) return null;

  const cards = [];
  for (const entry of entries) {
    const title = normalizeSpace(String(entry?.title || ''));
    const detailUrl = String(entry?.publicationUrl || '').trim();
    let trustedUrl = '';
    try {
      const url = new URL(detailUrl);
      if (url.protocol === 'https:' && isTrustedDomain(url.href)) trustedUrl = url.href;
    } catch {
      /* no usable vacancy URL */
    }
    const rawOnlineSince = entry?.onlineSince;
    const onlineSince = typeof rawOnlineSince === 'number' || (typeof rawOnlineSince === 'string' && /^\d+(?:\.\d+)?$/.test(rawOnlineSince))
      ? Number(rawOnlineSince) : NaN;
    const onlineSinceDate = new Date(onlineSince * 1000);
    cards.push({
      title,
      detailUrl: trustedUrl,
      businessArea: normalizeSpace(String(entry?.department || '')),
      country: normalizeSpace(String(entry?.country || '')),
      ...sourcePostingDateFields(Number.isFinite(onlineSinceDate.getTime()) && onlineSince > 0
        ? onlineSinceDate.toISOString() : ''),
    });
  }
  return cards;
}

/** Country column values the crawler keeps (blank = not stated, kept). */
function isSwissCountry(country = '') {
  const value = normalize(country);
  return !value || value === 'switzerland' || value === 'ch';
}

/* ── HTML Parsing — Detail Page ───────────────────────────── */

/**
 * Fetch a job detail page and extract the full description.
 * Uses the same Cloudflare-aware Jina fallback as the listing page.
 */
async function fetchDetailPageHtml(url) {
  return fetchHtmlWithJinaFallback(url, { label: `detail page ${url}` });
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
  // Commented-out markup is not the page: the Umantis template keeps the
  // German heading of every English ad in a comment, and a `<!-- <h2>…` tag
  // strip leaked it (plus a stray "-->") into the published text.
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');

  const umantis = parseUmantisVacancyBody(html);
  if (umantis) {
    result.description = umantis;
    result.datePosted = parseUmantisPublishedDate(html);
    return result;
  }

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

/**
 * The vacancy text of an INTEGRA Umantis detail page: the intro and the
 * job-description section of `<article class="articleBody">`. The benefits
 * carousel (client-rendered, empty in the HTML), the contact persons and the
 * campus description that follow are page furniture shared by every ad, and
 * the contact block carries personal names and phone numbers.
 *
 * @param {string} html comment-free detail page HTML
 * @returns {string} plain text keeping headings and bullets, or '' when the
 *   page is not this layout
 */
function parseUmantisVacancyBody(html) {
  const article = /<article\b[^>]*class\s*=\s*["'][^"']*\barticleBody\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1];
  if (!article) return '';
  const intro = /<div\b[^>]*class\s*=\s*["'][^"']*\bintroText\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(article)?.[1] || '';
  const vacancy = /<section\b[^>]*class\s*=\s*["']section-max-width["'][^>]*>([\s\S]*?)<\/section>/i.exec(article)?.[1] || '';
  if (!vacancy) return '';
  // Umantis spells spacing as numeric references (`&#160;`), which
  // stripHtml leaves alone; decode them and drop lines left blank.
  return [intro, vacancy]
    .map((part) => decodeEntities(stripHtml(part))
      .split('\n')
      .map((line) => line.replace(/[\s\u00a0]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * `<meta property="article:published_time" content="06.08.2026">` as an ISO
 * date, or ''.
 *
 * @param {string} html
 */
function parseUmantisPublishedDate(html) {
  const raw = readMetaContent(html, 'article:published_time').trim();
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (!match) return '';
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * The workplace an Umantis detail page states in its header bullets
 * (`<h5>Standort</h5><h6>Zizers</h6>`, `Location` on English ads), or ''.
 *
 * @param {string} html
 * @returns {string}
 */
export function parseDetailLocation(html = '') {
  const source = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const match = /<h5\b[^>]*>\s*(?:Location|Standort|Arbeitsort|Lieu de travail|Luogo di lavoro)\s*<\/h5>\s*<h6\b[^>]*>([\s\S]*?)<\/h6>/i
    .exec(source);
  return match ? normalizeSpace(stripHtml(match[1])) : '';
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
export async function fetchAllIntegraBiosciencesJobs({
  fetchListing = fetchListingPage,
  fetchDetail = fetchDetailPageHtml,
} = {}) {
  console.log(`🔍 Fetching INTEGRA Biosciences jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Note: Site is behind Cloudflare — direct fetch falls back to the Jina clean-IP proxy.\n`);

  const listingHtml = await fetchListing();
  const settingsCards = parseJobsAllData(listingHtml);
  const cards = settingsCards ?? parseListingTable(listingHtml);

  if (settingsCards && !settingsCards.some((card) => isSwissCountry(card.country))) {
    // The complete vacancy array was read and none of it is in Switzerland:
    // the source's own zero, not a fetch that came back empty.
    const evidence = `jobsAllData on ${CAREER_URL}: ${settingsCards.length} offer(s), none in Switzerland`;
    console.log(`  🧩 Source-proven zero: ${evidence}`);
    return markAuthoritativeEmptySnapshot([], evidence);
  }

  if (!cards || cards.length === 0) {
    console.warn('⚠️ No job cards found (no open positions, or the source could not be retrieved).');
    return [];
  }

  console.log(`  📋 Job cards found: ${cards.length}${settingsCards ? ' (jobsAllData)' : ''}`);

  const jobs = [];
  let withoutBody = 0;
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const card of cards) {
    const title = card.title;
    if (!title || title.length < 3) continue;

    // Only process Swiss jobs
    if (!isSwissCountry(card.country)) continue;
    // The vacancy URL is the job identity; a Swiss offer without one cannot
    // be published (falling back to the listing URL would merge every such
    // offer into one id).
    if (settingsCards && !card.detailUrl) {
      console.warn(`  ⚠️ No trusted vacancy URL for "${title}" — not published.`);
      continue;
    }

    // Attempt to fetch detail page for richer description
    let detail = { description: '', datePosted: '' };
    let detailLocation = '';
    if (card.detailUrl) {
      try {
        const detailHtml = await fetchDetail(card.detailUrl);
        detail = parseDetailPage(detailHtml);
        detailLocation = parseDetailLocation(detailHtml);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
      }
    }

    // INTEGRA HQ is in Zizers, GR — every Swiss ad states Zizers (verified
    // 2026-10-01). An ad naming another workplace must not be published with
    // the HQ address stamped on it.
    if (detailLocation && normalize(detailLocation) !== 'zizers') {
      console.warn(`  ⚠️ "${title}" is located in ${detailLocation}, not at the Zizers HQ — not published.`);
      continue;
    }
    const location = 'Zizers';
    const canton = 'GR';

    const publicUrl = card.detailUrl || CAREER_URL;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} integra-biosciences ch`);

    // Only the posting's own text is published (issue 5253): a detail page
    // without a body (now: under the shared 50-word floor) used to be replaced by a stub of
    // card metadata and a company sentence ("{title} — INTEGRA Biosciences.
    // Business Area: … Location: …"); such a card is not published any more.
    const descriptionText = detail.description || '';
    if (!meetsSourceBodyFloor(descriptionText)) {
      console.log(`  ⏭️ No vacancy text on the detail page, not published: ${title}`);
      withoutBody += 1;
      continue;
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

    // Source language of the vacancy body read from the detail page; the
    // title (often English on German postings) only when no body was read.
    const sourceLang = detectLang(
      detail.description && detail.description.length >= 30 ? detail.description : title,
      'en',
    );

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
      ...sourcePostingDateCandidatesFields([detail.datePosted, card.postingDateSource === 'reported' ? card.postedDate : '']),
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

  if (withoutBody > 0) {
    console.log(`  ⏭️ ${withoutBody} card(s) without vacancy text on the detail page — not published.`);
  }
  console.log(`\n📋 Total INTEGRA Biosciences jobs discovered: ${jobs.length}`);
  return jobs;
}
