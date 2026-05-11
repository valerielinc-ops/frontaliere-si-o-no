#!/usr/bin/env node
/**
 * Kulm Hotel St. Moritz job parser — Fetcher and job builder.
 *
 * Source: https://careers.kulm.com/en/vacancies/json
 *
 * The Kulm Group careers portal (careers.kulm.com) is a Laravel/Vite SPA
 * backed by a paginated JSON API. Individual detail pages are server-rendered.
 *
 * Strategy:
 *   1. Paginate through the JSON API to collect all vacancies
 *   2. Fetch each detail page for rich descriptions
 *   3. Build ParsedJob objects
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKulmHotelJobs()  — Fetch and parse all jobs
 *   - isKulmHotelJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to this company
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KULM_HOTEL_KEY = 'kulm-hotel';
export const KULM_HOTEL_COMPANY_NAME = 'Kulm Hotel St. Moritz';
export const KULM_HOTEL_COMPANY_DOMAIN = 'kulm.com';

const API_BASE = 'https://careers.kulm.com/en/vacancies/json';
const CAREERS_URL = 'https://careers.kulm.com/en/vacancies';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}


/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kulm Hotel St. Moritz.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKulmHotelJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KULM_HOTEL_KEY ||
    key.startsWith('kulm-hotel') ||
    company.includes('kulm hotel st. moritz') ||
    url.includes('careers.kulm.com')
  );
}

/**
 * Validate that a URL belongs to Kulm Hotel St. Moritz's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'kulm.com' || host.endsWith('.kulm.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect hospitality-oriented job category from title.
 */
function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(chef de partie|cook|küche|cuisine|koch|pastry|bäcker|baker|breakfast)/.test(t)) return 'Cucina';
  if (/\b(chef de rang|waiter|waitress|commis de rang|maître|service|kellner|barista|sommelier|bar)/.test(t)) return 'Servizio';
  if (/\b(front office|reception|concierge|reservation|portier|guest relation|night audit)/.test(t)) return 'Ricevimento';
  if (/\b(housekeep|room attendant|linen|raumpflege|lingerie|laundry|pulizia|steward|office employee)/.test(t)) return 'Housekeeping';
  if (/\b(spa|therapist|wellness|pool|fitness|life guard|massage|beauty)/.test(t)) return 'Spa & Wellness';
  if (/\b(event|banquet|banchett|veranstaltung)/.test(t)) return 'Eventi';
  if (/\b(food.?beverage|f&b|f\.b\.|restaurant manager|outlet)/.test(t)) return 'Food & Beverage';
  if (/\b(florist|gärtner|garden|driver|chauffeur|fahrer|maintenance|techni|elektr|haustechnik)/.test(t)) return 'Servizi Generali';
  if (/\b(admin|segret|contab|buchhalt|account|hr|human|personal|finanz|finance)/.test(t)) return 'Amministrazione';
  if (/\b(market|kommunik|comunicaz|sales|revenue|digital)/.test(t)) return 'Marketing & Vendite';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(supervisor|manager|director|leiter|responsab)/.test(t)) return 'Management';
  return 'Ospitalità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|commis|assistant|demi)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager|maître|supervisor)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Location Mapping ─────────────────────────────────────── */

/**
 * Map the API's location field to city.
 * The Kulm Group operates:
 *   - Kulm Hotel (St. Moritz)
 *   - Grand Hotel Kronenhof (Pontresina)
 */
function mapLocationToCity(rawLocation = '') {
  const loc = normalize(rawLocation);
  if (loc.includes('kronenhof')) return 'Pontresina';
  if (loc.includes('kulm')) return 'St. Moritz';
  return 'St. Moritz';
}

function mapLocationToPostalCode(rawLocation = '') {
  const loc = normalize(rawLocation);
  if (loc.includes('kronenhof')) return '7504';
  return '7500';
}

/* ── Contract Type Mapping ────────────────────────────────── */

/**
 * Map contract_duration from API to employment/contract types.
 */
function mapContractDuration(duration = '', workload = '100') {
  const w = parseInt(workload, 10) || 100;
  const employmentType = w < 80 ? 'PART_TIME' : 'FULL_TIME';
  const contract = w < 80 ? 'part-time' : 'full-time';

  const contractLabels = {
    'indefinite': 'Unbefristet / Permanent',
    'seasonal': 'Saisonstelle / Seasonal',
    '10-months': '10-Monats-Stelle / 10-month contract',
    '6-months': '6-Monats-Stelle / 6-month contract',
  };

  return {
    employmentType,
    contract,
    contractType: duration || 'seasonal',
    contractLabel: contractLabels[duration] || duration || 'Seasonal',
  };
}

/* ── Fetch Helpers ────────────────────────────────────────── */

const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en,de;q=0.9',
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

/* ── JSON API — Paginated Listing ─────────────────────────── */

/**
 * Paginate through the JSON API to collect all vacancies.
 *
 * API: GET https://careers.kulm.com/en/vacancies/json?page=N
 * Returns: { data: [...], meta: { last_page: N } }
 *
 * Each item has: id, title, location, contract_duration, contract_starts_at, workload
 */
async function fetchAllVacanciesFromApi() {
  const allVacancies = [];
  let page = 1;
  let lastPage = 1;

  do {
    const url = `${API_BASE}?page=${page}`;
    console.log(`  📥 Fetching page ${page}/${lastPage}: ${url}`);
    const response = await fetchJson(url);

    if (response.data && Array.isArray(response.data)) {
      allVacancies.push(...response.data);
    }

    lastPage = response.meta?.last_page || 1;
    page++;
  } while (page <= lastPage);

  return allVacancies;
}

/* ── Detail Page Parsing ──────────────────────────────────── */

/**
 * Parse a Kulm Hotel detail page HTML for structured description.
 *
 * The detail page at /en/vacancies/{id} has this structure:
 *   <main id="main">
 *     <section>
 *       <h1>Job Title (m/w/d)</h1>
 *       <span>Location</span>  <span>100%</span>  <span>Start Date</span>
 *       <span>Duration</span>
 *     </section>
 *     <section class="entry container">
 *       <div class="content-page">
 *         <p>Intro paragraph...</p>
 *         <h2>This is what you move with us</h2>
 *         <ul><li>...</li></ul>
 *         <h2>This is you</h2>
 *         <ul><li>...</li></ul>
 *         <h2>Benefits</h2>
 *         <p>...</p>
 *       </div>
 *     </section>
 *   </main>
 */
function parseDetailPage(html = '') {
  // Extract the content-page div which contains the job description
  const contentMatch = html.match(/<div[^>]*class="[^"]*content-page[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<a)/i);
  if (!contentMatch) {
    // Fallback: try extracting from <main>
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (!mainMatch) return '';
    return extractSections(mainMatch[1]);
  }

  return extractSections(contentMatch[1]);
}

/**
 * Extract h2-delimited sections from the job content HTML.
 */
function extractSections(html = '') {
  const sections = [];
  const sectionRegex = /<h2[^>]*>([\s\S]*?)<\/h2>\s*([\s\S]*?)(?=<h2[^>]*>|<a\s[^>]*class="[^"]*btn|<section|$)/gi;
  const skipHeadings = /similar\s+jobs|andere\s+stellen|offerte\s+simili|cookie|privacy|navigation|footer/i;

  let match;
  while ((match = sectionRegex.exec(html)) !== null) {
    const heading = normalizeSpace(stripHtml(match[1]));
    if (!heading || heading.length > 100 || skipHeadings.test(heading)) continue;

    const content = normalizeDescriptionSpace(stripHtml(match[2]));
    if (!content || content.length < 20) continue;

    sections.push(`${heading}: ${content}`);
  }

  if (sections.length > 0) {
    // Also try to grab the intro paragraph before the first h2
    const introMatch = html.match(/^([\s\S]*?)<h2/i);
    if (introMatch) {
      const intro = normalizeSpace(stripHtml(introMatch[1]));
      if (intro.length > 30) {
        sections.unshift(intro);
      }
    }
    return sections.join(' | ');
  }

  // Fallback: extract all text from the HTML
  const text = normalizeDescriptionSpace(stripHtml(html));
  return text.length > 50 ? text : '';
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Kulm Hotel St. Moritz jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Paginate through JSON API for all vacancies
 *   2. Fetch each detail page for rich descriptions
 *   3. Build ParsedJob objects
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKulmHotelJobs() {
  console.log(`🔍 Fetching Kulm Hotel St. Moritz jobs`);
  console.log(`   API: ${API_BASE}`);
  console.log(`   Detail pages: https://careers.kulm.com/en/vacancies/{id}\n`);

  // Step 1: Fetch all vacancies from paginated JSON API
  const vacancies = await fetchAllVacanciesFromApi();

  if (!vacancies || vacancies.length === 0) {
    console.warn('⚠️ No vacancies returned from API.');
    return [];
  }

  console.log(`\n  📋 Total vacancies from API: ${vacancies.length}`);

  // Step 2: Fetch detail pages for rich descriptions
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 800;
  const jobs = [];

  for (let i = 0; i < vacancies.length; i++) {
    const vac = vacancies[i];
    const title = normalizeSpace(vac.title || '');
    if (!title || title.length < 3) continue;

    const detailUrl = `https://careers.kulm.com/en/vacancies/${vac.id}`;

    // Fetch detail page for full description
    let detailDescription = '';
    try {
      const detailHtml = await fetchHtml(detailUrl);
      detailDescription = parseDetailPage(detailHtml);
      if (i < vacancies.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for "${title}": ${err.message}`);
    }

    // Determine location/city from API data
    const locationLabel = vac.location || 'Kulm Hotel';
    const city = mapLocationToCity(locationLabel);
    const postalCode = mapLocationToPostalCode(locationLabel);
    const canton = inferAnyCanton(city) || 'GR';

    // Build URL hash for stable ID
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} kulm hotel st moritz`);

    // Map contract type
    const workload = vac.workload || '100';
    const { employmentType, contract, contractType, contractLabel } = mapContractDuration(vac.contract_duration, workload);

    // Posted date from contract_starts_at
    const postedDate = vac.contract_starts_at
      ? vac.contract_starts_at.slice(0, 10)
      : new Date().toISOString().split('T')[0];

    // Build description
    const metaLine = [
      `${title} — ${KULM_HOTEL_COMPANY_NAME} (${locationLabel}), ${city} (Engadin, Graubünden).`,
      `Pensum: ${workload}%. Vertrag: ${contractLabel}.`,
      vac.contract_starts_at ? `Stellenantritt: ${vac.contract_starts_at.slice(0, 10)}.` : '',
    ].filter(Boolean).join(' ');

    const detailWordCount = detailDescription ? detailDescription.split(/\s+/).length : 0;
    const hasRichDetail = detailWordCount >= 50;

    const fallbackDescription = [
      metaLine,
      `Die Kulm Gruppe betreibt zwei der exklusivsten 5-Sterne-Hotels im Engadin:`,
      `das Grand Hotel Kronenhof in Pontresina und das Kulm Hotel in St. Moritz.`,
      `Als Arbeitgeber bieten wir: Personalunterkunft in der Engadiner Bergwelt,`,
      `vergünstigte Verpflegung, umfassende Weiterbildungsmöglichkeiten,`,
      `attraktive Mitarbeitervergünstigungen und ein inspirierendes Arbeitsumfeld`,
      `in einer der schönsten Regionen der Schweiz.`,
    ].join(' ');

    const description = hasRichDetail
      ? `${metaLine}\n\n${detailDescription}`
      : fallbackDescription;

    const sourceLang = detectLang(title, 'en');

    const job = {
      // ── Required fields ──
      id: `kulm-hotel-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KULM_HOTEL_COMPANY_NAME,
      companyKey: KULM_HOTEL_KEY,
      companyDomain: KULM_HOTEL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: detailUrl,
      source: 'Kulm Hotel St. Moritz Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode,
      addressRegion: 'GR',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract,
      employmentType,
      contractType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment from API
    if (locationLabel) {
      job.department = locationLabel;
    }
    if (workload) {
      job.pensum = `${workload}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${(i + 1).toString().padStart(2)}/${vacancies.length}: ${title.substring(0, 55)} — ${locationLabel} (${workload}%)`);
  }

  console.log(`\n📋 Total Kulm Hotel St. Moritz jobs discovered: ${jobs.length}`);
  return jobs;
}
