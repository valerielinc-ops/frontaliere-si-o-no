#!/usr/bin/env node
import { sourcePostingDateFields, mergeSourcePostingDates } from './source-posting-date.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
/**
 * Psychiatrische Dienste Graubünden (PDGR) job parser — Fetcher and job builder.
 *
 * Source: https://www.pdgr.ch/jobs-uebersicht/offene-stellen/
 *
 * PDGR is a WordPress site with server-side rendered job listings.
 * The listing page contains all ~61 jobs as HTML cards with structured
 * data-filter attributes. Detail pages provide full descriptions via
 * ACF custom fields and Yoast JSON-LD.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllPdgrJobs()  — Fetch and parse all jobs
 *   - isPdgrJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PDGR_KEY = 'pdgr';
export const PDGR_COMPANY_NAME = 'Psychiatrische Dienste Graubünden';
export const PDGR_COMPANY_DOMAIN = 'pdgr.ch';

const CAREER_URL = 'https://www.pdgr.ch/jobs-uebersicht/offene-stellen/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML to plain text while preserving <li> bullets and basic line structure.
 * - <li> → "\n- "
 * - <br>, </p>, </div>, </ul>, </ol> → "\n"
 * - Other tags stripped; basic HTML entities decoded.
 */
export function htmlToStructuredText(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Psychiatrische Dienste Graubünden.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isPdgrJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === PDGR_KEY ||
    key.startsWith('pdgr') ||
    company.includes('psychiatrische dienste graubünden') ||
    url.includes('pdgr.ch')
  );
}

/**
 * Validate that a URL belongs to PDGR's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'pdgr.ch' || host.endsWith('.pdgr.ch');
  } catch {
    return false;
  }
}

/* ── Postal Code / Location Lookup ─────────────────────────── */

/**
 * PDGR operates across multiple Graubünden locations.
 */
const PDGR_POSTAL_CODES = {
  chur: '7000',
  cazis: '7408',
  davos: '7270',
  thusis: '7430',
  landquart: '7302',
  scuol: '7550',
  ilanz: '7130',
  poschiavo: '7742',
  samedan: '7503',
  'st. moritz': '7500',
};

function inferPostalCode(location = '') {
  const loc = normalize(location);
  for (const [city, code] of Object.entries(PDGR_POSTAL_CODES)) {
    if (loc.includes(city)) return code;
  }
  return '7000'; // Chur default (PDGR HQ)
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect job category from CSS classes and title.
 * The listing page uses CSS classes like "psychologie", "pflege-betreuung-fachtherapien",
 * "medizin", "verwaltung-informatik", etc.
 */
function detectCategoryFromClasses(cssClasses = '', title = '') {
  const cls = normalize(cssClasses);
  const t = normalize(title);

  if (cls.includes('psychologie') || /\bpsycholog/.test(t)) return 'Psicologia';
  if (cls.includes('medizin') || /\b(arzt|ärztin|ober[aä]rzt|medizin|psychiater)/.test(t)) return 'Medicina';
  if (cls.includes('pflege') || /\b(pflege|fachperson gesundheit|fage|betreu)/.test(t)) return 'Infermieristica';
  if (cls.includes('sozialpaedagogik') || /\b(sozialpädagog|sozialarbeit|agog)/.test(t)) return 'Sociale';
  if (cls.includes('schule') || /\b(lehrer|lehrperson|lernend|schul)/.test(t)) return 'Formazione';
  if (cls.includes('hotellerie') || /\b(hotellerie|küche|raumpflege|gastro|koch)/.test(t)) return 'Ristorazione';
  if (cls.includes('verwaltung') || /\b(admin|verwaltung|controlling|buchhalt|sekretär)/.test(t)) return 'Amministrazione';
  if (cls.includes('informatik') || /\b(it|software|informatik|develop)/.test(t)) return 'IT';
  if (/\b(techni|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|oberarzt|oberärztin|leitend)/.test(t)) return 'senior';
  return 'mid';
}

/* ── HTML Parsing — Listing Page ──────────────────────────── */

/**
 * Fetch the listing page HTML.
 */
async function fetchListingPage() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  return fetchHtml(CAREER_URL, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'de-CH,de;q=0.9',
    },
  });
}

/**
 * Parse job cards from the listing page HTML.
 *
 * Each card structure:
 *   <div class="... jobs-post grid-item {categories} {location} employment_{from}_{to}"
 *        data-efrom="80" data-eto="100">
 *     <div class="jobs-post-content">
 *       <a href="https://www.pdgr.ch/jobs/{slug}/">
 *         <p class="mb-0 job-title"><b>Title</b></p>
 *         <p class="mb-0"><span>Department/Specialty</span></p>
 *         <p class="mb-0 jobs-area-txt">
 *           <span>Facility</span> | <span>Arbeitsort: Location</span> | <span class="jobs-employment">Pensum: 80 - 100%</span>
 *         </p>
 *       </a>
 *     </div>
 *   </div>
 */
export function parseJobCards(html = '') {
  const cards = [];
  let skippedNonJobCards = 0;

  // Match each job card div with its data attributes and inner content
  const cardRegex = /<div\s+class="[^"]*jobs-post\s+grid-item\s+([^"]*)"[^>]*data-efrom="(\d+)"[^>]*data-eto="(\d+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const cssClasses = match[1];
    const pensumFrom = parseInt(match[2], 10);
    const pensumTo = parseInt(match[3], 10);
    const content = match[4];

    // Extract detail link
    const linkMatch = content.match(/<a\s+href="([^"]+)"/);
    const detailUrl = linkMatch ? linkMatch[1] : '';

    // Skip non-job cards (info/CTA cards point to /jobs-uebersicht/ or anchor-only URLs).
    // Real job detail pages have shape: https://www.pdgr.ch/jobs/{slug}/
    if (!detailUrl || !/^https:\/\/www\.pdgr\.ch\/jobs\/[^#?\/]+\/?$/.test(detailUrl)) {
      skippedNonJobCards++;
      continue;
    }

    // Extract title from <p class="mb-0 job-title"><b>...</b></p>
    const titleMatch = content.match(/<p[^>]*class="[^"]*job-title[^"]*"[^>]*><b>([\s\S]*?)<\/b><\/p>/);
    const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

    // Extract department/specialty (second <p> with <span> but NOT jobs-area-txt)
    const deptMatch = content.match(/<p\s+class="mb-0"><span>([\s\S]*?)<\/span><\/p>/);
    const department = deptMatch ? normalizeSpace(stripHtml(deptMatch[1])) : '';

    // Extract location from "Arbeitsort: ..." text
    const locationMatch = content.match(/Arbeitsort:\s*([\s\S]*?)(?:<\/span>)/);
    const location = locationMatch ? normalizeSpace(stripHtml(locationMatch[1])) : '';

    // Extract facility name (first span inside jobs-area-txt)
    const facilityMatch = content.match(/<p[^>]*class="[^"]*jobs-area-txt[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/);
    const facility = facilityMatch ? normalizeSpace(stripHtml(facilityMatch[1])) : '';

    if (!title || title.length < 3) continue;

    cards.push({
      title,
      detailUrl,
      cssClasses,
      department,
      location: location || 'Chur',
      facility,
      pensumFrom,
      pensumTo,
    });
  }

  if (skippedNonJobCards > 0) console.log(`  ⚠ Skipped ${skippedNonJobCards} non-job cards (info/CTA links)`);

  return cards;
}

/* ── HTML Parsing — Detail Page ───────────────────────────── */

/**
 * Fetch a job detail page and extract the full description.
 * Returns { description, datePosted, employmentType, specialty, jobCategory }.
 */
async function fetchDetailPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  return fetchHtml(url, {
    timeoutMs,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'de-CH,de;q=0.9',
    },
  });
}

/**
 * Extract structured content from a job detail page HTML.
 *
 * ACF fields on the page:
 *   #acf_jobs_environment  — "Ihre Umgebung"
 *   #acf_jobs_duties       — "Ihre Aufgaben"
 *   #acf_jobs_requirements — "Unser Anforderungsprofil"
 *   #acf_jobs_benefits     — "Wir bieten Ihnen"
 *
 * Also extracts data from Yoast JSON-LD when available.
 */
export function parseDetailPage(html = '') {
  const result = {
    description: '',
    datePosted: '',
    employmentType: '',
    specialty: '',
    jobCategory: '',
  };

  // Extract ACF fields
  const sections = [];

  const acfFields = [
    { id: 'acf_jobs_environment', heading: 'Ihre Umgebung' },
    { id: 'acf_jobs_duties', heading: 'Ihre Aufgaben' },
    { id: 'acf_jobs_requirements', heading: 'Unser Anforderungsprofil' },
    { id: 'acf_jobs_benefits', heading: 'Wir bieten Ihnen' },
  ];

  for (const field of acfFields) {
    const regex = new RegExp(`<span\\s+id="${field.id}"[^>]*>([\\s\\S]*?)</span>`, 'i');
    const m = html.match(regex);
    if (m) {
      const text = htmlToStructuredText(m[1]);
      if (text.length > 10) {
        sections.push(`${field.heading}:\n${text}`);
      }
    }
  }

  result.description = sections.join('\n\n') || parsePdgrPageElements(html);

  // Extract employmentType from hidden div
  const empMatch = html.match(/<div[^>]*id="acf_jobs_employment"[^>]*>([\s\S]*?)<\/div>/i);
  if (empMatch) {
    result.employmentType = normalizeSpace(stripHtml(empMatch[1]));
  }

  // Extract specialty and category from post-content data attributes
  const fachgebieteMatch = html.match(/data-fachgebiete="([^"]*)"/);
  if (fachgebieteMatch) {
    result.specialty = fachgebieteMatch[1];
  }

  const jobCatMatch = html.match(/data-job-categories="([^"]*)"/);
  if (jobCatMatch) {
    result.jobCategory = jobCatMatch[1];
  }

  return { ...result, ...sourcePostingDateFields(extractJobPostingLd(html)?.datePosted) };
}

/**
 * Text of a PDGR posting built from page elements instead of the ACF job
 * fields: the apprenticeship pages ("Lehrstelle") have no ACF fields and put
 * the posting in a sequence of `left-space` blocks — text blocks, section
 * titles and accordions ("Eckpunkte deiner Ausbildung", "Deine Vorteile auf
 * einen Blick"). Their text is read in page order, lists kept, up to the
 * contact persons and the application form; the contact block itself is left
 * out.
 *
 * @param {string} html
 * @returns {string}
 */
export function parsePdgrPageElements(html = '') {
  const source = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const starts = [];
  const blockRe = /<div class="left-space ([^"]*)">/g;
  let m;
  while ((m = blockRe.exec(source))) starts.push({ index: m.index, type: m[1] });
  // Link-only lines ("→ Entdecke unsere Werte") are page navigation.
  const toText = (fragment) => htmlToStructuredText(
    String(fragment || '').replace(/<\/?h[1-6][^>]*>/gi, '\n'),
  ).split('\n').filter((line) => !/^\s*→/.test(line)).join('\n').trim();
  const parts = [];
  for (let i = 0; i < starts.length; i += 1) {
    const { type } = starts[i];
    const segment = source.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : source.length);
    if (/directory-spacer|jobform/.test(type)) break;
    if (/titleblock-spacer/.test(type)) {
      const heading = normalizeSpace(stripHtml(segment));
      if (/Kontaktperson|Deine Bewerbung/i.test(heading)) break;
      if (heading) parts.push(heading);
    } else if (/textblock-spacer/.test(type)) {
      if (/data-customname-content="[^"]*Kontakt/i.test(segment)) continue;
      const text = toText(segment);
      if (text) parts.push(text);
    } else if (/acccordion-spacer/.test(type)) {
      const cardRe = /<span class="accordion-title">([\s\S]*?)<\/span>[\s\S]*?<div class="card-body[^"]*">([\s\S]*?)(?=<div class="card"|$)/g;
      let card;
      while ((card = cardRe.exec(segment))) {
        const title = normalizeSpace(stripHtml(card[1]));
        const body = toText(card[2].replace(/<span class="close-accordion[\s\S]*?<\/span>/gi, ''));
        const item = [title, body].filter(Boolean).join('\n');
        if (item) parts.push(item);
      }
    }
  }
  return parts.join('\n\n').trim();
}

/** Fragment only the crawler's former substitute description wrote. */
export const PDGR_FABRICATED_DESCRIPTION_RE =
  /Die Psychiatrischen Dienste Graubünden \(PDGR\) sind der führende Anbieter/;

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all PDGR jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch listing page HTML and parse all job cards
 *   2. For each card, fetch detail page for full description
 *   3. Build ParsedJob objects with all available metadata
 */
export async function fetchAllPdgrJobs() {
  console.log(`🔍 Fetching Psychiatrische Dienste Graubünden jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listingHtml = await fetchListingPage();
  const cards = parseJobCards(listingHtml);

  if (!cards || cards.length === 0) {
    console.warn('⚠️ No job cards found on listing page.');
    return [];
  }

  console.log(`  📋 Job cards found: ${cards.length}`);

  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const card of cards) {
    const title = card.title;
    if (!title || title.length < 3) continue;

    // Fetch detail page for full description
    let detail = { description: '', datePosted: '', employmentType: '', specialty: '', jobCategory: '' };
    if (card.detailUrl) {
      try {
        const detailHtml = await fetchDetailPage(card.detailUrl);
        detail = parseDetailPage(detailHtml);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
      }
    }

    const location = card.location || 'Chur';
    const canton = inferAnyCanton(location) || 'GR';
    const publicUrl = card.detailUrl || CAREER_URL;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} pdgr ch`);

    // The description is the posting's own text on its detail page. Below
    // 200 characters the crawler used to substitute a description of its own
    // ("<Titel> — Psychiatrische Dienste Graubünden (PDGR). Bereich: …
    // Arbeitsort: … Die Psychiatrischen Dienste Graubünden (PDGR) sind der
    // führende Anbieter…"); a detail without text now gives no description and
    // the job takes the pipeline's thin-source path.
    const descriptionText = detail.description;

    // Determine employment type
    let employmentType = detail.employmentType;
    if (!employmentType || employmentType === 'OTHER') {
      employmentType = card.pensumTo < 80 ? 'PART_TIME' : 'FULL_TIME';
    }

    const sourceLang = detectLang(descriptionText || title, 'de');

    const job = {
      // ── Required fields ──
      id: `pdgr-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PDGR_COMPANY_NAME,
      companyKey: PDGR_KEY,
      companyDomain: PDGR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Psychiatrische Dienste Graubünden Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: inferPostalCode(location),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategoryFromClasses(card.cssClasses, title),
      contract: card.pensumTo >= 80 ? 'full-time' : 'part-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Psichiatria',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, detail),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment from detail page
    if (card.department) {
      job.department = card.department;
    }
    if (card.facility) {
      job.facility = card.facility;
    }
    if (card.pensumFrom !== undefined) {
      job.pensumMin = card.pensumFrom;
      job.pensumMax = card.pensumTo;
      if (card.pensumFrom === card.pensumTo) {
        job.pensum = `${card.pensumFrom}%`;
      } else {
        job.pensum = `${card.pensumFrom} - ${card.pensumTo}%`;
      }
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} — ${location} (${card.pensumFrom}-${card.pensumTo}%)`);
  }

  console.log(`\n📋 Total PDGR jobs discovered: ${jobs.length}`);
  return jobs;
}
