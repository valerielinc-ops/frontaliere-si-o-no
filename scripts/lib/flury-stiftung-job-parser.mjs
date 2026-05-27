#!/usr/bin/env node
/**
 * Flury Stiftung job parser — Fetcher and job builder.
 *
 * Source: https://www.flurystiftung.ch/de/jobs
 *
 * Flury Stiftung is a healthcare provider in Prättigau, Graubünden, operating
 * a hospital (Spital Schiers), retirement homes (Altersheime), Spitex,
 * a medical centre (Medizinisches Zentrum Klosters), a crèche, and more.
 *
 * Career page tech: Drupal CMS. Jobs are listed as PDF file downloads in
 * `<span class="file file--mime-application-pdf">` elements, grouped by
 * organisational unit via `<caption>` headers inside `<table>` blocks.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFluryStiftungJobs()  — Fetch and parse all jobs
 *   - isFluryStiftungJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()            — Validate URLs belong to this company
 *   - slugify() / stripHtml()      — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FLURY_STIFTUNG_KEY = 'flury-stiftung';
export const FLURY_STIFTUNG_COMPANY_NAME = 'Flury Stiftung';
export const FLURY_STIFTUNG_COMPANY_DOMAIN = 'flurystiftung.ch';

const CAREER_URL = 'https://www.flurystiftung.ch/de/jobs';
const BASE_URL = 'https://www.flurystiftung.ch';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Flury Stiftung.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFluryStiftungJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FLURY_STIFTUNG_KEY ||
    key.startsWith('flury-stiftung') ||
    company.includes('flury stiftung') ||
    url.includes('flurystiftung.ch')
  );
}

/**
 * Validate that a URL belongs to Flury Stiftung's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'flurystiftung.ch' || host.endsWith('.flurystiftung.ch');
  } catch {
    return false;
  }
}

/* ── Location Inference ───────────────────────────────────── */

/**
 * Flury Stiftung locations in Prättigau (GR).
 * The section/category and title text can hint at the specific facility location.
 */
const LOCATION_MAP = {
  schiers: { city: 'Schiers', postalCode: '7220' },
  jenaz: { city: 'Jenaz', postalCode: '7233' },
  klosters: { city: 'Klosters', postalCode: '7250' },
};

/**
 * Infer location from the section category and job title.
 * Falls back to Schiers (HQ / Spital location).
 */
function inferLocation(category = '', title = '') {
  const combined = normalize(`${category} ${title}`);

  if (combined.includes('klosters')) return LOCATION_MAP.klosters;
  if (combined.includes('jenaz')) return LOCATION_MAP.jenaz;

  // Spital Schiers, Altersheim Schiers, and HQ are all in Schiers
  return LOCATION_MAP.schiers;
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Map the Drupal section caption to a job category.
 * Sections on the page: Flury Stiftung, Spital Schiers, Altersheime,
 * Spitex, Medizinisches Zentrum Klosters, Kinderkrippe, Lehrstellen.
 */
function detectCategory(sectionName = '', title = '') {
  const s = normalize(sectionName);
  const t = normalize(title);

  // Lehrstellen (apprenticeships) take precedence
  if (s.includes('lehrstellen') || /\blehrstelle\b/.test(t)) return 'Formazione';

  // ICT / IT
  if (/\b(ict|it|software|develop|informatik|datenschutz)/.test(t)) return 'IT';

  // Medical / doctor roles
  if (/\b(arzt|ärztin|assistenzarzt|unterassistenz|hebamme|pharma|praxisassistenz)/.test(t)) return 'Medicina';

  // Nursing / care
  if (/\b(pflege|fage|fachperson gesundheit|berufsbildner|srk)/.test(t)) return 'Infermieristica';

  // Laboratory
  if (/\b(labor|biomedizin|analytik)/.test(t)) return 'Laboratorio';

  // Childcare
  if (s.includes('kinderkrippe') || /\b(fabe|betreuung|kinder)/.test(t)) return 'Sociale';

  // Housekeeping / hospitality / gastronomy
  if (/\b(hauswirtschaft|gastronomie|haushalt|hotellerie|küche)/.test(t)) return 'Ristorazione';

  // Administration
  if (/\b(admin|kaufmann|kauffrau|sekretär|buchhalt|departement)/.test(t)) return 'Amministrazione';

  // Spitex / home care
  if (s.includes('spitex')) return 'Infermieristica';

  // Default for healthcare provider
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrstelle|lehrling|lernend|apprenti|praktik)/.test(t)) return 'intern';
  if (/\b(unterassistenz)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|chef|verantwort|fachverantwort|leitung|departementsleitung)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Extract pensum (work percentage) from title text.
 * E.g., "40 - 100%", "50%", "50 - 80%", "50-100%"
 */
function extractPensum(title = '') {
  // Range: "40 - 100%", "50-80%"
  const rangeMatch = title.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  // Single: "100%", "50%"
  const singleMatch = title.match(/(\d+)\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return { min: 100, max: 100 }; // default full-time
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Fetch the listing page HTML.
 */
async function fetchListingPage() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CAREER_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from listing page`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse all PDF job listings from the page HTML.
 *
 * Page structure (Drupal Views):
 *   <div class="table-responsive">
 *     <div class="caption">
 *       <caption>Section Name</caption>
 *     </div>
 *     <table class="views-table ...">
 *       <tbody>
 *         <tr>
 *           <td class="views-field views-field-field-media-file">
 *             <span class="file file--mime-application-pdf ...">
 *               <a href="/sites/default/files/..." type="application/pdf" title="...">
 *                 Job Title Text
 *               </a>
 *             </span>
 *           </td>
 *         </tr>
 *         ...
 *       </tbody>
 *     </table>
 *   </div>
 *
 * Returns array of { title, pdfUrl, section }.
 */
export function parseJobListings(html = '') {
  const listings = [];

  // Split by table-responsive blocks to capture the section context
  const blocks = html.split(/<div class="table-responsive">/);

  for (const block of blocks) {
    // Extract section name from <caption>
    const captionMatch = block.match(/<caption>\s*([\s\S]*?)\s*<\/caption>/);
    const section = captionMatch ? normalizeSpace(stripHtml(captionMatch[1])) : '';

    // Find all PDF links within this block
    const pdfRegex = /<span class="file file--mime-application-pdf[^"]*">\s*<a\s+href="([^"]+)"\s+type="application\/pdf"[^>]*>([\s\S]*?)<\/a>\s*<\/span>/g;
    let match;

    while ((match = pdfRegex.exec(block)) !== null) {
      const pdfPath = match[1];
      const titleHtml = match[2];
      const title = normalizeSpace(stripHtml(titleHtml));

      if (!title || title.length < 3) continue;

      // Build absolute URL for the PDF
      const pdfUrl = pdfPath.startsWith('http')
        ? pdfPath
        : `${BASE_URL}${pdfPath}`;

      listings.push({ title, pdfUrl, section });
    }
  }

  return listings;
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Flury Stiftung jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML
 *   2. Parse all PDF links grouped by section/category
 *   3. Build ParsedJob objects with location + category inference
 */
export async function fetchAllFluryStiftungJobs() {
  console.log(`🔍 Fetching Flury Stiftung jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listingHtml = await fetchListingPage();
  const listings = parseJobListings(listingHtml);

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No PDF job listings found on page.');
    return [];
  }

  console.log(`  📋 PDF listings found: ${listings.length}`);

  const jobs = [];

  for (const listing of listings) {
    const title = listing.title;
    const section = listing.section;
    const pdfUrl = listing.pdfUrl;

    const locationInfo = inferLocation(section, title);
    const location = locationInfo.city;
    const canton = inferAnyCanton(location) || 'GR';
    const postalCode = locationInfo.postalCode;

    const urlHash = createHash('sha1').update(pdfUrl).digest('hex').slice(0, 12);
    const sourceLang = 'de';
    const jobSlug = slugify(`${title} flury-stiftung ch`);

    // Build description from title + section + company + location + company boilerplate.
    // The boilerplate must be rich enough that AI translations into IT/EN/FR stay above 150 chars.
    const descParts = [`${title} — Flury Stiftung`];
    if (section && section !== 'Flury Stiftung') {
      descParts.push(`Bereich: ${section}`);
    }
    descParts.push(`Arbeitsort: ${location} (${canton})`);
    descParts.push('Die Flury Stiftung ist ein regionaler Gesundheitsversorger im Prättigau, Kanton Graubünden, und betreibt das Spital Schiers, zwei Altersheime in Schiers und Jenaz, eine Spitex-Organisation, das Medizinische Zentrum Klosters sowie Kinderkrippen. Wir bieten vielfältige Karrieremöglichkeiten, moderne Arbeitsbedingungen und ein kollegiales Arbeitsumfeld in einer attraktiven Bergregion. Wir suchen engagierte Fachkräfte, die mit Kompetenz und Leidenschaft zur Gesundheitsversorgung in unserer Region beitragen möchten');
    const descriptionText = descParts.join('. ');

    const pensum = extractPensum(title);
    const employmentType = pensum.max < 80 ? 'PART_TIME' : 'FULL_TIME';
    const contract = pensum.max >= 80 ? 'full-time' : 'part-time';

    const job = {
      // ── Required fields ──
      id: `flury-stiftung-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FLURY_STIFTUNG_COMPANY_NAME,
      companyKey: FLURY_STIFTUNG_KEY,
      companyDomain: FLURY_STIFTUNG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: pdfUrl,
      source: 'Flury Stiftung Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(section, title),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Assistenza',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: pdfUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional: section as department
    if (section) {
      job.department = section;
    }

    // Optional: pensum info
    if (pensum.min === pensum.max) {
      job.pensum = `${pensum.min}%`;
    } else {
      job.pensum = `${pensum.min} - ${pensum.max}%`;
    }
    job.pensumMin = pensum.min;
    job.pensumMax = pensum.max;

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${section} — ${location}`);
  }

  console.log(`\n📋 Total Flury Stiftung jobs discovered: ${jobs.length}`);
  return jobs;
}
