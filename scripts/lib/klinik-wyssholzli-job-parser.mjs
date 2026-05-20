/**
 * Klinik Wysshölzli (Herzogenbuchsee, BE) job parser.
 *
 * Privatklinik, specialised in psychiatric and psychotherapeutic care for
 * women with addiction and eating disorders. Career page:
 *
 *   https://www.wysshoelzli.ch/jobs-karriere
 *
 * Postings are listed as direct `<a href=".../uploads/Stelleninserate/*.pdf">`
 * download links. There is no HTML body per posting — the full job description
 * lives only inside the PDF.
 */

import { buildPdfBackedDescription } from './pdf-job-content.mjs';

export const KLINIK_WYSSHOLZLI_KEY = 'klinik-wyssholzli';
export const KLINIK_WYSSHOLZLI_COMPANY_NAME = 'Klinik Wysshölzli';
export const KLINIK_WYSSHOLZLI_COMPANY_DOMAIN = 'wysshoelzli.ch';
export const KLINIK_WYSSHOLZLI_CAREERS_URL =
  'https://www.wysshoelzli.ch/jobs-karriere';

export const MIN_KLINIK_WYSSHOLZLI_DESC_LENGTH = 400;

const PDF_PATH_PREFIX = '/uploads/Stelleninserate/';

function titleCaseToken(token) {
  if (!token) return token;
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Convert filename slug → readable title.
 *   "Inserat-Stv.-Leitung-Behandlung_02_2026.pdf"
 *     → "Stv. Leitung Behandlung 02/2026"
 *   "Psychologin_Psychotherapeutin_07.2026_60-80-_04_2026.pdf"
 *     → "Psychologin Psychotherapeutin 07.2026 60–80%"
 */
function humanizeFilenameTitle(filename) {
  let stem = String(filename || '')
    .replace(/\.pdf$/i, '')
    .replace(/^(Inserat|Stelleninserat)[-_\s]*/i, '');

  // Drop trailing "_DD_YYYY" date stamps but keep a leading month-year reference.
  stem = stem.replace(/_(\d{2})_(\d{4})$/g, ' $1/$2');

  // Percentage ranges like "60-80" or "60_100"
  stem = stem.replace(/(\d{2,3})[-_](\d{2,3})/g, '$1–$2%');
  stem = stem.replace(/_(\d{2,3})_?(?=$|\s)/g, ' $1%');

  // Replace remaining separators with spaces.
  stem = stem.replace(/[_]+/g, ' ').replace(/-+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return stem
    .split(/(\s+|[-—:,/.])/g)
    .map((part) => (/[a-zà-ÿäöüß]/i.test(part) ? titleCaseToken(part.toLowerCase()) : part))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Parse the Wysshölzli careers HTML and return PDF listings.
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, filename: string, titleFromFilename: string }>}
 */
export function parseKlinikWysshholzliListing(html = '') {
  const pattern = new RegExp(
    `href="(https?:\\/\\/[^\\"\\s]*?${PDF_PATH_PREFIX.replace(/[/.]/g, '\\$&')}[^\\"\\s]+\\.pdf)"`,
    'gi'
  );
  const seen = new Set();
  const out = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const url = match[1].replace(/&amp;/g, '&');
    if (seen.has(url)) continue;
    seen.add(url);
    const filename = decodeURIComponent(url.split('/').pop());
    const titleFromFilename = humanizeFilenameTitle(filename) || filename.replace(/\.pdf$/i, '');
    out.push({ pdfUrl: url, filename, titleFromFilename });
  }
  return out;
}

/**
 * Build a structured PDF-backed description for a Wysshölzli posting.
 */
export function buildKlinikWysshholzliDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `Die Klinik Wysshölzli ist eine spezialisierte psychiatrische und psychotherapeutische Privatklinik im Oberaargau (Herzogenbuchsee, BE).`,
      `Stelle: ${title}.`,
    ],
    pdfText,
    fallbackText: `Stelleninserat ${title} bei ${KLINIK_WYSSHOLZLI_COMPANY_NAME}. Vollständige Angaben zu Profil und Bewerbung finden Sie im offiziellen PDF.`,
    footerLines: [
      `Quelle (PDF): ${pdfUrl}`,
      `Karriereportal: ${KLINIK_WYSSHOLZLI_CAREERS_URL}`,
      `Sektor: Psychiatrie und Psychotherapie / Suchterkrankungen / Essstörungen`,
    ],
  });

  const warnings = [];
  if (pdfText && description.length < MIN_KLINIK_WYSSHOLZLI_DESC_LENGTH) {
    warnings.push(
      `Klinik Wysshölzli description too short (${description.length} chars < ${MIN_KLINIK_WYSSHOLZLI_DESC_LENGTH}) for "${title}"`
    );
  }
  return { description, warnings };
}
