/**
 * TPL (Trasporti Pubblici Luganesi) — tplsa.ch job parser
 *
 * TPL is the public transport operator for the Lugano area in Ticino.
 * Their careers page at tplsa.ch/2/50/tpl-lavora-con-noi.html shows
 * open positions when available. The page is server-rendered HTML.
 *
 * This module exports:
 *   parseTplListingPage(html)  — extract job links from careers page
 *   parseTplListingState(html) — distinguish a real zero from source drift
 *   parseTplDetailPage(html)   — extract the source-owned vacancy block
 *   isTplJob(job)              — match TPL jobs in dataset
 */

import { buildPdfBackedDescription } from './pdf-job-content.mjs';

const TPL_ORIGIN = 'https://www.tplsa.ch';
const TPL_HOST = 'www.tplsa.ch';
const TPL_DETAIL_PATH = '/2/50/candidati/';
const TPL_COMPANY_NAME = 'TPL - Trasporti Pubblici Luganesi';

/** Minimum plain-text description length to accept (characters). */
export const MIN_TPL_DESC_LENGTH = 400;

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract job URLs from the TPL careers listing page.
 *
 * Real markup (verified live 2026-07): the "Elenco posizioni" table rows
 * link each open position to an application/detail page of the form
 *   <a style = "color: #68be4d" href = "/2/50/candidati/?idhr=748">
 *     <i class="fas fa-arrow-right"></i> Specialista Risorse Umane</a>
 * Notes:
 *   - the CMS emits spaces around the `=` of attributes (href = "..."),
 *   - `idhr=0` is the spontaneous-application form, not a job posting.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string }[]}
 */
export function parseTplListingPage(html = '') {
  if (!html) return [];

  const results = [];
  const seen = new Set();

  const linkPattern =
    /<a\b[^>]*href\s*=\s*"([^"]*\/candidati\/?\?[^"]*\bidhr=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const rawUrl = match[1].replace(/&amp;/g, '&');
    const idhr = match[2];
    if (idhr === '0') continue; // spontaneous-application form, not a posting

    const rawTitle = normalizeSpace(stripHtml(match[3]));
    if (!rawTitle || rawTitle.length < 3) continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl, TPL_ORIGIN);
    } catch {
      continue;
    }
    // The listing is public HTML and therefore untrusted input. Only the exact
    // TPL detail route may become a direct-fetch adapter seed; accepting an
    // absolute off-domain href here would turn the crawler into an SSRF hop.
    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.hostname.toLowerCase() !== TPL_HOST ||
      parsedUrl.pathname.replace(/\/+$/, '/') !== TPL_DETAIL_PATH ||
      parsedUrl.searchParams.get('idhr') !== idhr
    ) {
      continue;
    }
    parsedUrl.hash = '';
    const url = parsedUrl.href;

    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: rawTitle });
  }

  return results;
}

/**
 * Classify the authoritative careers listing without treating every empty
 * parse as a legitimate zero. TPL renders these two sentences only when its
 * vacancy query completed successfully and returned no rows.
 *
 * @param {string} html
 * @returns {{ state: 'jobs'|'empty'|'invalid', jobs: {url: string, title: string}[] }}
 */
export function parseTplListingState(html = '') {
  const jobs = parseTplListingPage(html);
  if (jobs.length > 0) return { state: 'jobs', jobs };

  const text = normalizeSpace(stripHtml(html));
  const sourceProvenEmpty =
    /non ci sono risultati nell['’]area selezionata\./i.test(text) &&
    /vi consigliamo di riprovare prossimamente\./i.test(text);
  if (sourceProvenEmpty) return { state: 'empty', jobs: [] };
  return { state: 'invalid', jobs: [] };
}

/**
 * Extract the authoritative vacancy block from a TPL application/detail page.
 * The CMS has no JobPosting JSON-LD and puts the role between its vacancy H1
 * and the generic `Menu2` company accordion. A blank H1 is the stale/closed
 * ghost-page shape (still HTTP 200) and must fail closed.
 *
 * The vacancy text itself is NOT on this page: the CMS only renders the role
 * heading, the application instructions and a link to the "capitolato" PDF that
 * carries the actual ad (tasks, requirements, contract). That link is therefore
 * returned as `capitolatoUrl` so the runner can build a real description from it.
 *
 * @param {string} html
 * @param {string} [expectedTitle] title advertised by the careers listing
 * @returns {{ title: string, body: string, location: string, capitolatoUrl: string } | null}
 */
export function parseTplDetailPage(html = '', expectedTitle = '') {
  const source = String(html || '');
  if (!source) return null;

  const menuIndex = source.search(/<div[^>]*class\s*=\s*["'][^"']*\bMenu2\b[^"']*["'][^>]*>/i);
  if (menuIndex < 0) return null;
  const vacancyBlock = source.slice(0, menuIndex);

  const headings = [...vacancyBlock.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  const titleMatch = headings.find((match) => {
    const candidate = normalizeSpace(stripHtml(match[1]));
    return candidate.length >= 6 && !/^(lavora con noi|candidatura|candidati)$/i.test(candidate);
  });
  if (!titleMatch) return null;

  const title = normalizeSpace(stripHtml(titleMatch[1]));
  if (expectedTitle && normalizeSpace(expectedTitle).toLocaleLowerCase('it') !== title.toLocaleLowerCase('it')) {
    return null;
  }

  const afterTitle = vacancyBlock.slice((titleMatch.index || 0) + titleMatch[0].length);
  const body = stripHtml(afterTitle)
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .join('\n');

  // A real TPL vacancy exposes a role-specific capitolato link and a usable
  // application block. The closed idhr=748 ghost now exposes only the latter;
  // requiring both prevents it (and generic navigation) from becoming a job.
  const hasCapitolato = /<a\b[^>]*(?:class\s*=\s*["'][^"']*btn-candidati|href\s*=\s*["'][^"']*\/repository\/pdf\/)[^>]*>/i.test(afterTitle);
  if (!hasCapitolato || body.length < 80) return null;

  return { title, body, location: 'Lugano', capitolatoUrl: extractTplCapitolatoUrl(afterTitle) };
}

/**
 * Extract the absolute URL of the role's "capitolato" PDF, the only place where
 * TPL publishes the real ad content.
 *
 * Same SSRF discipline as the listing parser: the href comes from untrusted
 * public HTML, so only an https `/repository/pdf/*.pdf` route on TPL's own host
 * is accepted — an absolute off-domain href must never become a fetch target.
 *
 * @param {string} html - HTML of the vacancy block following the role heading
 * @returns {string} absolute PDF URL, or '' when none is published
 */
export function extractTplCapitolatoUrl(html = '') {
  const match = String(html || '').match(
    /<a\b[^>]*href\s*=\s*(['"])([^'"]*\/repository\/pdf\/[^'"]*)\1/i,
  );
  if (!match) return '';
  try {
    const parsed = new URL(match[2].replace(/&amp;/g, '&'), TPL_ORIGIN);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname.toLowerCase() !== TPL_HOST) return '';
    if (!/\.pdf$/i.test(parsed.pathname)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/**
 * Build the published description for a TPL vacancy: the capitolato PDF text is
 * the body, the page block (application instructions) is the fallback for a
 * missing/image-only PDF.
 *
 * @param {string} title
 * @param {string} rawPdfText - un-normalized capitolato text ('' when absent)
 * @param {string} inlineBody - vacancy block scraped from the detail page
 * @returns {{ description: string, warnings: string[] }}
 */
export function buildTplDescription(title = '', rawPdfText = '', inlineBody = '') {
  const description = buildPdfBackedDescription({
    introLines: [
      `${TPL_COMPANY_NAME} pubblica il seguente concorso.`,
      `Posizione: ${normalizeSpace(title)}.`,
    ],
    pdfText: rawPdfText,
    fallbackText: inlineBody
      || `Concorso ${normalizeSpace(title)} presso ${TPL_COMPANY_NAME}. Consultare il capitolato ufficiale per i dettagli completi su mansioni, requisiti e modalita di candidatura.`,
    footerLines: [
      'Capitolato ufficiale disponibile in PDF.',
      'Settore: Trasporti pubblici / Mobilita',
      'Sede: Via Campagna 15, 6900 Lugano (TI), Svizzera',
    ],
  });

  const warnings = [];
  if (rawPdfText && description.length < MIN_TPL_DESC_LENGTH) {
    warnings.push(
      `TPL description too short (${description.length} chars < ${MIN_TPL_DESC_LENGTH}) despite a capitolato PDF being available — `
      + 'the PDF may be image-only/scanned.',
    );
  }
  return { description, warnings };
}

/**
 * Check if a job belongs to TPL.
 * @param {object} job
 * @returns {boolean}
 */
export function isTplJob(job) {
  if (!job) return false;
  const company = String(job.company || '').toLowerCase();
  const key = String(job.companyKey || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();
  return (
    key === 'tpl-lugano' ||
    key.includes('tpl') ||
    company.includes('trasporti pubblici luganesi') ||
    company.includes('tpl') ||
    url.includes('tplsa.ch')
  );
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}
