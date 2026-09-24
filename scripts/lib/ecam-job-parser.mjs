#!/usr/bin/env node
/**
 * Ente Case Anziani Mendrisiotto (ECAM) job parser.
 *
 * ECAM publishes its vacancies as official PDF notices on the public career
 * page. The parser deliberately stays inside that boundary: it discovers
 * only branded ECAM PDFs, excludes the health questionnaire, extracts the PDF
 * text and uses the PDF URL as the stable vacancy identity.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { fetchHtml, slugify } from './crawler-template.mjs';

export const ECAM_KEY = 'ecam';
export const ECAM_COMPANY_NAME = 'Ente Case Anziani Mendrisiotto (ECAM)';
export const ECAM_COMPANY_DOMAIN = 'ecam.swiss';
export const ECAM_CAREER_URL =
  'https://www.ecam.swiss/lavora-con-noi/opportunita-dimpiego/';
export const ECAM_CITY = 'Mendrisio';
export const ECAM_CANTON = 'TI';
export const ECAM_POSTAL_CODE = '6850';

const MAX_PDF_LISTINGS = 20;
const JOB_PDF_HINT_RE = /concorso|assunzion|offert|posizion|lavor|personale|stage|apprend/i;
const NON_JOB_PDF_RE = /questionario|stato[-_ ]di[-_ ]salute|modru|privacy|informativ/i;
const ITALIAN_MONTHS = {
  gennaio: '01',
  febbraio: '02',
  marzo: '03',
  aprile: '04',
  maggio: '05',
  giugno: '06',
  luglio: '07',
  agosto: '08',
  settembre: '09',
  ottobre: '10',
  novembre: '11',
  dicembre: '12',
};

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePdfText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .join('\n');
}

function assertEcamUrl(rawUrl, { allowPdf = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`ECAM: invalid source URL (${rawUrl})`);
  }

  const host = url.hostname.toLowerCase();
  const validHost = host === ECAM_COMPANY_DOMAIN || host.endsWith(`.${ECAM_COMPANY_DOMAIN}`);
  const validPath = allowPdf
    ? url.pathname.startsWith('/wp-content/uploads/')
    : url.pathname === new URL(ECAM_CAREER_URL).pathname;
  if (
    url.protocol !== 'https:'
    || !validHost
    || !validPath
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(`ECAM: source URL escaped the approved boundary (${url.href})`);
  }
  return url;
}

async function fetchEcamPage(
  url,
  { fetchPage = fetchHtml, timeoutMs = 20_000 } = {},
) {
  const expected = assertEcamUrl(url);
  return fetchPage(expected.href, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml' },
    validateRedirectUrl: (redirectUrl) => assertEcamUrl(redirectUrl),
  });
}

function isJobPdf(filename, anchorText) {
  const identity = `${filename} ${anchorText}`;
  return !NON_JOB_PDF_RE.test(identity) && JOB_PDF_HINT_RE.test(identity);
}

/**
 * Parse the branded ECAM career page and return the official job PDFs.
 *
 * A branded page with no matching PDF returns an empty array. The standard
 * crawler pipeline then preserves the previous slice rather than de-indexing
 * jobs after a transient page change.
 */
export function parseEcamListingPage(html = '', pageUrl = ECAM_CAREER_URL) {
  assertEcamUrl(pageUrl);
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    const title = normalizeSpace(document.title || '');
    const heading = normalizeSpace(document.querySelector('h1')?.textContent || '');
    const identity = `${title} ${heading}`;
    if (!/ecam|ente\s+case\s+anziani/i.test(identity) || !/opportunit|lavora|offert|concorso/i.test(identity)) {
      throw new Error('ECAM: authoritative career-page boundary missing or unbranded');
    }

    const seen = new Set();
    const listings = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const rawHref = anchor.getAttribute('href') || '';
      if (!/\.pdf(?:$|[?#])/i.test(rawHref)) continue;

      let pdfUrl;
      try {
        pdfUrl = new URL(rawHref, pageUrl);
        assertEcamUrl(pdfUrl.href, { allowPdf: true });
      } catch {
        continue;
      }

      const filename = decodeURIComponent(pdfUrl.pathname.split('/').pop() || '');
      const anchorText = normalizeSpace(anchor.textContent || anchor.getAttribute('aria-label') || '');
      if (!isJobPdf(filename, anchorText) || seen.has(pdfUrl.href)) continue;
      seen.add(pdfUrl.href);
      listings.push({
        pdfUrl: pdfUrl.href,
        filename,
        anchorText,
      });
    }

    if (listings.length > MAX_PDF_LISTINGS) {
      throw new Error(`ECAM: listing count ${listings.length} exceeds bounded cap ${MAX_PDF_LISTINGS}`);
    }
    return listings;
  } finally {
    dom.window.close();
  }
}

function italianDate(day, monthName, year) {
  const month = ITALIAN_MONTHS[normalize(monthName)];
  if (!month || !/^\d{4}$/.test(String(year)) || !/^\d{1,2}$/.test(String(day))) return '';
  const iso = `${year}-${month}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === iso ? iso : '';
}

function italianMonthDate(monthName, year) {
  const month = ITALIAN_MONTHS[normalize(monthName)];
  if (!month || !/^\d{4}$/.test(String(year))) return '';
  return `${year}-${month}-01`;
}

/** Extract the source publication date without confusing the application deadline for it. */
export function extractEcamPostedDate(pdfText = '', filename = '') {
  const text = normalizePdfText(pdfText);
  const dated = text.match(
    /\bMendrisio\s*,?\s*(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})\b/i,
  );
  if (dated) return italianDate(dated[1], dated[2], dated[3]);

  const monthOnly = text.match(
    /\bMendrisio\s*,?\s*(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})\b/i,
  );
  if (monthOnly) return italianMonthDate(monthOnly[1], monthOnly[2]);

  const uploadYearMonth = String(filename).match(/(?:^|\/)(\d{4})\/(\d{2})(?:\/|$)/);
  if (uploadYearMonth) return `${uploadYearMonth[1]}-${uploadYearMonth[2]}-01`;
  return '';
}

/** Extract a source deadline, including the year-long permanent-concours case. */
export function extractEcamValidThrough(pdfText = '') {
  const text = normalizePdfText(pdfText);
  const deadline = text.match(
    /\bentro\b[^\n]{0,80}?\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})\b/i,
  );
  if (deadline) return italianDate(deadline[1], deadline[2], deadline[3]);

  const yearLong = text.match(/\btutto\s+l['’]anno\s+(\d{4})\b/i);
  if (yearLong) return `${yearLong[1]}-12-31`;
  return '';
}

/** Resolve a concise title from the PDF body, falling back to the generic notice name. */
export function extractEcamTitle(pdfText = '', filename = '') {
  const text = normalizePdfText(pdfText);
  const lines = text.split('\n').map(normalizeSpace).filter(Boolean);
  const inlineVacancy = text.match(
    /\b(un\/a\s+[^:\n]{3,180}?\d{2,3}\s*%\s*(?:-\s*\d{2,3}\s*%)?)(?=\s+Compiti\b)/i,
  );
  if (inlineVacancy) return inlineVacancy[1].replace(/[.;]+$/, '').trim();
  const vacancyLine = lines.find((line) =>
    /^(?:un\/a|una?\s+|un\s+)/i.test(line)
    && /\d{2,3}\s*%/.test(line)
    && line.length <= 180,
  );
  if (vacancyLine) return vacancyLine.replace(/[.;]+$/, '').trim();

  if (/concorso[-_ ]generale|concorso generale/i.test(`${text} ${filename}`)) {
    return 'Concorso generale permanente 2026';
  }
  return 'Opportunità d’impiego ECAM';
}

function detectCategory(title, pdfText) {
  const value = normalize(`${title} ${pdfText}`);
  if (/risorse\s+umane|human\s+resources|hr\b/.test(value)) return 'Risorse Umane';
  if (/infermier|cura|sociosanitar|fisioterap|ergoterap|geriatr|assistente/.test(value)) return 'Sanità';
  if (/cucina|cuoco|economia\s+domestica/.test(value)) return 'Ristorazione / Economia domestica';
  if (/tecnic|manutent|edifici|infrastruttur/.test(value)) return 'Tecnica / Manutenzione';
  if (/amministrativ|commercio|contabilit|finanz/.test(value)) return 'Amministrazione';
  return 'Altro';
}

function detectEmploymentType(title, pdfText) {
  const percentages = [...`${title}\n${pdfText}`.matchAll(/(\d{2,3})\s*%/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (percentages.length === 0) return 'OTHER';
  return Math.max(...percentages) >= 90 ? 'FULL_TIME' : 'PART_TIME';
}

function contractForEmploymentType(employmentType) {
  if (employmentType === 'FULL_TIME') return 'full-time';
  if (employmentType === 'PART_TIME') return 'part-time';
  return 'other';
}

function experienceLevel(title) {
  return /responsabile|dirett|capo|coordinat/i.test(title) ? 'senior' : 'mid';
}

/** Build the source-locale job object from one official ECAM PDF. */
export function buildEcamJob({ pdfUrl, filename, pdfText = '' } = {}) {
  const sourceUrl = assertEcamUrl(pdfUrl, { allowPdf: true }).href;
  const title = extractEcamTitle(pdfText, filename);
  const description = buildPdfBackedDescription({
    introLines: [
      `${ECAM_COMPANY_NAME} pubblica il concorso «${title}» per il proprio organico di case per anziani nel Mendrisiotto.`,
      'La candidatura deve essere inviata tramite il formulario online indicato nella pagina ufficiale delle opportunità d’impiego.',
    ],
    pdfText,
    fallbackText: `Avviso ufficiale ECAM per ${title}. Consultare il PDF per compiti, requisiti, condizioni d’assunzione e modalità di candidatura.`,
    footerLines: [
      `Fonte (PDF): ${sourceUrl}`,
      `Pagina ufficiale: ${ECAM_CAREER_URL}`,
      'Settore: Sanità / Case per anziani',
    ],
  });
  const employmentType = detectEmploymentType(title, pdfText);
  const slug = slugify(`${title} ecam ${ECAM_CITY}`);
  const id = `ecam-${createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12)}`;
  const postedDate = extractEcamPostedDate(pdfText, filename);
  const validThrough = extractEcamValidThrough(pdfText);

  return {
    id,
    slug,
    slugByLocale: { it: slug },
    company: ECAM_COMPANY_NAME,
    companyKey: ECAM_KEY,
    companyDomain: ECAM_COMPANY_DOMAIN,
    title,
    titleByLocale: { it: title },
    description,
    descriptionByLocale: { it: description },
    location: ECAM_CITY,
    canton: ECAM_CANTON,
    url: sourceUrl,
    source: 'ECAM Dedicated Parser',
    sourceLang: 'it',
    crawledAt: new Date().toISOString(),
    addressLocality: ECAM_CITY,
    addressRegion: ECAM_CANTON,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: ECAM_POSTAL_CODE,
    category: detectCategory(title, pdfText),
    contract: contractForEmploymentType(employmentType),
    employmentType,
    experienceLevel: experienceLevel(title),
    sector: 'Sanità / Case per anziani',
    currency: 'CHF',
    featured: false,
    ...(postedDate ? { postedDate } : {}),
    ...(validThrough ? { validThrough } : {}),
    applyUrl: ECAM_CAREER_URL,
    requirements: [],
    requirementsByLocale: { it: [] },
  };
}

/**
 * Fetch the official ECAM page and extract every current job PDF.
 * Dependency injection keeps the parser tests offline and deterministic.
 */
export async function fetchAllEcamJobs({
  fetchPage = fetchHtml,
  extractPdfText = extractPdfJobContentFromUrl,
  timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000,
} = {}) {
  console.log(`🔍 Fetching ${ECAM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${ECAM_CAREER_URL}\n`);

  const listingHtml = await fetchEcamPage(ECAM_CAREER_URL, { fetchPage, timeoutMs });
  const listings = parseEcamListingPage(listingHtml, ECAM_CAREER_URL);
  if (listings.length === 0) {
    console.warn('⚠️ ECAM career page has no qualifying job PDF; preserving the existing slice.');
    return [];
  }

  console.log(`  📋 Official PDF listings found: ${listings.length}`);
  const jobs = [];
  for (const listing of listings) {
    const pdf = await extractPdfText(listing.pdfUrl, { timeoutMs });
    if (pdf?.error) throw new Error(`ECAM: unable to extract ${listing.pdfUrl}: ${pdf.error}`);
    if (!String(pdf?.text || '').trim()) {
      throw new Error(`ECAM: official PDF has no usable text layer (${listing.pdfUrl})`);
    }
    jobs.push(buildEcamJob({
      pdfUrl: listing.pdfUrl,
      filename: listing.filename,
      pdfText: pdf.text,
    }));
  }

  console.log(`\n📋 Total ${ECAM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

/** Match jobs belonging to ECAM, including previously stored source URLs. */
export function isEcamJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === ECAM_KEY
    || key.startsWith(`${ECAM_KEY}-`)
    || company.includes('ente case anziani mendrisiotto')
    || url.includes('ecam.swiss')
  );
}

/** Validate that a stored job URL remains inside ECAM's official domain. */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === ECAM_COMPANY_DOMAIN || host.endsWith(`.${ECAM_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}
