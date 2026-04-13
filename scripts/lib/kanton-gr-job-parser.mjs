#!/usr/bin/env node
/**
 * Kantonale Verwaltung Graubünden job parser -- Fetcher and job builder.
 *
 * Source: https://apply.refline.ch/514915/search.html?lang=de
 *
 * The canton uses Refline ATS (Swiss recruitment platform). Jobs are listed
 * across three pages: search.html (regular), apprentice.html (Lehrstellen),
 * and stage.html (Schnupperlehren/internships). All pages render server-side
 * HTML tables with class="searchResult". Detail pages provide structured
 * content via well-known DOM IDs (#bDescription, #bDuty, #bRequirement).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKantonGrJobs()  -- Fetch and parse all jobs
 *   - isKantonGrJob()         -- Match jobs belonging to this company
 *   - isTrustedDomain()       -- Validate URLs belong to this company
 *   - slugify() / stripHtml() -- Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* -- Constants ------------------------------------------------- */

export const KANTON_GR_KEY = 'kanton-gr';
export const KANTON_GR_COMPANY_NAME = 'Kantonale Verwaltung Graubünden';
export const KANTON_GR_COMPANY_DOMAIN = 'gr.ch';

const REFLINE_TENANT = '514915';
const BASE_URL = `https://apply.refline.ch/${REFLINE_TENANT}`;

const LISTING_URLS = [
  `${BASE_URL}/search.html?lang=de`,
  `${BASE_URL}/apprentice.html?lang=de`,
  `${BASE_URL}/stage.html?lang=de`,
];

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* -- Helpers --------------------------------------------------- */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* -- Company Matchers ------------------------------------------ */

/**
 * Check if a job belongs to Kantonale Verwaltung Graubünden.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKantonGrJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KANTON_GR_KEY ||
    key.startsWith('kanton-gr') ||
    company.includes('kantonale verwaltung graubünden') ||
    url.includes('refline.ch/514915')
  );
}

/**
 * Validate that a URL belongs to Kantonale Verwaltung Graubünden's domains.
 * Must trust both gr.ch (official site) and refline.ch (ATS platform).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'gr.ch' || host.endsWith('.gr.ch') ||
      host === 'refline.ch' || host.endsWith('.refline.ch')
    );
  } catch {
    return false;
  }
}

/* -- Postal Code / Location Lookup ----------------------------- */

/**
 * Kanton GR covers many municipalities across Graubünden.
 */
const GR_POSTAL_CODES = {
  chur: '7000',
  cazis: '7408',
  davos: '7270',
  'davos platz': '7270',
  thusis: '7430',
  landquart: '7302',
  scuol: '7550',
  ilanz: '7130',
  poschiavo: '7742',
  samedan: '7503',
  'st. moritz': '7500',
  haldenstein: '7023',
  tiefencastel: '7450',
  schiers: '7220',
  domat: '7013',
  'domat/ems': '7013',
  zernez: '7530',
  pontresina: '7504',
};

function inferPostalCode(location = '') {
  const loc = normalize(location);
  for (const [city, code] of Object.entries(GR_POSTAL_CODES)) {
    if (loc.includes(city)) return code;
  }
  return '7000'; // Chur default (cantonal capital)
}

/* -- Category Detection ---------------------------------------- */

/**
 * Detect job category from title and department.
 * Adapted for public administration roles.
 */
function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);

  if (/\b(psycholog|psychiatr)/.test(t)) return 'Psicologia';
  if (/\b(arzt|ärztin|medizin|zahnarzt|zahnärztin)/.test(t)) return 'Medicina';
  if (/\b(pflege|fachperson gesundheit|fage|betreu|sanitä)/.test(t)) return 'Infermieristica';
  if (/\b(sozial|agog)/.test(t)) return 'Sociale';
  if (/\b(lehrer|lehrperson|lernend|schul|lehrstelle|schnupperlehre|apprenti|lehrling)/.test(t)) return 'Formazione';
  if (/\b(koch|küche|hotellerie|hauswirtschaft|gastro)/.test(t)) return 'Ristorazione';
  if (/\b(it[- ]|software|informatik|develop|system|engineer|cyber|sicherheits.*spezial)/.test(t) || d.includes('informatik')) return 'IT';
  if (/\b(ingenieur|chemiker|umwelt|bauleit|messtechnik|strassen)/.test(t)) return 'Ingegneria';
  if (/\b(poliz|sicherheit|verkehrsexpert)/.test(t) || d.includes('polizei')) return 'Sicurezza';
  if (/\b(jurist|recht|anwält|anwalt|staatsanwält)/.test(t) || d.includes('staatsanwalt')) return 'Legale';
  if (/\b(finanz|controll|steuer|buchhalt)/.test(t) || d.includes('steuerverwaltung')) return 'Finanza';
  if (/\b(hr[- ]|personal)/.test(t) || d.includes('personalamt')) return 'Risorse Umane';
  if (/\b(raumplan|raumentwickl)/.test(t)) return 'Ingegneria';
  if (/\b(admin|sachbearbeit|sekretär|assistent|mitarbeit)/.test(t)) return 'Amministrazione';
  if (/\b(wissenschaft|forsch)/.test(t)) return 'Ricerca';
  if (/\b(wald|natur|umwelt|forst)/.test(t) || d.includes('wald') || d.includes('natur')) return 'Ambiente';
  return 'Amministrazione Pubblica';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|lehrstelle|schnupperlehre)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|kommandant|bereichsleiter)/.test(t)) return 'senior';
  return 'mid';
}

/* -- HTML Fetching --------------------------------------------- */

/**
 * Fetch a page with timeout and standard headers.
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

/* -- HTML Parsing -- Listing Page ------------------------------ */

/**
 * Parse job rows from a Refline listing page HTML.
 *
 * Table structure:
 *   <table class="jquery-tablesorter searchResult">
 *     <thead>
 *       <tr>
 *         <th class="position">Stellentitel</th>
 *         <th class="department">Amt</th>
 *         <th class="workplace">Arbeitsort</th>
 *         <th class="deadline">Anmeldefrist</th>
 *       </tr>
 *     </thead>
 *     <tbody>
 *       <tr class="even|odd">
 *         <td class="position"><a href="https://apply.refline.ch/514915/{id}/pub/{n}/index.html">Title</a></td>
 *         <td class="department">Department</td>
 *         <td class="workplace">Location</td>
 *         <td class="deadline">dd.mm.yyyy</td>
 *       </tr>
 *     </tbody>
 *   </table>
 */
function parseListingRows(html = '') {
  const rows = [];

  // Match each <tr> that contains td.position with a link
  const rowRegex = /<tr\s+class="(?:even|odd)">\s*<td\s+class="position"><a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/td>\s*<td\s+class="department">([\s\S]*?)<\/td>\s*<td\s+class="workplace">([\s\S]*?)<\/td>\s*<td\s+class="deadline">([\s\S]*?)<\/td>\s*<\/tr>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const detailUrl = match[1].trim();
    const title = normalizeSpace(stripHtml(match[2]));
    const department = normalizeSpace(stripHtml(match[3]));
    const workplace = normalizeSpace(stripHtml(match[4]));
    const deadline = normalizeSpace(stripHtml(match[5]));

    if (!title || title.length < 3) continue;

    rows.push({ title, detailUrl, department, workplace, deadline });
  }

  return rows;
}

/**
 * Convert a German date (dd.mm.yyyy) to ISO format (yyyy-mm-dd).
 */
function parseGermanDate(dateStr = '') {
  const m = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/* -- HTML Parsing -- Detail Page ------------------------------- */

/**
 * Extract structured content from a Refline detail page.
 *
 * Key DOM elements:
 *   #bTitle          -- Job title (h1)
 *   #bSubTitle       -- "Department | Pensum | Location" (h2)
 *   #bIntro          -- Company intro text
 *   #bDescription    -- Job description
 *   #bDuty           -- Duties/responsibilities
 *   #bRequirement    -- Requirements
 *   .jobOffersBox    -- Benefits
 */
function parseDetailPage(html = '') {
  const result = {
    description: '',
    pensumMin: null,
    pensumMax: null,
  };

  // Extract subtitle for pensum info
  const subtitleMatch = html.match(/<h2\s+id="bSubTitle"[^>]*>([\s\S]*?)<\/h2>/i);
  if (subtitleMatch) {
    const subtitle = normalizeSpace(stripHtml(subtitleMatch[1]));
    const pensumMatch = subtitle.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
    if (pensumMatch) {
      result.pensumMin = parseInt(pensumMatch[1], 10);
      result.pensumMax = parseInt(pensumMatch[2], 10);
    } else {
      const singlePensum = subtitle.match(/(\d+)\s*%/);
      if (singlePensum) {
        result.pensumMin = parseInt(singlePensum[1], 10);
        result.pensumMax = parseInt(singlePensum[1], 10);
      }
    }
  }

  // Extract description sections
  const sections = [];

  const fields = [
    { id: 'bDescription', heading: '' },
    { id: 'bDuty', heading: 'Aufgaben' },
    { id: 'bRequirement', heading: 'Anforderungen' },
  ];

  for (const field of fields) {
    const regex = new RegExp(`<div\\s+id="${field.id}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
    const m = html.match(regex);
    if (m) {
      const text = normalizeSpace(stripHtml(m[1]));
      if (text.length > 10) {
        sections.push(field.heading ? `${field.heading}: ${text}` : text);
      }
    }
  }

  result.description = sections.join(' | ');
  return result;
}

/* -- Main Fetch Function --------------------------------------- */

/**
 * Fetch all Kantonale Verwaltung Graubünden jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch all three listing pages (search, apprentice, stage)
 *   2. Parse table rows from each listing
 *   3. For each row, fetch detail page for full description + pensum
 *   4. Build ParsedJob objects with all available metadata
 */
export async function fetchAllKantonGrJobs() {
  console.log(`🔍 Fetching Kantonale Verwaltung Graubünden jobs`);
  console.log(`   Sources: ${LISTING_URLS.join(', ')}\n`);

  // Step 1: Fetch all listing pages and collect rows
  const allRows = [];
  for (const listingUrl of LISTING_URLS) {
    try {
      console.log(`  📄 Fetching listing: ${listingUrl}`);
      const html = await fetchPage(listingUrl);
      const rows = parseListingRows(html);
      console.log(`     Found ${rows.length} jobs`);
      allRows.push(...rows);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch listing ${listingUrl}: ${err.message}`);
    }
  }

  if (allRows.length === 0) {
    console.warn('⚠️ No job listings found across all listing pages.');
    return [];
  }

  // Deduplicate by detail URL (in case same job appears on multiple pages)
  const seen = new Set();
  const uniqueRows = allRows.filter((row) => {
    if (seen.has(row.detailUrl)) return false;
    seen.add(row.detailUrl);
    return true;
  });

  console.log(`\n  📋 Total unique listings: ${uniqueRows.length}`);

  // Step 2: Fetch detail pages and build jobs
  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const row of uniqueRows) {
    const title = row.title;
    if (!title || title.length < 3) continue;

    // Fetch detail page for description + pensum
    let detail = { description: '', pensumMin: null, pensumMax: null };
    if (row.detailUrl) {
      try {
        const detailHtml = await fetchPage(row.detailUrl);
        detail = parseDetailPage(detailHtml);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
      }
    }

    const location = row.workplace || 'Chur';
    const canton = inferAnyCanton(location) || 'GR';
    const publicUrl = row.detailUrl || LISTING_URLS[0];
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} kanton-gr ch`);

    // Build description: prefer detail page content, fall back to listing metadata
    let descriptionText = detail.description;
    if (!descriptionText || descriptionText.length < 30) {
      const parts = [`${title} -- Kantonale Verwaltung Graubünden`];
      if (row.department) parts.push(`Amt: ${row.department}`);
      parts.push(`Arbeitsort: ${location} (${canton})`);
      if (detail.pensumMin != null && detail.pensumMax != null) {
        if (detail.pensumMin === detail.pensumMax) {
          parts.push(`Pensum: ${detail.pensumMin}%`);
        } else {
          parts.push(`Pensum: ${detail.pensumMin}-${detail.pensumMax}%`);
        }
      }
      if (row.deadline) parts.push(`Anmeldefrist: ${row.deadline}`);
      descriptionText = parts.join('. ');
    }

    // Determine employment type from pensum
    let employmentType = 'FULL_TIME';
    if (detail.pensumMax != null && detail.pensumMax < 80) {
      employmentType = 'PART_TIME';
    } else if (detail.pensumMax == null) {
      employmentType = 'OTHER';
    }

    // Detect if apprenticeship/internship
    const expLevel = detectExperienceLevel(title);
    if (expLevel === 'intern') {
      employmentType = 'OTHER';
    }

    const contract = (detail.pensumMax != null && detail.pensumMax >= 80) ? 'full-time' : 'part-time';

    const sourceLang = 'de';

    const job = {
      // -- Required fields --
      id: `kanton-gr-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KANTON_GR_COMPANY_NAME,
      companyKey: KANTON_GR_KEY,
      companyDomain: KANTON_GR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Kantonale Verwaltung Graubünden Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // -- Recommended fields --
      addressLocality: location,
      postalCode: inferPostalCode(location),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, row.department),
      contract,
      employmentType,
      experienceLevel: expLevel,
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (row.department) {
      job.department = row.department;
    }
    if (row.deadline) {
      const isoDeadline = parseGermanDate(row.deadline);
      if (isoDeadline) {
        job.applicationDeadline = isoDeadline;
      }
    }
    if (detail.pensumMin != null) {
      job.pensumMin = detail.pensumMin;
      job.pensumMax = detail.pensumMax;
      if (detail.pensumMin === detail.pensumMax) {
        job.pensum = `${detail.pensumMin}%`;
      } else {
        job.pensum = `${detail.pensumMin}-${detail.pensumMax}%`;
      }
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} -- ${location} (${row.department || 'N/A'})`);
  }

  console.log(`\n📋 Total Kantonale Verwaltung Graubünden jobs discovered: ${jobs.length}`);
  return jobs;
}
