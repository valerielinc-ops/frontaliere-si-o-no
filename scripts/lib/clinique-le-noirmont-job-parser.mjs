/**
 * Clinique Le Noirmont (Le Noirmont, JU) job parser.
 *
 * Centre national de référence en réadaptation cardiovasculaire, médecine
 * interne, oncologie et psychosomatique. Career page:
 *
 *   https://www.cliniquelenoirmont.ch/La-clinique/Offres-demploi
 *
 * Two PDF URL shapes appear on that page:
 *
 *   1. `/File/{numericId}/{filename}.pdf` — older direct downloads. The PDF
 *      title comes from the filename.
 *   2. `/FileDownload/Download/{numericId}` — newer downloads, the PDF
 *      filename is not in the URL but the surrounding `<a>` tag carries
 *      `title="..."` with the human-readable job label.
 *
 * Both shapes are crawled. The link's `title=` attribute always wins over the
 * filename when present.
 */

import { buildPdfBackedDescription } from './pdf-job-content.mjs';

export const CLINIQUE_LE_NOIRMONT_KEY = 'clinique-le-noirmont';
export const CLINIQUE_LE_NOIRMONT_COMPANY_NAME = 'Clinique Le Noirmont';
export const CLINIQUE_LE_NOIRMONT_COMPANY_DOMAIN = 'cliniquelenoirmont.ch';
export const CLINIQUE_LE_NOIRMONT_CAREERS_URL =
  'https://www.cliniquelenoirmont.ch/La-clinique/Offres-demploi';

export const MIN_CLINIQUE_LE_NOIRMONT_DESC_LENGTH = 400;

const BASE_URL = 'https://www.cliniquelenoirmont.ch';

function decodeHtmlEntities(html = '') {
  return String(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function titleCaseToken(token) {
  if (!token) return token;
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function humanizeFilenameTitle(filename) {
  let stem = decodeURIComponent(String(filename || ''))
    .replace(/\.pdf$/i, '')
    .replace(/^Annonce[-_\s]*/i, '')
    .replace(/[_-]\d{4}([-_]?fr)?$/i, '');

  stem = stem.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return stem
    .split(/(\s+|[-—:,/.])/g)
    .map((part) => (/[a-zà-ÿäöüß]/i.test(part) ? titleCaseToken(part.toLowerCase()) : part))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function resolveAbsolute(url) {
  if (!url) return '';
  if (/^https?:/i.test(url)) return url;
  if (url.startsWith('/')) return `${BASE_URL}${url}`;
  return `${BASE_URL}/${url}`;
}

/**
 * Parse Clinique Le Noirmont careers HTML.
 *
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, identifier: string, titleFromFilename: string, titleFromAnchor: string }>}
 */
export function parseCliniqueLeNoirmontListing(html = '') {
  const out = [];
  const seen = new Set();
  const decoded = String(html || '');

  // Shape 1: /File/{id}/{filename}.pdf  — uses both filename and title= attribute
  const filePattern = /<a\b[^>]*href="(\/File\/(\d+)\/[^"]+?\.pdf)"[^>]*>/gi;
  let m;
  while ((m = filePattern.exec(decoded)) !== null) {
    const rel = m[1];
    const numId = m[2];
    const pdfUrl = resolveAbsolute(rel);
    const key = `file:${numId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Extract title= attribute from the same anchor tag if present.
    const anchorOpen = m[0];
    const titleAttrMatch = anchorOpen.match(/\btitle="([^"]+)"/i);
    const anchorText = titleAttrMatch
      ? decodeHtmlEntities(titleAttrMatch[1]).replace(/\s+/g, ' ').trim()
      : '';
    const filename = decodeURIComponent(rel.split('/').pop());
    const titleFromFilename = humanizeFilenameTitle(filename) || filename.replace(/\.pdf$/i, '');
    out.push({
      pdfUrl,
      identifier: key,
      titleFromFilename,
      titleFromAnchor: anchorText && anchorText.length > 3 ? anchorText : '',
    });
  }

  // Shape 2: /FileDownload/Download/{id} with title="..." attribute
  const downloadPattern =
    /<a\b[^>]*href="(\/FileDownload\/Download\/(\d+))"[^>]*?title="([^"]+)"[^>]*>/gi;
  while ((m = downloadPattern.exec(decoded)) !== null) {
    const rel = m[1];
    const numId = m[2];
    const titleAttr = decodeHtmlEntities(m[3] || '').replace(/\s+/g, ' ').trim();
    const pdfUrl = resolveAbsolute(rel);
    const key = `dl:${numId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pdfUrl,
      identifier: key,
      titleFromFilename: '',
      titleFromAnchor: titleAttr,
    });
  }

  return out;
}

/**
 * Pick the strongest title signal: anchor title > filename > "Offre d'emploi".
 */
export function resolveCliniqueLeNoirmontTitle(listing) {
  const anchor = (listing.titleFromAnchor || '').trim();
  if (anchor && anchor.length > 3 && !/^(t[ée]l[ée]charger|download|pdf)$/i.test(anchor)) {
    return anchor;
  }
  if (listing.titleFromFilename) return listing.titleFromFilename;
  return `Offre d'emploi ${listing.identifier || ''}`.trim();
}

/**
 * Build a structured PDF-backed description for a Le Noirmont posting.
 */
export function buildCliniqueLeNoirmontDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `La Clinique Le Noirmont est un centre national de référence en réadaptation cardiovasculaire, médecine interne, oncologie et psychosomatique, situé dans le Jura suisse.`,
      `Poste : ${title}.`,
    ],
    pdfText,
    fallbackText: `Offre ${title} à la Clinique Le Noirmont. Les conditions complètes (profil, missions, candidature) figurent dans le PDF officiel.`,
    footerLines: [
      `Source (PDF) : ${pdfUrl}`,
      `Portail carrières : ${CLINIQUE_LE_NOIRMONT_CAREERS_URL}`,
      `Secteur : Réadaptation cardiovasculaire et médecine interne`,
    ],
  });

  const warnings = [];
  if (pdfText && description.length < MIN_CLINIQUE_LE_NOIRMONT_DESC_LENGTH) {
    warnings.push(
      `Clinique Le Noirmont description too short (${description.length} chars < ${MIN_CLINIQUE_LE_NOIRMONT_DESC_LENGTH}) for "${title}"`
    );
  }
  return { description, warnings };
}
