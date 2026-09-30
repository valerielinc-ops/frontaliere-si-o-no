#!/usr/bin/env node
/**
 * Clinica Varini, Orselina (TI).
 *
 * Public news/announcements page (WordPress):
 *   https://clinicavarini.ch/notizie/
 *
 * Open positions ("concorsi") are published as PDF attachments under
 * /wp-content/uploads/ alongside press releases ("comunicato_stampa"). Only the
 * concorso PDFs are jobs — comunicati are filtered out.
 *
 * Orselina is in the Locarnese (TI). Clinica Varini is a private clinic for
 * dermatologia/medicina estetica/chirurgia plastica (Fondazione Varini).
 *
 * Strategy:
 *   1. Fetch /notizie/ HTML
 *   2. Match every quoted PDF anchor, including single-quoted/attribute-order variants
 *   3. Keep only filenames matching /concorso/i
 *   4. Derive title from filename stem (date prefix dropped)
 *   5. Pull PDF text + build Italian description
 *
 * When the page exposes only the known press-release PDF families and no
 * concorso PDF, the zero is source-proven. A bare zero remains unproven so a
 * changed page or a partial response cannot retire the previous slice.
 *
 * Inventory note: 2 concorsi at probe time (concorso_contabile,
 * concorso_dir_sanitario).
 */
import { createHash } from 'node:crypto';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  extractPdfLinks,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CLINICA_VARINI_KEY = 'clinica-varini';
export const CLINICA_VARINI_COMPANY_NAME = 'Clinica Varini';
export const CLINICA_VARINI_COMPANY_DOMAIN = 'clinicavarini.ch';

const PUBLIC_CAREER_URL = 'https://clinicavarini.ch/notizie/';
const DEFAULT_CITY = 'Orselina';
const DEFAULT_CANTON = 'TI';
const DEFAULT_POSTAL = '6644';

export const MIN_VARINI_DESC_LENGTH = 400;

const JOB_PDF_RE = /concorso|bando|posto|annuncio/i;
const NON_JOB_PDF_RE =
  /(comunicato|stampa|press|informativa|privacy|policy|testi\/|attestato|presidente|vernissage)/i;
const KNOWN_NON_JOB_FILENAME_RE =
  /(?:^|[^a-z0-9])(?:comunicat(?:o|i)(?:[_\s-]+stampa)?|press(?:[_\s-]+release)?|informativa|privacy|policy|testi|attestato|presidente|vernissage)(?=$|[^a-z0-9])/i;
const VARINI_UPLOADS_PATH_PREFIX = '/wp-content/uploads/';

function decodeFilename(raw = '') {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function collectPdfLinks(html = '') {
  const links = [];
  const seen = new Set();
  for (const { href: resolvedHref, filename } of extractPdfLinks(html, PUBLIC_CAREER_URL)) {
    let href = resolvedHref;
    if (href.startsWith('http://')) href = href.replace('http://', 'https://');
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    if (!isTrustedDomain(href) || !parsed.pathname.startsWith(VARINI_UPLOADS_PATH_PREFIX)) {
      continue;
    }

    if (seen.has(href)) continue;
    seen.add(href);

    if (!/\.pdf$/i.test(filename)) continue;
    links.push({ href, filename });
  }
  return links;
}

function isKnownNonJobPdf({ filename = '' } = {}) {
  const decodedFilename = decodeFilename(filename);
  // Authoritative evidence must come from an explicit institutional-document
  // family in the basename. A job token wins over a coincidental non-job word
  // (for example, "concorso_addetto_stampa.pdf"). Do not inspect the href:
  // directory names and query strings are not evidence about the document.
  return !JOB_PDF_RE.test(decodedFilename) && KNOWN_NON_JOB_FILENAME_RE.test(decodedFilename);
}

/* ── Company matchers ──────────────────────────────────────── */

export function isClinicaVariniJob(job = {}) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === CLINICA_VARINI_KEY ||
    key.startsWith('clinica-varini') ||
    company.includes('clinica varini') ||
    company === 'varini' ||
    url.includes('clinicavarini.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === CLINICA_VARINI_COMPANY_DOMAIN ||
      host === `www.${CLINICA_VARINI_COMPANY_DOMAIN}` ||
      host.endsWith(`.${CLINICA_VARINI_COMPANY_DOMAIN}`)
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

const ROLE_EXPANSIONS = new Map([
  ['dir', 'Direttore/Direttrice'],
  ['sanitario', 'Sanitario'],
  ['sanitaria', 'Sanitaria'],
  ['contabile', 'Contabile'],
  ['infermiere', 'Infermiere/a'],
  ['operatore', 'Operatore/Operatrice'],
  ['medico', 'Medico'],
  ['assistente', 'Assistente'],
  ['amministrativo', 'Amministrativo/a'],
]);

/**
 * Convert "20260508_concorso_contabile" → "Concorso: Contabile".
 * Drops the YYYYMMDD prefix and expands a few common abbreviations.
 */
export function humanizeVariniFilename(filename = '') {
  let stem = String(filename || '').replace(/\.pdf$/i, '');
  // Strip YYYYMMDD or YYYY-MM-DD prefixes
  stem = stem.replace(/^(\d{8}|\d{4}[-_]\d{2}[-_]\d{2})[_\s-]*/, '');
  // Strip leading "concorso_" marker so we can rebuild "Concorso: ..."
  const hasConcorsoMarker = /^concorso[_\s-]+/i.test(stem);
  stem = stem.replace(/^(concorso|bando|posto|annuncio)[_\s-]+/i, '');
  if (!stem) return 'Concorso';

  const parts = stem.split(/[_\s-]+/).map((p) => {
    const lower = p.toLowerCase();
    if (ROLE_EXPANSIONS.has(lower)) return ROLE_EXPANSIONS.get(lower);
    return titleCaseWord(lower);
  });
  const tail = parts.filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
  return hasConcorsoMarker ? `Concorso: ${tail}` : tail;
}

/* ── Parser ────────────────────────────────────────────────── */

export function parseClinicaVariniListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();
  for (const { href: resolvedHref, filename } of extractPdfLinks(html, PUBLIC_CAREER_URL)) {
    if (!isTrustedDomain(resolvedHref)) continue;
    let href = resolvedHref;
    // Force https + absolute
    if (href.startsWith('http://')) href = href.replace('http://', 'https://');

    if (!JOB_PDF_RE.test(filename)) continue;
    if (NON_JOB_PDF_RE.test(filename) || NON_JOB_PDF_RE.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    const title =
      normalizeSpace(decodeEntities(humanizeVariniFilename(filename))) ||
      filename.replace(/\.pdf$/i, '');
    const id = slugify(filename.replace(/\.pdf$/i, '')).slice(0, 50);
    if (!id) continue;
    out.push({ id, title, pdfUrl: href, filename });
  }

  const pdfLinks = collectPdfLinks(html);
  // The page is a complete, healthy news surface when it exposes PDF
  // attachments and every attachment is one of the known press-release /
  // institutional-document families. That is positive evidence that the
  // zero means "no open competition", not that the page or selector failed.
  // Any unknown PDF deliberately keeps the zero unproven: it may be a newly
  // named vacancy and must not be silently filtered out.
  if (
    out.length === 0
    && pdfLinks.length > 0
    && pdfLinks.every(isKnownNonJobPdf)
  ) {
    return markAuthoritativeEmptySnapshot(
      out,
      CLINICA_VARINI_COMPANY_NAME + ' /notizie/ exposed ' + pdfLinks.length
        + ' PDF attachment(s); all matched known press-release/institutional-document names and none was a concorso.',
    );
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

/**
 * The description of one posting is the text of its PDF and nothing else. The
 * crawler used to wrap it in lines of its own about the clinic ("<titolo>
 * presso Clinica Varini, Orselina…", a paragraph on the clinic), "Bando
 * ufficiale (PDF): …", "Pagina notizie: …", "Settore: …", and to substitute a
 * sentence of its own when the PDF had no text. A PDF without readable text
 * now gives no description and the job takes the pipeline's thin-source path.
 */
export function buildVariniDescription({ title, pdfText = '' }) {
  const description = buildPdfBackedDescription({ pdfText });
  const warnings = [];
  if (pdfText && description.length < MIN_VARINI_DESC_LENGTH) {
    warnings.push(
      `Varini description too short (${description.length} chars < ${MIN_VARINI_DESC_LENGTH}) for "${title}" — PDF may have changed.`
    );
  }
  return { description, warnings };
}

/** Fragments only the crawler's former intro, fallback and footer wrote (see `buildVariniDescription`). */
export const CLINICA_VARINI_FABRICATED_DESCRIPTION_RE =
  /Clinica Varini è una struttura sanitaria del Locarnese|sono disponibili nel documento PDF allegato\.|(?:^|\n)Pagina notizie: https?:|(?:^|\n)Bando ufficiale \(PDF\): https?:/;

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllClinicaVariniJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏥 Fetching ${CLINICA_VARINI_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (WordPress notizie + PDF concorsi)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch Clinica Varini page: ${err?.message || err}`);
  }

  const listings = parseClinicaVariniListing(html);
  console.log(`  📋 Job PDF concorsi found: ${listings.length}\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No concorsi parsed from Clinica Varini page.');
    const evidence = Reflect.get(listings, 'authoritativeEmptyEvidence');
    if (evidence) console.log('  🧩 Source-proven zero: ' + evidence);
    return listings;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.filename}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl, { timeoutMs });
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.thin ? '' : (pdf.rawText || pdf.text || '');

    const { description, warnings } = buildVariniDescription({
      title: listing.title,
      pdfText,
      pdfUrl: listing.pdfUrl,
    });
    for (const w of warnings) console.warn(`     ⚠️ ${w}`);

    const sourceLang = 'it';
    const haystack = `${listing.title} ${description}`;
    const employmentType = detectHealthcareEmploymentType(haystack);
    const jobSlug = slugify(`${listing.title} ${CLINICA_VARINI_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1')
      .update(`${listing.pdfUrl}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);

    jobs.push({
      id: `${CLINICA_VARINI_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CLINICA_VARINI_COMPANY_NAME,
      companyKey: CLINICA_VARINI_KEY,
      companyDomain: CLINICA_VARINI_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: listing.pdfUrl,
      applyUrl: PUBLIC_CAREER_URL,
      source: 'Clinica Varini Dedicated Parser (WordPress HTML + PDF)',
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
      sector: 'Sanità / Clinica privata',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${listing.title.substring(0, 70)} (${listing.id})`);
  }

  for (const j of jobs) {
    const detected = detectLang(j.description || j.title, 'it');
    if (detected !== j.sourceLang) {
      j.sourceLang = detected;
      j.titleByLocale = { [detected]: j.title };
      j.descriptionByLocale = { [detected]: j.description };
      j.slugByLocale = { [detected]: j.slug };
      j.requirementsByLocale = { [detected]: [] };
    }
  }

  console.log(
    `\n📋 Total ${CLINICA_VARINI_COMPANY_NAME} jobs discovered: ${jobs.length}`
  );
  return jobs;
}
