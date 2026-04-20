/**
 * FART – Ferrovie Autolinee Regionali Ticinesi — job parser
 *
 * Listing page: https://fartiamo.ch/lavora-con-noi-concorsi/
 *   WordPress CMS — each job is an <h5> title followed by a PDF "CONCORSO" link.
 *
 * HTML structure:
 *   <h5>Job Title (percentage – m/f)</h5>
 *   ... <a href="https://fartiamo.ch/wp-content/uploads/.../concorso.pdf">CONCORSO</a> ...
 */

import { buildPdfBackedDescription } from './pdf-job-content.mjs';

const COMPANY_NAME = 'FART – Ferrovie Autolinee Regionali Ticinesi';
const CAREERS_URL = 'https://fartiamo.ch/lavora-con-noi-concorsi/';

/** Minimum plain-text description length to accept (characters). */
export const MIN_FART_DESC_LENGTH = 400;

function normalizeSpace(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(html = '') {
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#039;/gi, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D');
}

function stripHtml(html = '') {
  return decodeHtmlEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Parse the WordPress careers page and return job listings.
 *
 * @param {string} html - Full HTML of the careers page
 * @returns {Array<{ title: string, pdfUrl: string }>}
 */
export function parseFartListingPage(html = '') {
  const jobs = [];
  const pattern = /<h5[^>]*>([\s\S]*?)<\/h5>([\s\S]*?)(?=<h5|<h1|<form|$)/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const rawTitle = normalizeSpace(stripHtml(match[1]));
    if (!rawTitle) continue;

    const afterH5 = match[2];
    const pdfMatch = afterH5.match(/<a[^>]*href="([^"]+\.pdf)"[^>]*>/i);
    if (!pdfMatch) continue;

    let pdfUrl = pdfMatch[1];
    if (/informativa|privacy|protezione/i.test(pdfUrl)) continue;

    if (pdfUrl.startsWith('http://')) {
      pdfUrl = pdfUrl.replace('http://', 'https://');
    }
    if (!pdfUrl.startsWith('http')) {
      pdfUrl = `https://fartiamo.ch${pdfUrl}`;
    }

    jobs.push({ title: rawTitle, pdfUrl });
  }

  return jobs;
}

/**
 * Build a full description from a job title and raw (un-normalized) PDF text.
 *
 * Passes the raw PDF text to buildPdfBackedDescription so normalizePdfJobText()
 * is applied exactly once — avoiding the double-normalization that previously
 * caused deduplication to collapse the body too aggressively.
 *
 * Returns the description string and an array of warnings (empty if description
 * is long enough relative to the available PDF source).
 *
 * @param {string} title       Job title from the listing page
 * @param {string} rawPdfText  Raw un-normalized text from the PDF extraction
 * @returns {{ description: string, warnings: string[] }}
 */
export function buildFartDescription(title = '', rawPdfText = '') {
  const description = buildPdfBackedDescription({
    introLines: [
      `${COMPANY_NAME} pubblica il seguente concorso.`,
      `Posizione: ${title}.`,
    ],
    pdfText: rawPdfText,
    fallbackText: `Concorso ${title} presso ${COMPANY_NAME}. Consultare il bando PDF ufficiale per dettagli completi su requisiti, mansioni e candidatura.`,
    footerLines: [
      'Bando ufficiale disponibile in PDF.',
      'Settore: Trasporti pubblici / Ferrovia',
      'Sede: Via Domenico Galli 9, 6600 Locarno (TI), Svizzera',
      'Contatto: fart@centovalli.ch | Tel. +41 (0)91 756 04 00',
    ],
  });

  const warnings = [];
  if (rawPdfText && description.length < MIN_FART_DESC_LENGTH) {
    warnings.push(
      `FART description too short (${description.length} chars < ${MIN_FART_DESC_LENGTH}) despite PDF source being available — ` +
      `PDF may have changed structure or content`
    );
  }

  return { description, warnings };
}

/**
 * Count meaningful paragraphs in a description string.
 * A paragraph is meaningful if it has >= 20 characters of non-whitespace content.
 *
 * @param {string} description
 * @returns {number}
 */
export function countMeaningfulParagraphs(description = '') {
  return String(description || '')
    .split(/\n\n+/)
    .filter((para) => para.replace(/\s+/g, '').length >= 20).length;
}
