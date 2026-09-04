#!/usr/bin/env node
/**
 * Etat de Fribourg (Canton of Fribourg cantonal government) job parser.
 *
 * Source: https://jobs.fr.ch/
 *
 * Confirmed live (2026-07-04): this is a SAP SuccessFactors Career Site
 * Builder (CSB) tenant -- same platform family as ZURZACH Care / Helsana /
 * Tecan (see `successfactors-shared-job-parser-common.mjs`) -- but a
 * DIFFERENT template flavor than the "html-jobreq" table layout that shared
 * factory targets. `jobs.fr.ch` renders search results as a "tile" layout
 * (`<li class="job-tile job-id-{id}">`), not `<tr class="jobTitle-column">`
 * rows, and the results-count string ("Affichage de N sur M parmi TOTAL
 * offres d'emploi" / "N von TOTAL Stellen angezeigt") does not match the
 * "Ergebnisse N-M von TOTAL" pattern `extractCsbTotal` expects. Listing
 * parsing is therefore bespoke below.
 *
 * Detail pages (`/job/{slug}/{jobId}/`), however, use the SAME
 * `data-careersite-propertyid` + schema.org microdata markup the shared
 * factory already parses, so `parseCsbDetailPage()` is reused as-is for
 * title/description/postedDate/applyUrl/language extraction. Its location
 * regex expects "City, Region, CC[, PLZ]" but this tenant emits
 * "City, CC, District" (e.g. "Fribourg, CH, Saane"), so it never matches --
 * city/canton/postalCode are derived locally from the listing tile instead.
 *
 * Bilingual confirmed live: some detail pages render fr-FR, others de-DE
 * (canton has French- and German-speaking districts). `parseCsbDetailPage`'s
 * `language` field (read from the page's own `<html lang>` attribute)
 * is used per-job rather than a single hardcoded sourceLang.
 *
 * Exports the 4 functions the crawler template expects:
 *   - fetchAllEtatDeFribourgJobs()  -- Fetch and parse all jobs
 *   - isEtatDeFribourgJob()         -- Match jobs belonging to this employer
 *   - isTrustedDomain()             -- Validate URLs belong to this employer
 *   - slugify() / stripHtml()       -- Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { parseCsbDetailPage } from './successfactors-shared-job-parser-common.mjs';
import { decodeEntities } from './hospital-custom-html-helpers.mjs';
import { isSuccessFactorsWidgetText } from './successfactors-jobs2web-widget-guard.mjs';
import { isDedicatedFribourgEmployer } from './crawler-company-ownership.mjs';

/* -- Constants ------------------------------------------------- */

export const ETAT_DE_FRIBOURG_KEY = 'etat-de-fribourg';
export const ETAT_DE_FRIBOURG_COMPANY_NAME = 'Etat de Fribourg';
export const ETAT_DE_FRIBOURG_COMPANY_DOMAIN = 'fr.ch';

const BASE_URL = 'https://jobs.fr.ch';
const PAGE_SIZE = 25;
const MAX_PAGES = 40; // hard safety cap (1000 jobs) — real total is ~118

/* -- Helpers --------------------------------------------------- */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* -- Company Matchers ------------------------------------------ */

/**
 * Check if a job belongs to Etat de Fribourg (cantonal administration).
 * Distinct from Fribourg-based hospital/health entities that are their own
 * dedicated employers (HFR / hfr-hopital-fribourgeois, RFSM / rfsm-fribourg).
 */
export function isEtatDeFribourgJob(job) {
  if (isDedicatedFribourgEmployer(job)) return false;
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ETAT_DE_FRIBOURG_KEY ||
    company.includes('etat de fribourg') ||
    company.includes('état de fribourg') ||
    company.includes('staat freiburg') ||
    url.includes('jobs.fr.ch')
  );
}

/**
 * Validate that a URL belongs to Etat de Fribourg's domains.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.fr.ch' || host.endsWith('.jobs.fr.ch') ||
      host === 'fr.ch' || host.endsWith('.fr.ch')
    );
  } catch {
    return false;
  }
}

/* -- Postal Code Lookup ------------------------------------------ */

/**
 * Canton Fribourg covers French- and German-speaking districts. Map the
 * municipalities that actually appear in the live listing; fall back to
 * the cantonal capital (Fribourg, 1700) for anything else.
 */
const FR_POSTAL_CODES = {
  fribourg: '1700',
  'villars-sur-glâne': '1752',
  'villars-sur-glane': '1752',
  givisiez: '1762',
  marly: '1723',
  'granges-paccot': '1763',
  bulle: '1630',
  romont: '1680',
  kerzers: '3210',
  murten: '3280',
  morat: '3280',
  'estavayer-le-lac': '1470',
  'chatel-saint-denis': '1618',
  'châtel-saint-denis': '1618',
  düdingen: '3186',
  duedingen: '3186',
  guin: '3186',
  tafers: '1712',
  schmitten: '1712',
  plaffeien: '1719',
  courtepin: '1784',
  wünnewil: '1734',
  wuennewil: '1734',
  gruyères: '1663',
  gruyeres: '1663',
  broc: '1636',
  domdidier: '1564',
};

function inferPostalCode(city = '') {
  const key = normalize(city);
  for (const [name, code] of Object.entries(FR_POSTAL_CODES)) {
    if (key.includes(name)) return code;
  }
  return '1700'; // Fribourg cantonal capital default
}

/* -- Category / Experience Detection (bilingual FR/DE) ----------- */

function detectCategory(title = '', dept = '') {
  const t = normalize(`${title} ${dept}`);
  if (/\b(enseign|instituteur|professeur|lehrer|lehrperson|unterricht|schule|école|ecole)/.test(t)) return 'Istruzione';
  if (/\b(psycholog|infirmi|santé|sante|soins|medizin|pflege|gesundheit|social|sozial)/.test(t)) return 'Sanità';
  if (/\b(informati|informatik|développeur|developpeur|entwickler|digital)/.test(t)) return 'Informatica';
  if (/\b(droit|juridique|jurist|avocat|recht|justice|sicherheit|police|polizei)/.test(t)) return 'Giuridico';
  if (/\b(forêt|foret|nature|environnement|umwelt|forst|wald)/.test(t)) return 'Ambiente';
  if (/\b(finance|comptab|budget|steuer|fisc|impôt)/.test(t)) return 'Finanza';
  return 'Amministrazione Pubblica';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiaire|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti|apprentissage|praktikant|praktikum|lehrling|lernende|schnupperlehre)/.test(t)) return 'intern';
  if (/\b(junior|jr\.)/.test(t)) return 'junior';
  if (/\b(senior|sr\.|chef|responsable|directeur|directrice|leiter|leiterin|verantwortlich|chargé.e? de direction)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Parse a pensum/shifttype string ("10-15%", "100%", "25-30%") into
 * { min, max } integers, or null if unparseable.
 */
function parsePensum(text = '') {
  const range = text.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = text.match(/(\d+)\s*%/);
  if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
  return null;
}

/* -- HTML Parsing -- Listing Page (tile layout) ------------------ */

/**
 * Parse job tiles from a jobs.fr.ch `/search/` listing page.
 *
 * Layout: `<li class="job-tile job-id-{ID} ..." data-url="/job/.../{ID}/">`
 * wraps both desktop and mobile section variants; field values live at
 * `id="job-{ID}-{desktop|mobile}-section-{field}-value"`.
 */
function parseListingTiles(html = '') {
  const chunks = String(html || '').split('<li class="job-tile job-id-').slice(1);
  const rows = [];

  for (const chunk of chunks) {
    const idMatch = chunk.match(/^(\d+)/);
    if (!idMatch) continue;
    const jobId = idMatch[1];

    const urlMatch = chunk.match(/data-url="([^"]+)"/);
    if (!urlMatch) continue;
    const relUrl = decodeEntities(urlMatch[1]);

    const titleMatch = chunk.match(/<a class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? normalizeSpace(decodeEntities(stripHtml(titleMatch[1]))) : '';
    if (!title) continue;
    // A row whose anchor text is j2w page chrome (cookie-consent widget,
    // search/alert box) isn't a job at all — discard the row, don't clean it,
    // or it becomes a posting with no title.
    if (isSuccessFactorsWidgetText(title)) continue;

    const cityMatch =
      chunk.match(new RegExp(`id="job-${jobId}-desktop-section-city-value">([^<]*)`)) ||
      chunk.match(new RegExp(`id="job-${jobId}-mobile-section-city-value">([^<]*)`));
    const cityRaw = cityMatch ? normalizeSpace(decodeEntities(cityMatch[1])) : '';
    const city = cityRaw.split(',')[0].trim();

    const shiftMatch =
      chunk.match(new RegExp(`id="job-${jobId}-desktop-section-shifttype-value">([^<]*)`)) ||
      chunk.match(new RegExp(`id="job-${jobId}-mobile-section-shifttype-value">([^<]*)`));
    const pensumText = shiftMatch ? normalizeSpace(decodeEntities(shiftMatch[1])) : '';

    const deptMatch =
      chunk.match(new RegExp(`id="job-${jobId}-desktop-section-dept-value">([^<]*)`)) ||
      chunk.match(new RegExp(`id="job-${jobId}-mobile-section-dept-value">([^<]*)`));
    const department = deptMatch ? normalizeSpace(decodeEntities(deptMatch[1])) : '';

    rows.push({ jobId, relUrl, title, city, pensumText, department });
  }

  return rows;
}

/* -- Fetch All Jobs ----------------------------------------------- */

/**
 * Fetch all Etat de Fribourg jobs.
 * Returns an array of ParsedJob objects (source-locale only, per-job lang).
 *
 * Flow:
 * 1. Paginate `/search/?startrow=N` (25/page) until a page returns 0 tiles
 * 2. Parse each tile: jobId, title, detail URL, city, pensum, department
 * 3. Fetch each detail page, reuse `parseCsbDetailPage` (SuccessFactors CSB
 *    detail markup matches the shared factory even though listing doesn't)
 * 4. Build ParsedJob objects with all available metadata
 */
export async function fetchAllEtatDeFribourgJobs() {
  console.log('🔍 Fetching Etat de Fribourg jobs');
  console.log(`  Source: ${BASE_URL}/search/\n`);

  const allRows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const listingUrl = `${BASE_URL}/search/?startrow=${startrow}`;
    try {
      console.log(`  📄 Fetching listing page: startrow=${startrow}`);
      const html = await fetchHtml(listingUrl);
      const rows = parseListingTiles(html);
      console.log(`    Found ${rows.length} tiles`);
      if (rows.length === 0) break;
      allRows.push(...rows);
      if (rows.length < PAGE_SIZE) break; // last page
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch listing page startrow=${startrow}: ${err.message}`);
      break;
    }
  }

  if (allRows.length === 0) {
    console.warn('⚠️ No job listings found.');
    return [];
  }

  // Deduplicate by jobId (tenant occasionally repeats a tile across pages)
  const seen = new Set();
  const uniqueRows = allRows.filter((row) => {
    if (seen.has(row.jobId)) return false;
    seen.add(row.jobId);
    return !isDedicatedFribourgEmployer(row);
  });

  console.log(`\n  📋 Total unique listings: ${uniqueRows.length}`);

  // Fetch detail pages and build jobs
  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const row of uniqueRows) {
    const { title } = row;
    if (!title || title.length < 2) continue;

    const detailUrl = `${BASE_URL}${row.relUrl}`;
    let detail = null;
    try {
      const detailHtml = await fetchHtml(detailUrl);
      detail = parseCsbDetailPage(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const city = row.city || detail?.city || 'Fribourg';
    const canton = inferAnyCanton(city) || 'FR';
    const postalCode = detail?.postalCode || inferPostalCode(city);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} etat-de-fribourg ch`);

    // Description: prefer detail page content, fall back to listing metadata.
    let descriptionText = detail?.descriptionText || '';
    if (!descriptionText || descriptionText.split(/\s+/).filter(Boolean).length < 30) {
      const parts = [`${title} -- Etat de Fribourg`];
      if (row.department) parts.push(`Service: ${row.department}`);
      parts.push(`Lieu de travail: ${city} (${canton})`);
      if (row.pensumText) parts.push(`Taux d'activité: ${row.pensumText}`);
      descriptionText = parts.join('. ');
    }

    const pensum = parsePensum(row.pensumText);
    const expLevel = detectExperienceLevel(title);

    let employmentType = 'FULL_TIME';
    if (pensum && pensum.max < 80) {
      employmentType = 'PART_TIME';
    }
    if (expLevel === 'intern') {
      employmentType = 'OTHER';
    }
    const contract = !pensum || pensum.max >= 80 ? 'full-time' : 'part-time';

    const sourceLang = detail?.language || detectLang(descriptionText, 'fr') || 'fr';

    const applyUrl = detail?.applyUrl
      ? (detail.applyUrl.startsWith('http') ? detail.applyUrl : `${BASE_URL}${detail.applyUrl}`)
      : detailUrl;

    const job = {
      // -- Required fields --
      id: `etat-de-fribourg-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ETAT_DE_FRIBOURG_COMPANY_NAME,
      companyKey: ETAT_DE_FRIBOURG_KEY,
      companyDomain: ETAT_DE_FRIBOURG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: detailUrl,
      source: 'Etat de Fribourg Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // -- Recommended fields --
      addressLocality: city,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, row.department),
      contract,
      employmentType,
      experienceLevel: expLevel,
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate: detail?.postedDate || new Date().toISOString().split('T')[0],
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (row.department) {
      job.department = row.department;
    }
    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min}-${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} -- ${city} (${row.department || 'N/A'})`);
  }

  console.log(`\n📋 Total Etat de Fribourg jobs discovered: ${jobs.length}`);
  return jobs;
}
