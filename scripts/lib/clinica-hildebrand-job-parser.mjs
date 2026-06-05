#!/usr/bin/env node
/**
 * Clinica Hildebrand — Centro di riabilitazione, Brissago (TI).
 *
 * Public career site (Italian only, Weebly/static HTML):
 *   https://www.clinica-hildebrand.ch/collaborazione.html
 *
 * Open positions ("posti vacanti") are listed as PDF attachments hosted under
 * /uploads/.../<filename>.pdf on the same domain. Each PDF is an annuncio with
 * profilo, mansioni and procedura di candidatura.
 *
 * Strategy:
 *   1. Fetch the careers page HTML
 *   2. Regex out every <a href=".../uploads/...*.pdf"> link (skipping privacy /
 *      regolamento attachments)
 *   3. Fetch + extract each PDF text via pdf-job-content.mjs
 *   4. Derive the title from the filename stem (or PDF first line when usable)
 *   5. Build Italian description from PDF text + clinic-level boilerplate
 *
 * Brissago is in the Locarnese (TI) — directly on the frontaliere commuter axis.
 *
 * Inventory note: 1 PDF at probe time. Ship anyway — the parser will pick up new
 * concorsi the moment they are uploaded.
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

export const CLINICA_HILDEBRAND_KEY = 'clinica-hildebrand';
export const CLINICA_HILDEBRAND_COMPANY_NAME =
  'Clinica Hildebrand Centro di riabilitazione';
export const CLINICA_HILDEBRAND_COMPANY_DOMAIN = 'clinica-hildebrand.ch';

const PUBLIC_CAREER_URL = 'https://www.clinica-hildebrand.ch/collaborazione.html';
const DEFAULT_CITY = 'Brissago';
const DEFAULT_CANTON = 'TI';
const DEFAULT_POSTAL = '6614';

/** Minimum plain-text description length to surface a warning. */
export const MIN_HILDEBRAND_DESC_LENGTH = 400;

// Skip non-job PDFs (privacy notices, regolamenti, statuti).
const NON_JOB_PDF_RE = /(informativa|privacy|protezione|regolamento|statuto|formulario|policy)/i;

/* ── Company matchers ──────────────────────────────────────── */

export function isClinicaHildebrandJob(job = {}) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === CLINICA_HILDEBRAND_KEY ||
    key.startsWith('clinica-hildebrand') ||
    company.includes('clinica hildebrand') ||
    company.includes('hildebrand') ||
    url.includes('clinica-hildebrand.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === CLINICA_HILDEBRAND_COMPANY_DOMAIN ||
      host === `www.${CLINICA_HILDEBRAND_COMPANY_DOMAIN}` ||
      host.endsWith(`.${CLINICA_HILDEBRAND_COMPANY_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

/* ── Title derivation from filename ───────────────────────── */

function titleCaseWord(token) {
  if (!token) return token;
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Convert "annuncio_medico_assistente_25.pdf" → "Medico Assistente 25".
 * Drops common leading markers (annuncio, bando, concorso).
 */
export function humanizeHildebrandFilename(filename = '') {
  let stem = String(filename || '')
    .replace(/\.pdf$/i, '')
    .replace(/^(annuncio|bando|concorso|inserzione|posto)[_\s-]*/i, '');
  if (!stem) return '';
  stem = stem.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return stem
    .split(/(\s+)/)
    .map((part) => (/[a-zà-ÿ]/i.test(part) ? titleCaseWord(part.toLowerCase()) : part))
    .join('')
    .trim();
}

/* ── Parser ────────────────────────────────────────────────── */

/**
 * Extract job PDF listings from the Clinica Hildebrand careers page.
 * Returns: [{ id, title, pdfUrl, filename }]
 */
export function parseClinicaHildebrandListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();

  // Match every <a href="...*.pdf" ...> reference. Weebly hosts PDFs under
  // /uploads/<…ids…>/<filename>.pdf relative to root.
  const anchorRe = /href="([^"]+\.pdf)"/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    let href = m[1];
    if (!href) continue;
    if (NON_JOB_PDF_RE.test(href)) continue;

    // Normalise to absolute URL.
    if (href.startsWith('//')) {
      href = `https:${href}`;
    } else if (href.startsWith('/')) {
      href = `https://www.clinica-hildebrand.ch${href}`;
    } else if (!/^https?:\/\//i.test(href)) {
      href = `https://www.clinica-hildebrand.ch/${href.replace(/^\.?\/?/, '')}`;
    }

    if (seen.has(href)) continue;
    seen.add(href);

    const filename = decodeURIComponent(href.split('/').pop() || '');
    const title =
      normalizeSpace(decodeEntities(humanizeHildebrandFilename(filename))) ||
      filename.replace(/\.pdf$/i, '');

    const id = slugify(filename.replace(/\.pdf$/i, '')).slice(0, 50);
    if (!id) continue;

    out.push({ id, title, pdfUrl: href, filename });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

function buildHildebrandDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `${title} presso ${CLINICA_HILDEBRAND_COMPANY_NAME}, Brissago (Locarnese, Canton Ticino).`,
      'La Clinica Hildebrand è un centro di riabilitazione neurologica, ortopedica e cardiovascolare situato sul Lago Maggiore. Eroga prestazioni stazionarie e ambulatoriali per pazienti adulti e collabora con il sistema sanitario ticinese e nazionale.',
    ],
    pdfText,
    fallbackText: `Posto vacante ${title} presso ${CLINICA_HILDEBRAND_COMPANY_NAME}. I dettagli completi su requisiti, mansioni e modalità di candidatura sono disponibili nel documento PDF ufficiale.`,
    footerLines: [
      `Annuncio ufficiale (PDF): ${pdfUrl}`,
      `Pagina collaborazione: ${PUBLIC_CAREER_URL}`,
      'Settore: Sanità / Riabilitazione',
      'Candidature: candidature@clinica-hildebrand.ch (CV completo via e-mail)',
    ],
  });

  const warnings = [];
  if (pdfText && description.length < MIN_HILDEBRAND_DESC_LENGTH) {
    warnings.push(
      `Hildebrand description too short (${description.length} chars < ${MIN_HILDEBRAND_DESC_LENGTH}) for "${title}" — PDF may have changed.`
    );
  }
  return { description, warnings };
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllClinicaHildebrandJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🏥 Fetching ${CLINICA_HILDEBRAND_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (Weebly HTML + PDF concorsi)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch Clinica Hildebrand career page: ${err?.message || err}`);
  }

  const listings = parseClinicaHildebrandListing(html);
  console.log(`  📋 PDF concorsi found: ${listings.length}\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No concorsi parsed from Clinica Hildebrand page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.filename}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl, { timeoutMs });
    if (pdf.error) {
      console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    }
    const pdfText = pdf.thin ? '' : (pdf.rawText || pdf.text || '');

    const { description, warnings } = buildHildebrandDescription({
      title: listing.title,
      pdfText,
      pdfUrl: listing.pdfUrl,
    });
    for (const w of warnings) console.warn(`     ⚠️ ${w}`);

    const sourceLang = 'it';
    const haystack = `${listing.title} ${description}`;
    const employmentType = detectHealthcareEmploymentType(haystack);
    const jobSlug = slugify(`${listing.title} ${CLINICA_HILDEBRAND_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1')
      .update(`${listing.pdfUrl}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);

    jobs.push({
      id: `${CLINICA_HILDEBRAND_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CLINICA_HILDEBRAND_COMPANY_NAME,
      companyKey: CLINICA_HILDEBRAND_KEY,
      companyDomain: CLINICA_HILDEBRAND_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: listing.pdfUrl,
      applyUrl: PUBLIC_CAREER_URL,
      source: 'Clinica Hildebrand Dedicated Parser (HTML + PDF annunci)',
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
      sector: 'Sanità / Riabilitazione',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });

    console.log(`  ✅ ${listing.title.substring(0, 70)} (${listing.id})`);
  }

  // Source-lang consistency check.
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
    `\n📋 Total ${CLINICA_HILDEBRAND_COMPANY_NAME} jobs discovered: ${jobs.length}`
  );
  return jobs;
}
