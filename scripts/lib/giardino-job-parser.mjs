/**
 * Giardino Group job parser — WordPress REST API.
 *
 * Giardino Group operates luxury hotels in Switzerland:
 *   - Giardino Mountain (Champfèr / St. Moritz, GR)
 *   - Giardino Ascona (Ascona, TI)
 *   - Giardino Lago (Minusio / Locarno, TI)
 *
 * The career page at giardinohotels.ch runs WordPress 6.9+ with a custom
 * "jobs" post type. The REST API at /wp-json/wp/v2/jobs returns structured
 * JSON with full HTML content per job — no pagination needed (~3 jobs).
 *
 * Content structure per job (German):
 *   <div id="introduction">
 *     <h3>#aboutus</h3>         — company boilerplate (skip)
 *     <p>...suchen wir...eine/n:</p>
 *     <h1>TITLE</h1>
 *     <h3>#aboutthejob</h3>     — role description
 *   </div>
 *   <div id="tasks">
 *     <h3>#aboutyou</h3>        — requirements list
 *   </div>
 *   <div id="benefits">
 *     <h3>#talentculture</h3>   — benefits list
 *     <h3>Kontakt</h3>          — contact (skip)
 *   </div>
 *
 * Location is derived from the content text pattern
 *   "Giardino {Mountain|Ascona|Lago} in {city}" or WordPress categories.
 *
 * Source: https://giardinohotels.ch/en/giardino-group/jobs/
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GIARDINO_KEY = 'giardino';
export const GIARDINO_COMPANY_NAME = 'Giardino Group';
export const GIARDINO_COMPANY_DOMAIN = 'giardinohotels.ch';

const API_URL = 'https://giardinohotels.ch/wp-json/wp/v2/jobs?per_page=50';
const SITE_BASE = 'https://giardinohotels.ch';
const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Hotel → location mapping ─────────────────────────────── */

/**
 * Giardino operates 3 hotels. The WP categories and content text
 * identify which hotel a job belongs to.
 */
const HOTEL_LOCATIONS = {
  mountain: { city: 'Champfèr', canton: 'GR', postalCode: '7512' },
  ascona:   { city: 'Ascona',   canton: 'TI', postalCode: '6612' },
  lago:     { city: 'Minusio',  canton: 'TI', postalCode: '6648' },
};

/** WordPress category IDs for resort locations */
const CATEGORY_RESORT = {
  674: 'ascona',   // Ascona
  676: 'lago',     // Locarno → Giardino Lago in Minusio
};

/* ── Helpers ───────────────────────────────────────────────── */


/**
 * Decode WordPress HTML entities in title.rendered.
 */
export function decodeWpEntities(raw = '') {
  return String(raw || '')
    .replace(/&#8211;/g, '\u2013')  // en-dash
    .replace(/&#8212;/g, '\u2014')  // em-dash
    .replace(/&#8216;/g, '\u2018')  // left single quote
    .replace(/&#8217;/g, '\u2019')  // right single quote
    .replace(/&#8220;/g, '\u201C')  // left double quote
    .replace(/&#8221;/g, '\u201D')  // right double quote
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\/g, '')
    .trim();
}

/* ── Hotel Detection ──────────────────────────────────────── */

/**
 * Detect which Giardino hotel a job belongs to from content text
 * and WordPress category IDs.
 *
 * Priority: content text mention > WP category > default (Champfèr).
 */
export function detectHotel(contentHtml = '', categoryIds = []) {
  const text = String(contentHtml || '').toLowerCase();

  // Check content text for hotel name patterns
  if (/giardino\s+mountain/i.test(text)) return 'mountain';
  if (/giardino\s+lago/i.test(text)) return 'lago';
  if (/giardino\s+ascona/i.test(text)) return 'ascona';

  // Check for city mentions in "suchen wir" context
  if (/in\s+champf[eè]r/i.test(text) || /st\.?\s*moritz/i.test(text)) return 'mountain';
  if (/in\s+minusio/i.test(text) || /minusio.?locarno/i.test(text)) return 'lago';
  if (/in\s+ascona/i.test(text)) return 'ascona';

  // Fallback to WordPress categories
  const cats = Array.isArray(categoryIds) ? categoryIds : [];
  for (const catId of cats) {
    const hotel = CATEGORY_RESORT[catId];
    if (hotel) return hotel;
  }

  // Default: company HQ in Champfèr
  return 'mountain';
}

/**
 * Get location details for a detected hotel.
 */
export function getHotelLocation(hotelKey) {
  return HOTEL_LOCATIONS[hotelKey] || HOTEL_LOCATIONS.mountain;
}

/* ── Content Parsing ──────────────────────────────────────── */

/**
 * Extract the clean job title from the <h1> inside content HTML.
 * WordPress title.rendered often includes "(m/w)" and hotel prefixes
 * like "gl-" or "ga-"; the <h1> in content has the clean title.
 */
export function extractH1Title(contentHtml = '') {
  const match = String(contentHtml || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? normalizeSpace(stripHtml(match[1])) : '';
}

/**
 * Parse the WordPress content HTML into structured sections.
 *
 * Returns { aboutJob, aboutYou, talentCulture } with plain text content.
 */
export function parseContentSections(contentHtml = '') {
  const html = String(contentHtml || '');

  const sections = {
    aboutJob: '',
    aboutYou: [],
    talentCulture: [],
  };

  // Extract #aboutthejob section — text between #aboutthejob and next h3 or div
  const aboutJobMatch = html.match(
    /#aboutthejob<\/h3>\s*([\s\S]*?)(?=<h3|<\/div>)/i,
  );
  if (aboutJobMatch) {
    sections.aboutJob = normalizeSpace(stripHtml(aboutJobMatch[1]));
  }

  // Extract #aboutyou items — list items after #aboutyou
  const aboutYouMatch = html.match(
    /#aboutyou<\/h3>\s*([\s\S]*?)(?=<\/div>|<h3)/i,
  );
  if (aboutYouMatch) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(aboutYouMatch[1])) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(m[1]));
      if (text.length > 2) sections.aboutYou.push(text);
    }
  }

  // Extract #talentculture items — list items after #talentculture
  const cultureMatch = html.match(
    /#talentculture<\/h3>\s*([\s\S]*?)(?=<h3|<\/div>)/i,
  );
  if (cultureMatch) {
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(cultureMatch[1])) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(m[1]));
      if (text.length > 2) sections.talentCulture.push(text);
    }
  }

  return sections;
}

/**
 * Build a structured markdown description from parsed sections.
 */
export function buildDescription(sections, title, hotelKey, city) {
  const hotelNames = {
    mountain: 'Giardino Mountain',
    ascona: 'Giardino Ascona',
    lago: 'Giardino Lago',
  };
  const hotelName = hotelNames[hotelKey] || 'Giardino Group';

  const parts = [];

  // Intro
  parts.push(
    `Giardino Group sucht für das ${hotelName} in ${city} eine/n ${title}. Die Giardino Hotels sind eine charaktervolle Schweizer Luxushotelgruppe mit Standorten in St. Moritz, Ascona und Locarno.`,
  );

  // Job description
  if (sections.aboutJob) {
    parts.push(`\n## Aufgaben\n${sections.aboutJob}`);
  }

  // Requirements
  if (sections.aboutYou.length > 0) {
    parts.push(
      `\n## Anforderungen\n${sections.aboutYou.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  // Benefits
  if (sections.talentCulture.length > 0) {
    parts.push(
      `\n## Benefits\n${sections.talentCulture.map((b) => `- ${b}`).join('\n')}`,
    );
  }

  return parts.join('\n').trim();
}

/* ── Category Detection (hospitality-specific) ────────────── */

function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(koch|küche|chef|partie|cuisine|cook|steward|kitchen)/.test(t)) return 'Cucina / Gastronomia';
  if (/\b(service|kellner|waiter|waitress|sommelier|barkeeper|bar)/.test(t)) return 'Servizio';
  if (/\b(rezeption|reception|front.?desk|concierge|guest.?relation)/.test(t)) return 'Reception';
  if (/\b(housekeep|zimmer|reinigung|clean|room.?attend|gouvernant)/.test(t)) return 'Housekeeping';
  if (/\b(spa|wellness|massage|therap|beauty|fitness)/.test(t)) return 'Spa / Wellness';
  if (/\b(child|kinder|betreu|nanny|animat)/.test(t)) return 'Kinderbetreuung';
  if (/\b(techni|haustechni|maintenance|facilit|engineer)/.test(t)) return 'Technik';
  if (/\b(admin|buchhalt|account|finanz|hr|personal)/.test(t)) return 'Amministrazione';
  if (/\b(market|sales|verkauf|event|revenue)/.test(t)) return 'Marketing / Vendite';
  return 'Ospitalità';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Giardino Group.
 */
export function isGiardinoJob(job) {
  if (!job) return false;
  const key = String(job?.companyKey || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').trim().toLowerCase();
  const url = String(job?.url || '').trim().toLowerCase();

  return (
    key === GIARDINO_KEY ||
    key.startsWith('giardino') ||
    company.includes('giardino group') ||
    company.includes('giardino hotel') ||
    url.includes('giardinohotels.ch')
  );
}

/**
 * Validate that a URL belongs to Giardino Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'giardinohotels.ch' || host.endsWith('.giardinohotels.ch');
  } catch {
    return false;
  }
}

/* ── Build English public URL ─────────────────────────────── */

/**
 * Build the English public URL for a job from its WordPress slug.
 * The WP API returns German links (e.g. /de/jobs/gl-steward-m-w/),
 * but the English version is available at /en/jobs/{slug}/.
 */
export function buildPublicUrl(wpSlug) {
  return `${SITE_BASE}/en/jobs/${wpSlug}/`;
}

/* ── WordPress API Fetch ──────────────────────────────────── */

/**
 * Fetch job listings from the WordPress REST API.
 */
async function fetchJobListings() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from WordPress API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch ───────────────────────────────────────────── */

/**
 * Fetch all Giardino Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGiardinoJobs() {
  console.log('🔍 Fetching Giardino Group jobs');
  console.log(`   Source: ${API_URL}\n`);

  const listings = await fetchJobListings();
  if (!Array.isArray(listings) || listings.length === 0) {
    console.warn('⚠️ No job listings returned from WordPress API.');
    return [];
  }

  console.log(`  📋 WordPress jobs found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // WordPress REST API fields
    const wpTitle = decodeWpEntities(listing.title?.rendered || '');
    const wpSlug = listing.slug || '';
    const contentHtml = listing.content?.rendered || '';
    const categories = listing.categories || [];
    const wpDate = listing.date || '';
    const wpModified = listing.modified || '';
    const wpId = listing.id;

    // Extract clean title from <h1> inside content, fallback to WP title
    const h1Title = extractH1Title(contentHtml);
    const title = normalizeSpace(h1Title || wpTitle);
    if (!title || title.length < 3) continue;

    // Detect hotel and location
    const hotelKey = detectHotel(contentHtml, categories);
    const loc = getHotelLocation(hotelKey);
    const city = loc.city;
    const canton = loc.canton;
    const postalCode = loc.postalCode;

    // Parse content sections
    const sections = parseContentSections(contentHtml);

    // Build structured description
    const description = buildDescription(sections, title, hotelKey, city);

    // Public URL — use English version
    const publicUrl = buildPublicUrl(wpSlug);

    // Stable ID from WordPress post ID
    const idHash = createHash('sha1')
      .update(`wp-${wpId}`)
      .digest('hex')
      .slice(0, 12);

    const sourceLang = 'de'; // Content is always in German
    const jobSlug = slugify(`${title} giardino-group ${city}`);

    // Posted date from WordPress
    const postedDate = wpModified
      ? wpModified.split('T')[0]
      : wpDate
        ? wpDate.split('T')[0]
        : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `giardino-${idHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GIARDINO_COMPANY_NAME,
      companyKey: GIARDINO_KEY,
      companyDomain: GIARDINO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Giardino Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: sections.aboutYou,
      requirementsByLocale: { [sourceLang]: sections.aboutYou },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Giardino Group jobs discovered: ${jobs.length}`);
  return jobs;
}
