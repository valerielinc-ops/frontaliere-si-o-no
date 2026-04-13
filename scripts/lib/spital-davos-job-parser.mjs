#!/usr/bin/env node
/**
 * Spital Davos job parser — Umantis ATS (tenant 2966).
 *
 * Listing page: https://recruitingapp-2966.umantis.com/Jobs/All?lang=ger
 *   - Server-rendered HTML table with newer Umantis 2023 UI
 *   - Job rows: <tr class="table-as-list__contentrow1|2">
 *   - Title+link: <h3 class="table-as-list__subtitle tableaslist_element_1152488"> → <a href="/Vacancies/{ID}/Description/1">
 *   - Snippet:    <p class="table-as-list__subtitle tableaslist_element_1184115"> (short teaser text)
 *   - Company:    tableaslist_element_1184128 → <span class="column-value"> (always "Spital Davos AG")
 *   - Art:        tableaslist_element_1184117 → <span class="column-value"> (Vollzeit/Teilzeit)
 *   - Befristung: tableaslist_element_1184118 → <span class="column-value"> (Unbefristet/Befristet)
 *   - Org unit:   tableaslist_element_1184120 → <span class="column-value"> (e.g. "Pflege", "Finanzen")
 *   - Apply:      tableaslist_element_1152500 → <a href="/Vacancies/{ID}/Application/CheckLogin/1">
 *
 * Detail page: /Vacancies/{ID}/Description/1
 *   - Custom HTML template (not standard Umantis customdatablock)
 *   - <title>Job Title</title>
 *   - #titelpup = formal job title
 *   - #titel = section headings (Ihr Aufgabengebiet, Ihr Profil, Unser Angebot)
 *   - #text, #aufzaehlung = content blocks with <ul><li> lists
 *   - #einleitung_text = intro/welcome text
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalDavosJobs()  — Fetch and parse all jobs
 *   - isSpitalDavosJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - slugify() / stripHtml()    — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_DAVOS_KEY = 'spital-davos';
export const SPITAL_DAVOS_COMPANY_NAME = 'Spital Davos';
export const SPITAL_DAVOS_COMPANY_DOMAIN = 'spitaldavos.ch';

const BASE_URL = 'https://recruitingapp-2966.umantis.com';
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
    .replace(/&szlig;/g, 'ß')
    .replace(/&#8209;/g, '-')
    .replace(/&#x2011;/g, '-')
    .replace(/&ndash;/g, '–')
    .replace(/&#8211;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Spital Davos.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSpitalDavosJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_DAVOS_KEY ||
    key.startsWith('spital-davos') ||
    company.includes('spital davos') ||
    url.includes('spitaldavos.ch') ||
    url.includes('recruitingapp-2966.umantis.com')
  );
}

/**
 * Validate that a URL belongs to Spital Davos's domain or the Umantis ATS.
 * Trusts both spitaldavos.ch and umantis.com.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'spitaldavos.ch' ||
      host.endsWith('.spitaldavos.ch') ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from title and department fields.
 * Spital Davos is a regional hospital — most roles are healthcare related.
 */
function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;

  if (/\b(pflege|pflegefach|stationsleitung|pflegehelfer|pflegehilfe|fage|fachperson gesundheit|spitex|langzeitpflege|nachtwache)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(arzt|ärztin|oberarzt|oberärztin|chefarzt|leitend|medizin|innere medizin|pädiatrie|chirurg|anästhes|notfall)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Assistenza';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|sachbearbeiter|finanzbuchhalt|faktur|account|finanz)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik|comunicaz)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti)/.test(signal)) return 'Formazione';
  return 'Sanità / Assistenza';
}

function detectExperienceLevel(title = '', entryLevel = '') {
  const t = normalize(title);
  const e = normalize(entryLevel);
  const signal = `${t} ${e}`;
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(signal)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(signal)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|stationsleitung|oberarzt|oberärztin|chefarzt)/.test(signal)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from the "Art" field and title.
 * Examples: "Vollzeit", "Teilzeit"
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
 * Examples: "80–100%", "50-60%", "40- 60 %", "60 - 90 %"
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

/* ── Listing Page Parser ──────────────────────────────────── */

/**
 * Parse the Umantis listing page HTML (2023 UI) and return an array of listing objects.
 *
 * Tenant 2966 uses a newer Umantis UI with:
 *   - <tr class="table-as-list__contentrow1|2"> instead of tableaslist_contentrow1|2
 *   - <h3> for title instead of <span>
 *   - <p> for snippet
 *   - <li> with tableaslist_element_* classes for metadata
 *   - <span class="column-value"> for field values
 *
 * Element IDs:
 *   - 1152488: title + link (in <h3>)
 *   - 1184115: snippet/teaser (in <p>)
 *   - 1184128: company name
 *   - 1184117: Art (employment type: Vollzeit/Teilzeit)
 *   - 1184118: Befristung (contract: Unbefristet/Befristet)
 *   - 1184120: Organisationseinheit (department)
 *   - 1152500: apply link
 */
export function parseSpitalDavosListingPage(html = '') {
  const results = [];
  const seen = new Set();

  // Match alternating row classes (newer Umantis 2023 UI uses table-as-list__ prefix)
  const rowRegex = /<tr\s+class="table-as-list__contentrow[12]"[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Extract title + link from element 1152488 (in <h3> with <a>)
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
    if (/^(initiativbewerbung|spontanbewerbung|blindbewerbung)$/i.test(title.trim())) continue;

    // Extract snippet from element 1184115
    const snippet = extractElementText(rowHtml, '1184115');

    // Extract metadata fields from column-value spans
    const artText = extractColumnValue(rowHtml, '1184117');
    const befristung = extractColumnValue(rowHtml, '1184118');
    const department = extractColumnValue(rowHtml, '1184120');

    results.push({
      vacancyId,
      title,
      snippet: normalizeSpace(snippet),
      artText: normalizeSpace(artText),
      befristung: normalizeSpace(befristung),
      department: normalizeSpace(department),
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/1`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/1`,
    });
  }

  return results;
}

/**
 * Extract text content from a <p> or <h3> with a specific Umantis element class.
 */
function extractElementText(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[^>]*>([\\s\\S]*?)(?:<\\/p\\s*>|<\\/h3\\s*>|<\\/li\\s*>)`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(stripHtml(match[1])));
}

/**
 * Extract column-value text from a metadata field.
 * These use: <span class="column-value" id="column_value_XXXX">VALUE</span>
 */
function extractColumnValue(rowHtml, elementId) {
  const regex = new RegExp(`tableaslist_element_${elementId}"[\\s\\S]*?<span\\s+class="column-value"[^>]*>([^<]+)<\\/span>`);
  const match = rowHtml.match(regex);
  if (!match) return '';
  return normalizeSpace(decodeEntities(match[1]));
}

/* ── Detail Page Parser ───────────────────────────────────── */

/**
 * Parse a Spital Davos detail page and extract the full job description.
 *
 * The detail page uses a custom HTML template:
 *   - <title>Job Title</title>
 *   - <div id="titelpup"> = formal job title
 *   - <div id="titel"> = section headings (Ihr Aufgabengebiet, Ihr Profil, Unser Angebot)
 *   - <div id="text"> or <div id="aufzaehlung"> = content with <ul><li> lists
 *   - <div id="einleitung_text"> = intro text
 *   - <div id="welcome"> = welcome/tagline
 */
export function parseSpitalDavosDetailPage(html = '', fallbackTitle = '') {
  // Extract title from <title> tag (detail pages have no <h1>)
  const titleTagMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = normalizeSpace(decodeEntities(titleTagMatch ? titleTagMatch[1] : fallbackTitle));

  // Extract all meaningful content blocks
  const blocks = [];

  // Intro text from #einleitung_text
  const introMatch = html.match(/<div\s+id="einleitung_text"[^>]*>([\s\S]*?)<\/div>/);
  if (introMatch) {
    const introText = normalizeSpace(stripHtml(decodeEntities(introMatch[1])));
    if (introText.length > 20) blocks.push(introText);
  }

  // Content from #text and #aufzaehlung divs (multiple occurrences)
  // These contain the main job description sections
  const contentRegex = /<div\s+id=(?:"?text"?|"?aufzaehlung"?)[^>]*>([\s\S]*?)<\/div>/g;
  let contentMatch;

  while ((contentMatch = contentRegex.exec(html)) !== null) {
    const rawContent = contentMatch[1];
    const cleaned = normalizeSpace(stripHtml(decodeEntities(rawContent)));
    // Skip very short blocks (metadata, empty sections) and CTA/apply blocks
    if (cleaned.length > 20 && !/^(Sind Sie bereit|Online bewerben|Die Rekrutierung erfolgt)/.test(cleaned)) {
      blocks.push(cleaned);
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
 * Fetch all Spital Davos jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML → parse rows
 *   2. For each job, fetch detail page → extract description
 *   3. Build ParsedJob objects
 */
export async function fetchAllSpitalDavosJobs() {
  console.log(`🏥 Fetching Spital Davos jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Step 1: Fetch and parse listing page
  const listingHtml = await fetchPage(LISTING_URL);
  const listings = parseSpitalDavosListingPage(listingHtml);

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
      const detail = parseSpitalDavosDetailPage(detailHtml, listing.title);
      descriptionText = detail.description;
      if (detail.title) detailTitle = detail.title;
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail for ${listing.vacancyId}: ${err?.message}`);
      // Use snippet from listing as fallback description
      if (listing.snippet) {
        descriptionText = listing.snippet;
      }
    }

    const title = detailTitle;
    const location = 'Davos';
    const canton = 'GR';

    const fallbackDesc = `${title} — Spital Davos, Davos`;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} spital-davos ch`);
    const urlHash = createHash('sha1')
      .update(`spital-davos-vacancy-${listing.vacancyId}`)
      .digest('hex')
      .slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(listing.artText, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `spital-davos-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_DAVOS_COMPANY_NAME,
      companyKey: SPITAL_DAVOS_KEY,
      companyDomain: SPITAL_DAVOS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || fallbackDesc,
      descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
      location,
      canton,
      url: listing.detailUrl,
      source: 'Spital Davos Dedicated Parser (Umantis)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '7270',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Assistenza',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (listing.department) {
      job.department = listing.department;
    }
    if (listing.befristung) {
      job.contractDuration = listing.befristung.toLowerCase() === 'befristet' ? 'temporary' : 'permanent';
    }
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 65)} — Davos (${listing.department || 'N/A'})`);

    // Rate limiting between detail page fetches
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n📋 Total Spital Davos jobs discovered: ${jobs.length}`);
  return jobs;
}
