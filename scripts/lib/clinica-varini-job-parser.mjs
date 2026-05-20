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
 *   2. Match every <a href=".../wp-content/uploads/...*.pdf"> link
 *   3. Keep only filenames matching /concorso/i
 *   4. Derive title from filename stem (date prefix dropped)
 *   5. Pull PDF text + build Italian description
 *
 * Inventory note: 2 concorsi at probe time (concorso_contabile,
 * concorso_dir_sanitario).
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
  const anchorRe = /href="([^"]+\.pdf)"/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    let href = m[1];
    if (!href) continue;
    // Force https + absolute
    if (href.startsWith('http://')) href = href.replace('http://', 'https://');
    if (href.startsWith('//')) href = `https:${href}`;
    else if (href.startsWith('/')) href = `https://clinicavarini.ch${href}`;

    const filename = decodeURIComponent(href.split('/').pop() || '');
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
  return out;
}

/* ── Description builder ───────────────────────────────────── */

function buildVariniDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `${title} presso ${CLINICA_VARINI_COMPANY_NAME}, Orselina (Locarnese, Canton Ticino).`,
      'Clinica Varini è una struttura sanitaria del Locarnese che opera nei settori della medicina specialistica e della dermatologia, con prestazioni stazionarie e ambulatoriali per pazienti adulti.',
    ],
    pdfText,
    fallbackText: `Concorso ${title} presso ${CLINICA_VARINI_COMPANY_NAME}. I dettagli completi su requisiti, profilo professionale, modalità di candidatura e termine di presentazione sono disponibili nel documento PDF allegato.`,
    footerLines: [
      `Bando ufficiale (PDF): ${pdfUrl}`,
      `Pagina notizie: ${PUBLIC_CAREER_URL}`,
      'Settore: Sanità / Clinica privata',
    ],
  });
  const warnings = [];
  if (pdfText && description.length < MIN_VARINI_DESC_LENGTH) {
    warnings.push(
      `Varini description too short (${description.length} chars < ${MIN_VARINI_DESC_LENGTH}) for "${title}" — PDF may have changed.`
    );
  }
  return { description, warnings };
}

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
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.filename}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl, { timeoutMs });
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.rawText || pdf.text || '';

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
