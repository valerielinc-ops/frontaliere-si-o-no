#!/usr/bin/env node
/**
 * Graubündner Kantonalbank (GKB) job parser — Umantis ATS (tenant 2607).
 *
 * Listing page: https://recruitingapp-2607.umantis.com/Jobs/All?lang=ger
 *   - Server-rendered HTML table with alternating row classes
 *   - Job rows: <tr class="tableaslist_contentrow1|2">
 *   - Title+link: <span class="tableaslist_element_1152488"> → <a href="/Vacancies/{ID}/Description/1">
 *   - Location:   <span class="tableaslist_element_1152495"> (e.g. "Hauptsitz Chur", "Region Thusis")
 *   - Department: <span class="tableaslist_element_1152494"> (e.g. "Unternehmensbereich: ...")
 *   - Type:       <span class="tableaslist_element_1152491"> (e.g. "Art: Vollzeit", "Art: Teilzeit 60%")
 *   - Division:   <span class="tableaslist_element_1152496"> (e.g. "Märkte", "Digital Banking & Services")
 *   - Posted:     <span class="tableaslist_element_1152487"> (e.g. "Online seit: 10.04.2026")
 *   - Apply:      <span class="tableaslist_element_1152500"> → <a href="/Vacancies/{ID}/Application/CheckLogin/1">
 *
 * Detail page: /Vacancies/{ID}/Description/1
 *   - <h1 class="contenttitle"> = job title
 *   - <title>Title | GKB JobService</title>
 *   - Content in <div class="showblock_textblock"> → <div class="customdatablock">
 *   - Sections: intro, tasks (ul/li), requirements (ul/li), closing
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGkbJobs()   — Fetch and parse all jobs
 *   - isGkbJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GKB_KEY = 'gkb';
export const GKB_COMPANY_NAME = 'Graubündner Kantonalbank';
export const GKB_COMPANY_DOMAIN = 'gkb.ch';

const BASE_URL = 'https://recruitingapp-2607.umantis.com';
const LISTING_URL = `${BASE_URL}/Jobs/All?lang=ger`;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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
    .replace(/&szlig;/g, 'ß');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to GKB.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isGkbJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GKB_KEY ||
    key.startsWith('gkb') ||
    company.includes('graubündner kantonalbank') ||
    company.includes('graubundner kantonalbank') ||
    url.includes('gkb.ch') ||
    url.includes('recruitingapp-2607.umantis.com')
  );
}

/**
 * Validate that a URL belongs to GKB's domain or the Umantis ATS.
 * Trusts both gkb.ch and umantis.com.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'gkb.ch' ||
      host.endsWith('.gkb.ch') ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from title and department fields.
 * GKB is a cantonal bank — most roles are banking/finance related.
 */
function detectCategory(title = '', department = '', division = '') {
  const t = normalize(title);
  const d = normalize(department);
  const div = normalize(division);
  const signal = `${t} ${d} ${div}`;

  if (/\b(it|software|develop|programm|devops|system|architect|cyber|security|cloud|daten|data)/.test(signal)) return 'IT';
  if (/\b(payment|zahlungs)/.test(signal)) return 'Finanza / Banca';
  if (/\b(kredit|finanzier|hypothek|immobilien)/.test(signal)) return 'Finanza / Banca';
  if (/\b(compliance|risk|audit|revision|recht|legal|jurist)/.test(signal)) return 'Legale';
  if (/\b(berater|beratung|consult|kundenberater|privatkund|firmenkund|private banking|wealth|vermögen|anlage)/.test(signal)) return 'Finanza / Banca';
  if (/\b(market|kommunik|comunicaz|brand|digital|online)/.test(signal)) return 'Marketing';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(admin|segret|contab|buchhalt|account|controlling|finanzbuchhalt)/.test(signal)) return 'Amministrazione';
  if (/\b(analyst|business analyst|projekt|project)/.test(signal)) return 'Finanza / Banca';
  if (/\b(lernend|praktik|trainee|werkstudent|teilzeitstudent|apprenti|ausbildung)/.test(signal)) return 'Formazione';
  return 'Finanza / Banca';
}

function detectExperienceLevel(title = '', entryLevel = '') {
  const t = normalize(title);
  const e = normalize(entryLevel);
  const signal = `${t} ${e}`;
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|werkstudent|teilzeitstudent)/.test(signal)) return 'intern';
  if (/\b(junior|jr|berufseinsteiger|assistent)/.test(signal)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|teamleiter|abteilungsleiter)/.test(signal)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from the "Art" field.
 * Examples: "Vollzeit", "Teilzeit 60%", "Vollzeit/Teilzeit"
 */
function detectEmploymentType(artText = '', title = '') {
  const t = normalize(artText || title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  // Check percentage in title
  const pctMatch = normalize(title).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || normalize(title).match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/**
 * Extract pensum percentage from the title string.
 * Examples: "80-100%", "60 - 100 %", "40%", "60–100 %"
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

/**
 * Parse DD.MM.YYYY → YYYY-MM-DD. Returns '' on failure.
 */
export function parseDate(raw = '') {
  const m = String(raw || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Extract location city from the Umantis location field.
 * Patterns: "Hauptsitz Chur", "Region Thusis", "Region Arosa", "Filiale Davos"
 */
export function extractLocation(rawLocation = '') {
  const loc = normalizeSpace(decodeEntities(rawLocation))
    .replace(/^\|?\s*/, '')
    .trim();

  if (!loc) return 'Chur';

  // Remove "Hauptsitz", "Region", "Filiale", "Standort" prefixes
  const cleaned = loc
    .replace(/^(hauptsitz|region|filiale|standort)\s+/i, '')
    .trim();

  return cleaned || 'Chur';
}

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse the Umantis listing page HTML and return an array of listing objects.
 * Each object: { vacancyId, title, location, department, division, artText, entryLevel, postedDate, detailUrl, applyUrl }
 */
export function parseGkbListingPage(html = '') {
  const results = [];
  const seen = new Set();

  // Match alternating row classes
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

    // Skip initiative/spontaneous application placeholders
    if (/^(initiativbewerbung|spontanbewerbung)$/i.test(title.trim())) continue;

    // Extract other fields using element class IDs
    const locationRaw = extractSpanText(rowHtml, '1152495');
    const department = extractSpanText(rowHtml, '1152494');
    const artText = extractSpanText(rowHtml, '1152491');
    const division = extractSpanText(rowHtml, '1152496');
    const entryLevel = extractSpanText(rowHtml, '1152493');
    const postedRaw = extractSpanText(rowHtml, '1152487');

    // Clean the prefix labels
    const location = extractLocation(locationRaw);
    const dept = normalizeSpace(department.replace(/^\|?\s*Unternehmensbereich:\s*/i, ''));
    const art = normalizeSpace(artText.replace(/^\|?\s*Art:\s*/i, ''));
    const div = normalizeSpace(division.replace(/^\|?\s*/, ''));
    const entry = normalizeSpace(entryLevel.replace(/^\|?\s*Einstieg als:\s*/i, ''));
    const postedDate = parseDate(postedRaw);

    results.push({
      vacancyId,
      title,
      location,
      department: dept,
      division: div,
      artText: art,
      entryLevel: entry,
      postedDate,
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/1`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
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
 * Parse a detail page and extract the full job description.
 *
 * The detail page has multiple showblock_textblock divs containing customdatablock divs:
 *   1. Company info + posted date
 *   2. Intro text
 *   3. Tasks (ul/li)
 *   4. Requirements (ul/li)
 *   5. Closing text / call to action
 *   6. Actions (apply link)
 */
export function parseGkbDetailPage(html = '', fallbackTitle = '') {
  // Extract title from h1
  const h1Match = html.match(/<h1[^>]*class="contenttitle"[^>]*>([^<]+)<\/h1>/);
  const title = normalizeSpace(decodeEntities(h1Match ? h1Match[1] : fallbackTitle));

  // Extract all customdatablock content sections
  const blocks = [];
  const blockRegex = /<div\s+class="customdatablock"[^>]*>([\s\S]*?)<\/div>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const content = normalizeSpace(stripHtml(decodeEntities(blockMatch[1])));
    // Skip empty blocks and short metadata blocks (company name, dates)
    if (content.length > 20) {
      blocks.push(content);
    }
  }

  // Join all meaningful content blocks
  const description = blocks.join(' | ');

  return { title, description };
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
 * Fetch all GKB jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML → parse rows
 *   2. For each job, fetch detail page → extract description
 *   3. Build ParsedJob objects
 */
export async function fetchAllGkbJobs() {
  console.log(`🏦 Fetching Graubündner Kantonalbank jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Step 1: Fetch and parse listing page
  const listingHtml = await fetchPage(LISTING_URL);
  const listings = parseGkbListingPage(listingHtml);

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

    try {
      const detailHtml = await fetchPage(listing.detailUrl);
      const detail = parseGkbDetailPage(detailHtml, listing.title);
      descriptionText = detail.description;
      if (detail.title) detailTitle = detail.title;
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail for ${listing.vacancyId}: ${err?.message}`);
    }

    const title = detailTitle;
    const location = listing.location || 'Chur';
    const canton = inferSwissTargetCanton(location) || 'GR';

    const fallbackDesc = `${title} — Graubündner Kantonalbank, ${location}`;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} gkb ch`);
    const urlHash = createHash('sha1')
      .update(`gkb-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(listing.artText, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `gkb-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GKB_COMPANY_NAME,
      companyKey: GKB_KEY,
      companyDomain: GKB_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || fallbackDesc,
      descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
      location,
      canton,
      url: listing.detailUrl,
      source: 'Graubündner Kantonalbank Dedicated Parser (Umantis)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '7000',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department, listing.division),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title, listing.entryLevel),
      sector: 'Finanza / Banca',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (listing.department) {
      job.department = listing.department;
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

  console.log(`\n📋 Total GKB jobs discovered: ${jobs.length}`);
  return jobs;
}
