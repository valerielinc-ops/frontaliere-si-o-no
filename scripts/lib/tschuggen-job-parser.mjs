#!/usr/bin/env node
/**
 * Tschuggen Collection job parser — Umantis ATS (tenant 2904).
 *
 * Listing page: https://recruitingapp-2904.umantis.com/Jobs/All?lang=ger
 *   - Server-rendered HTML table with alternating row classes
 *   - Job rows: <tr class="tableaslist_contentrow1|2">
 *   - Title+link: <span class="tableaslist_element_1152488"> → <a href="/Vacancies/{ID}/Description/1">
 *   - Entry level: <span class="tableaslist_element_1152493"> (e.g. "Einstieg als: Mitarbeiter")
 *   - Department:  <span class="tableaslist_element_1152494"> (e.g. "Abteilung: Rooms Division")
 *   - Location:    <span class="tableaslist_element_1152495"> (e.g. "Ascona, Tessin" or "Arosa, Graubünden")
 *
 * Detail page: /Vacancies/{ID}/Description/1
 *   - Custom HTML template (not standard Umantis customdatablock)
 *   - <title>Job Title - Hotel Name</title>
 *   - <h1>Job Title</h1>
 *   - <h2> sections: IHR PROFIL, IHRE AUFGABEN, BENEFITS
 *   - <p> blocks with description content
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllTschuggenJobs()  — Fetch and parse all jobs
 *   - isTschuggenJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const TSCHUGGEN_KEY = 'tschuggen';
export const TSCHUGGEN_COMPANY_NAME = 'Tschuggen Collection';
export const TSCHUGGEN_COMPANY_DOMAIN = 'tschuggencollection.ch';

const BASE_URL = 'https://recruitingapp-2904.umantis.com';
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Postal code lookup for Tschuggen locations ───────────── */

const LOCATION_POSTAL_CODES = {
  'arosa':      '7050',
  'ascona':     '6612',
  'st. moritz': '7500',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * Decode HTML entities (&amp; &nbsp; &uuml; etc.) from Umantis HTML.
 */
function decodeEntities(html = '') {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#8209;/g, '-')
    .replace(/&#x2011;/g, '-');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Tschuggen Collection.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isTschuggenJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === TSCHUGGEN_KEY ||
    key.startsWith('tschuggen') ||
    company.includes('tschuggen collection') ||
    company.includes('tschuggen') ||
    url.includes('tschuggencollection.ch') ||
    url.includes('recruitingapp-2904.umantis.com')
  );
}

/**
 * Validate that a URL belongs to Tschuggen Collection's domain or the Umantis ATS.
 * Trusts both tschuggencollection.ch and umantis.com.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'tschuggencollection.ch' ||
      host.endsWith('.tschuggencollection.ch') ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from title and department fields.
 * Tschuggen Collection is a luxury hotel group — most roles are hospitality related.
 */
function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;

  if (/\b(koch|küche|cuisine|chef de partie|commis|patissier|cuisinier|entremetier|garde.?manger|poissonnier|saucier|tournant)/.test(signal)) return 'Gastronomia';
  if (/\b(kellner|service|servier|sommelier|barkeeper|bartender|rang|restaur|f&b|food|beverage|bankett)/.test(signal)) return 'Gastronomia';
  if (/\b(rezeption|reception|front.?office|concierge|portier|guest.?relation|reservation|nachtportier|night.?audit)/.test(signal)) return 'Ospitalità';
  if (/\b(housekeep|zimmer|etagen|gouvernante|lingerie|wäscherei|laundry|rooms.?division)/.test(signal)) return 'Ospitalità';
  if (/\b(spa|massage|wellness|therapeut|kosmetik|beauty)/.test(signal)) return 'Ospitalità';
  if (/\b(techni|haustechni|hoteltechni|facility|wartung|maintenance|install|elektr|sanitär|schreiner|maler)/.test(signal)) return 'Tecnica';
  if (/\b(gärtn|florist|garten|landschaft|outdoor)/.test(signal)) return 'Altro';
  if (/\b(market|kommunik|comunicaz|brand|digital|social.?media|pr\b)/.test(signal)) return 'Marketing';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(admin|segret|contab|buchhalt|account|finanz|controlling)/.test(signal)) return 'Amministrazione';
  if (/\b(it|software|develop|programm|system)/.test(signal)) return 'IT';
  if (/\b(verkauf|sales|event)/.test(signal)) return 'Commerciale';
  if (/\b(logist|magazz|lager|einkauf)/.test(signal)) return 'Logistica';
  if (/\b(lernend|praktik|trainee|ausbildung|apprenti|stagiaire)/.test(signal)) return 'Formazione';
  return 'Ospitalità';
}

function detectExperienceLevel(title = '', entryLevel = '') {
  const t = normalize(title);
  const e = normalize(entryLevel);
  const signal = `${t} ${e}`;
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(signal)) return 'intern';
  if (/\b(junior|jr|assistent|commis)/.test(signal)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|sous.?chef|executive)/.test(signal)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from title text.
 * Tschuggen listing page does not have an "Art" field — we infer from title.
 */
function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'FULL_TIME'; // Hotel jobs default to full-time
}

/**
 * Extract pensum percentage from the title string.
 */
function extractPensum(title = '') {
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Location Extraction ─────────────────────────────────────── */

/**
 * Extract location city from the Umantis location field.
 * Patterns: "Ascona, Tessin", "Arosa, Graubünden", "St. Moritz, Graubünden"
 */
export function extractLocation(rawLocation = '') {
  const loc = normalizeSpace(decodeEntities(rawLocation))
    .replace(/^\|?\s*/, '')
    .trim();

  if (!loc) return 'Arosa';

  // Extract city (everything before the comma or the full string)
  const commaIdx = loc.indexOf(',');
  const city = commaIdx > 0 ? loc.substring(0, commaIdx).trim() : loc.trim();

  return city || 'Arosa';
}

/**
 * Look up postal code for a Tschuggen location.
 */
export function lookupPostalCode(city = '') {
  const key = normalize(city);
  return LOCATION_POSTAL_CODES[key] || '7050'; // Default to Arosa
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse the Umantis listing page HTML and return an array of listing objects.
 * Tenant 2904 has fewer fields than GKB (tenant 2607):
 *   - 1152488: title + link
 *   - 1152493: entry level (e.g. "Einstieg als: Mitarbeiter")
 *   - 1152494: department (e.g. "Abteilung: Rooms Division")
 *   - 1152495: location (e.g. "Ascona, Tessin")
 */
export function parseTschuggenListingPage(html = '') {
  const results = [];
  const seen = new Set();

  // Match alternating row classes — only content rows have job data
  const rowRegex = /<tr\s+class="tableaslist_contentrow[12]">([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Extract title + link from element 1152488
    const titleMatch = rowHtml.match(
      /tableaslist_element_1152488[\s\S]*?<a\s+href="\/Vacancies\/(\d+)\/Description\/\d+"[^>]*>([^<]+)<\/a>/
    );
    if (!titleMatch) continue;

    const vacancyId = titleMatch[1];
    if (seen.has(vacancyId)) continue;
    seen.add(vacancyId);

    const title = normalizeSpace(decodeEntities(titleMatch[2]));
    if (!title || title.length < 3) continue;

    // Skip spontaneous applications
    if (/^(initiativbewerbung|spontanbewerbung|blindbewerbung)$/i.test(title.trim())) continue;

    // Extract other fields using element class IDs
    const entryLevelRaw = extractSpanText(rowHtml, '1152493');
    const departmentRaw = extractSpanText(rowHtml, '1152494');
    const locationRaw = extractSpanText(rowHtml, '1152495');

    // Clean the prefix labels
    const entryLevel = normalizeSpace(entryLevelRaw.replace(/^\|?\s*Einstieg als:\s*/i, ''));
    const department = normalizeSpace(departmentRaw.replace(/^\|?\s*Abteilung:\s*/i, ''));
    const location = extractLocation(locationRaw);

    results.push({
      vacancyId,
      title,
      location,
      department,
      entryLevel,
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/1`,
    });
  }

  return results;
}

/**
 * Extract text from a span with a specific Umantis element class.
 */
function extractSpanText(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[^>]*>([\\s\\S]*?)(?=<span class="tableaslist_|<br\\s*/?>|$)`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(stripHtml(match[1])));
}

/* ── Detail Page Parser ───────────────────────────────────── */

/**
 * Parse a Tschuggen detail page and extract the full job description.
 *
 * The detail page uses a custom HTML template (not standard Umantis customdatablock):
 *   - <h1> = job title
 *   - <title>Title - Hotel Name</title> → can extract hotel name
 *   - <h2> sections: IHR PROFIL, IHRE AUFGABEN, BENEFITS
 *   - <p> blocks contain description text
 *   - <div class="col-12"> wraps each section
 */
export function parseTschuggenDetailPage(html = '', fallbackTitle = '') {
  // Extract title from h1
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title = normalizeSpace(decodeEntities(h1Match ? h1Match[1] : fallbackTitle));

  // Extract hotel name from <title>Title - Hotel Name</title>
  const titleTagMatch = html.match(/<title>([^<]+)<\/title>/);
  let hotelName = '';
  if (titleTagMatch) {
    const parts = titleTagMatch[1].split(' - ');
    if (parts.length > 1) {
      hotelName = normalizeSpace(decodeEntities(parts[parts.length - 1]));
    }
  }

  // Collect description blocks: all <p> content within <div class="col-12">
  // Strategy: find all <p>...</p> blocks in content area, skip very short or empty ones
  const blocks = [];
  const pRegex = /<p>([\s\S]*?)<\/p>/g;
  let pMatch;
  let inContent = false;

  // Only parse content after the <div id="content"> marker
  const contentStart = html.indexOf('<div id="content">');
  const contentHtml = contentStart >= 0 ? html.substring(contentStart) : html;

  while ((pMatch = pRegex.exec(contentHtml)) !== null) {
    const rawContent = pMatch[1];
    // Strip base64 images and HTML tags, then clean up
    const cleaned = normalizeSpace(
      stripHtml(
        decodeEntities(
          rawContent.replace(/<img[^>]*>/g, '')
        )
      )
    );
    if (cleaned.length > 15) {
      blocks.push(cleaned);
    }
  }

  // Also extract section headings (h2) for context
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  let h2Match;
  const sections = [];

  const contentHtml2 = contentStart >= 0 ? html.substring(contentStart) : html;
  while ((h2Match = h2Regex.exec(contentHtml2)) !== null) {
    const heading = normalizeSpace(stripHtml(decodeEntities(h2Match[1])));
    if (heading.length > 2) {
      sections.push(heading);
    }
  }

  // Build description: join all meaningful blocks
  const description = blocks.join(' | ');

  return { title, description, hotelName, sections };
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

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

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Tschuggen Collection jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML → parse rows
 *   2. For each job, fetch detail page → extract description
 *   3. Build ParsedJob objects
 */
export async function fetchAllTschuggenJobs() {
  console.log(`🏨 Fetching Tschuggen Collection jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Step 1: Fetch and parse listing page
  const listingHtml = await fetchPage(LISTING_URL);
  const listings = parseTschuggenListingPage(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on the page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}\n`);

  // Step 2: Fetch detail pages and build jobs
  const jobs = [];
  for (const listing of listings) {
    let descriptionText = '';
    let detailTitle = listing.title;
    let hotelName = '';

    try {
      const detailHtml = await fetchPage(listing.detailUrl);
      const detail = parseTschuggenDetailPage(detailHtml, listing.title);
      descriptionText = detail.description;
      if (detail.title) detailTitle = detail.title;
      if (detail.hotelName) hotelName = detail.hotelName;
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail for ${listing.vacancyId}: ${err?.message}`);
    }

    const title = detailTitle;
    const location = listing.location || 'Arosa';
    const canton = inferAnyCanton(location) || 'GR';
    const postalCode = lookupPostalCode(location);

    const fallbackDesc = `${title} — Tschuggen Collection, ${location}`;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} tschuggen ch`);
    const urlHash = createHash('sha1')
      .update(`tschuggen-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `tschuggen-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TSCHUGGEN_COMPANY_NAME,
      companyKey: TSCHUGGEN_KEY,
      companyDomain: TSCHUGGEN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || fallbackDesc,
      descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
      location,
      canton,
      url: listing.detailUrl,
      source: 'Tschuggen Collection Dedicated Parser (Umantis)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title, listing.entryLevel),
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (listing.department) {
      job.department = listing.department;
    }
    if (hotelName) {
      job.hotelName = hotelName;
    }
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 65)} — ${location} (${listing.department || 'N/A'})`);

    // Rate limiting between detail page fetches
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n📋 Total Tschuggen Collection jobs discovered: ${jobs.length}`);
  return jobs;
}
