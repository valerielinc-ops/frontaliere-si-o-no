#!/usr/bin/env node
/**
 * Reha Andeer — small private rehabilitation clinic in Andeer (GR).
 *
 * Public career page (WordPress, German only):
 *   https://reha-andeer.ch/offene-stellen/
 *
 * Open positions ("offene Stellen") are listed as PDF Stelleninserate hosted under
 * /wp-content/uploads/<YYYY>/<MM>/<filename>.pdf. Email applications.
 *
 * Strategy:
 *   1. Fetch /offene-stellen/
 *   2. Match every <a href=".../wp-content/uploads/...*.pdf"> link
 *   3. Filter out non-job PDFs (datenschutz, agb, etc.)
 *   4. Derive title from filename, extract body from PDF
 *
 * Inventory note: 2 PDF Stelleninserate at probe time (Pflegehelferin, med.
 * Masseurin). Ship anyway.
 */
import { createHash } from 'node:crypto';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const REHA_ANDEER_KEY = 'reha-andeer';
export const REHA_ANDEER_COMPANY_NAME = 'Reha Andeer';
export const REHA_ANDEER_COMPANY_DOMAIN = 'reha-andeer.ch';

const PUBLIC_CAREER_URL = 'https://reha-andeer.ch/offene-stellen/';
const DEFAULT_CITY = 'Andeer';
const DEFAULT_CANTON = 'GR';
const DEFAULT_POSTAL = '7440';

export const MIN_REHA_ANDEER_DESC_LENGTH = 350;

const NON_JOB_PDF_RE =
  /(datenschutz|impressum|agb|preisliste|tarif|tarmed|broschure|brochure|leitbild|qualitaet|qualität|formular|policy)/i;
// Accept any uploads PDF unless filtered above. Most are Stelleninserate by
// keyword but some carry the role name directly (e.g. "Pflegehelferin").
const ACCEPT_HINTS_RE = /(stelle|stelleninserat|inserat|bewerb|pflege|masseur|therap|köch|service|kuche|reinigung|nacht|sekret|leit)/i;

/* ── Company matchers ──────────────────────────────────────── */

export function isRehaAndeerJob(job = {}) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === REHA_ANDEER_KEY ||
    key.startsWith('reha-andeer') ||
    company.includes('reha andeer') ||
    url.includes('reha-andeer.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === REHA_ANDEER_COMPANY_DOMAIN ||
      host === `www.${REHA_ANDEER_COMPANY_DOMAIN}` ||
      host.endsWith(`.${REHA_ANDEER_COMPANY_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

/* ── Title derivation ─────────────────────────────────────── */

function titleCaseWord(token) {
  if (!token) return token;
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Convert "2026_Stelleninserat-med.-Masseurin.pdf" → "Med. Masseurin".
 * Strips year prefix and "Stelleninserat" marker.
 */
export function humanizeRehaAndeerFilename(filename = '') {
  let stem = String(filename || '').replace(/\.pdf$/i, '');
  // Drop YYYY prefix or suffix
  stem = stem.replace(/^(\d{4})[_\s-]+/, '').replace(/[_\s-]+(\d{4})$/, '');
  // Drop Stelleninserat marker
  stem = stem.replace(/[_\s-]*Stelleninserat[_\s-]*/i, ' ');
  stem = stem.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!stem) return 'Offene Stelle';
  return stem
    .split(/(\s+|\.\s*|-)/)
    .map((part) => (/[a-zäöüß]/i.test(part) ? titleCaseWord(part.toLowerCase()) : part))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ── Parser ────────────────────────────────────────────────── */

export function parseRehaAndeerListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();
  const anchorRe = /href="([^"]+\.pdf)"/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    let href = m[1];
    if (!href) continue;
    if (href.startsWith('//')) href = `https:${href}`;
    else if (href.startsWith('/')) href = `https://reha-andeer.ch${href}`;

    if (NON_JOB_PDF_RE.test(href)) continue;
    // Require either /uploads/ in path OR a job hint in filename.
    const filename = decodeURIComponent(href.split('/').pop() || '');
    const isUploadsPath = /\/wp-content\/uploads\//i.test(href);
    if (!isUploadsPath && !ACCEPT_HINTS_RE.test(filename)) continue;
    // Extra filter: skip obviously-non-job uploads (e.g. Hausordnung).
    if (NON_JOB_PDF_RE.test(filename)) continue;

    if (seen.has(href)) continue;
    seen.add(href);

    const title =
      normalizeSpace(decodeEntities(humanizeRehaAndeerFilename(filename))) ||
      filename.replace(/\.pdf$/i, '');
    const id = slugify(filename.replace(/\.pdf$/i, '')).slice(0, 50);
    if (!id) continue;
    out.push({ id, title, pdfUrl: href, filename });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

function buildRehaAndeerDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `${REHA_ANDEER_COMPANY_NAME} sucht eine engagierte Persönlichkeit für die Position: ${title}.`,
      'Reha Andeer ist eine private Rehabilitationsklinik in Andeer (Kanton Graubünden) und bietet stationäre und ambulante Behandlungen in einem familiären Umfeld inmitten der Schamser Bergwelt an.',
    ],
    pdfText,
    fallbackText: `Stelleninserat ${title} bei ${REHA_ANDEER_COMPANY_NAME}. Die vollständigen Angaben zu Aufgaben, Anforderungen und Bewerbungsweg entnehmen Sie dem offiziellen PDF.`,
    footerLines: [
      `Stelleninserat (PDF): ${pdfUrl}`,
      `Karriere-Seite: ${PUBLIC_CAREER_URL}`,
      'Sektor: Gesundheitswesen / Rehabilitation',
      'Bewerbung: per E-Mail gemäss den Hinweisen im Stelleninserat',
    ],
  });
  const warnings = [];
  if (pdfText && description.length < MIN_REHA_ANDEER_DESC_LENGTH) {
    warnings.push(
      `Reha Andeer description too short (${description.length} chars < ${MIN_REHA_ANDEER_DESC_LENGTH}) for "${title}" — PDF may have changed.`
    );
  }
  return { description, warnings };
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllRehaAndeerJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏥 Fetching ${REHA_ANDEER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (WordPress HTML + PDF Stelleninserate)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch Reha Andeer page: ${err?.message || err}`);
  }

  const listings = parseRehaAndeerListing(html);
  console.log(`  📋 Stelleninserat PDFs found: ${listings.length}\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No Stelleninserate parsed from Reha Andeer page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.filename}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl, { timeoutMs });
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.thin ? '' : (pdf.rawText || pdf.text || '');

    const { description, warnings } = buildRehaAndeerDescription({
      title: listing.title,
      pdfText,
      pdfUrl: listing.pdfUrl,
    });
    for (const w of warnings) console.warn(`     ⚠️ ${w}`);

    const sourceLang = 'de';
    const haystack = `${listing.title} ${description}`;
    const employmentType = detectHealthcareEmploymentType(haystack);
    const jobSlug = slugify(`${listing.title} ${REHA_ANDEER_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1')
      .update(`${listing.pdfUrl}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);

    jobs.push({
      id: `${REHA_ANDEER_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: REHA_ANDEER_COMPANY_NAME,
      companyKey: REHA_ANDEER_KEY,
      companyDomain: REHA_ANDEER_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: listing.pdfUrl,
      applyUrl: PUBLIC_CAREER_URL,
      source: 'Reha Andeer Dedicated Parser (WordPress HTML + PDF)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL,
      category: detectHealthcareCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Gesundheitswesen / Rehabilitation',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
    console.log(`  ✅ ${listing.title.substring(0, 70)} (${listing.id})`);
  }

  for (const j of jobs) {
    const detected = detectLang(j.description || j.title, 'de');
    if (detected !== j.sourceLang) {
      j.sourceLang = detected;
      j.titleByLocale = { [detected]: j.title };
      j.descriptionByLocale = { [detected]: j.description };
      j.slugByLocale = { [detected]: j.slug };
      j.requirementsByLocale = { [detected]: [] };
    }
  }

  console.log(
    `\n📋 Total ${REHA_ANDEER_COMPANY_NAME} jobs discovered: ${jobs.length}`
  );
  return jobs;
}
