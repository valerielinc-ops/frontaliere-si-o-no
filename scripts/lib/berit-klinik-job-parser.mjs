/**
 * Berit Klinik (Gruppe) job parser.
 *
 * The Berit Klinik group operates seven hospital/clinic sites in north-eastern
 * Switzerland (Speicher AR — HQ, Niederteufen AR, Goldach SG, Wattwil SG, Arbon TG,
 * plus the Berit Sportclinic locations). Their public career page is a Next.js
 * SPA that hydrates a list of "Stelleninserat" PDFs hosted on the CMS:
 *
 *   Career page: https://www.beritklinik.ch/de/karriere-offene-stellen
 *   CMS host:    https://cms-berit-klinik.deployco.de/api/media/file/<filename>.pdf
 *
 * Discovery strategy:
 *   1. Fetch the SSR HTML for /de/karriere-offene-stellen
 *   2. Regex out every absolute PDF URL on cms-berit-klinik.deployco.de
 *   3. Derive a human-readable title from the filename (e.g.
 *      "stelleninserat_logistiker_in_100__fb375a3261.pdf" → "Logistiker:in, 100%")
 *   4. Extract PDF text via unpdf (~1.5-3 kB per posting)
 *   5. Detect the actual canton/city from PDF body keywords (Speicher, Wattwil,
 *      Goldach, Niederteufen, St. Gallen, Arbon)
 *
 * The PDFs all share the same header — "Berit Klinik AG | Vögelinsegg 5 | 9042
 * Speicher" — so the SKIP_BOILERPLATE_GUARD env flag is set on the workflow.
 */

import { buildPdfBackedDescription } from './pdf-job-content.mjs';
import { escapeRegExpLiteral } from './escape-regexp.mjs';

export const BERIT_KLINIK_KEY = 'berit-klinik';
export const BERIT_KLINIK_COMPANY_NAME = 'Berit Klinik';
export const BERIT_KLINIK_COMPANY_DOMAIN = 'beritklinik.ch';
export const BERIT_KLINIK_CAREERS_URL =
  'https://www.beritklinik.ch/de/karriere-offene-stellen';
export const BERIT_KLINIK_CMS_HOST = 'cms-berit-klinik.deployco.de';

/** Minimum plain-text description length to accept (characters). */
export const MIN_BERIT_KLINIK_DESC_LENGTH = 400;

/**
 * Mapping table: canton/city defaults for the Berit Klinik group.
 * Speicher (AR) is the HQ. Other sites resolved from PDF text content.
 */
const SITE_TABLE = [
  { match: /\b(wattwil)\b/i, city: 'Wattwil', canton: 'SG', postalCode: '9630' },
  { match: /\b(goldach)\b/i, city: 'Goldach', canton: 'SG', postalCode: '9403' },
  { match: /\b(niederteufen|teufen)\b/i, city: 'Niederteufen', canton: 'AR', postalCode: '9052' },
  { match: /\b(arbon)\b/i, city: 'Arbon', canton: 'TG', postalCode: '9320' },
  { match: /\b(heerbrugg)\b/i, city: 'Heerbrugg', canton: 'SG', postalCode: '9435' },
  { match: /\b(st\.?\s*gallen|sankt\s*gallen|sportslab)\b/i, city: 'St. Gallen', canton: 'SG', postalCode: '9000' },
  { match: /\b(speicher)\b/i, city: 'Speicher', canton: 'AR', postalCode: '9042' },
];

const DEFAULT_SITE = { city: 'Speicher', canton: 'AR', postalCode: '9042' };

function titleCaseToken(token) {
  if (!token) return token;
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Convert a filename slug like
 *   "stelleninserat_mitarbeiter_in_technischer_dienst_100___fachbereich_sanit_r"
 * into a human title like
 *   "Mitarbeiter:in Technischer Dienst, 100% — Fachbereich Sanitär".
 *
 * Heuristics:
 *   - drop leading "stelleninserat" / "ausbildungsstelle" markers
 *   - rebuild :in suffix where the slug encodes inclusivity (`_in_`)
 *   - collapse multiple underscores into spaces / em-dashes
 *   - reattach percentage tokens like `60_80` → "60-80%"
 *   - capitalise non-trivial words
 */
function humanizeFilenameTitle(filename) {
  let stem = String(filename || '')
    .replace(/\.pdf$/i, '')
    .replace(/_[a-f0-9]{10,}$/i, '')
    .replace(/^(stelleninserat|ausbildungsstelle|ausschreibung|inserat)[_\s-]*/i, '');

  if (!stem) return '';

  // Percentage range tokens like "60_80" or "100"  →  "60–80%"
  stem = stem.replace(/_(\d{2,3})_(\d{2,3})_/g, ' $1–$2% ');
  stem = stem.replace(/_(\d{2,3})_$/g, ' $1%');
  stem = stem.replace(/_(\d{2,3})__/g, ' $1% — ');
  stem = stem.replace(/_(\d{2,3})_/g, ' $1% ');

  // umlaut transliterations that the CMS strips
  stem = stem.replace(/\bsanit_r\b/gi, 'Sanitär');
  stem = stem.replace(/\bk_chin\b/gi, 'Köchin');
  stem = stem.replace(/\barztsekret_rin\b/gi, 'Arztsekretärin');

  // collapse separators
  stem = stem.replace(/___+/g, ' — ').replace(/__+/g, ' — ').replace(/_/g, ' ');

  // " in " → ":in" (inclusivity marker e.g. Logistiker:in, MPA Arztsekretär:in)
  stem = stem.replace(/(\w)\s+in(?=\s|$|,)/g, '$1:in');

  // tidy punctuation
  stem = stem.replace(/\s+,/g, ',').replace(/\s+%/g, '%').replace(/\s+—\s+—\s+/g, ' — ').replace(/\s{2,}/g, ' ').trim();
  stem = stem.replace(/—\s*$/, '').trim();

  return stem
    .split(/(\s+|[-—:,/.])/g)
    .map((part) => (/[a-zà-ÿäöüß]/i.test(part) ? titleCaseToken(part.toLowerCase()) : part))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const escapeRegex = escapeRegExpLiteral;

/**
 * Parse the careers HTML and return distinct PDF listings.
 *
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, filename: string, titleFromFilename: string }>}
 */
export function parseBeritKlinikListing(html = '') {
  const pdfPattern = new RegExp(
    `https?:\\/\\/${escapeRegex(BERIT_KLINIK_CMS_HOST)}\\/api\\/media\\/file\\/[A-Za-z0-9._%+-]+?\\.pdf`,
    'gi'
  );
  const matches = String(html || '').match(pdfPattern) || [];

  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const url = raw.replace(/\\$/, '').replace(/&amp;/g, '&');
    if (seen.has(url)) continue;
    seen.add(url);

    const filename = decodeURIComponent(url.split('/').pop());
    const titleFromFilename = humanizeFilenameTitle(filename) || filename.replace(/\.pdf$/i, '');
    out.push({ pdfUrl: url, filename, titleFromFilename });
  }
  return out;
}

/**
 * Resolve city/canton from the PDF body.
 *
 * Strategy (most specific → least specific):
 *   1. Look for the explicit phrase "für unseren Standort in <City> <Canton>"
 *      — used by Berit Klinik consistently on every PDF
 *   2. Look for site name in the filename
 *   3. Scan the full PDF text (last fallback — will often match the
 *      boilerplate "in Wattwil stehen…" sentence and is therefore the
 *      least reliable signal)
 *   4. Default to Speicher AR (group HQ)
 */
export function resolveBeritKlinikSite(pdfText = '', filename = '') {
  const text = String(pdfText || '');

  // Signal 1: explicit "Standort in X" pattern (highest confidence).
  const standortMatch = text.match(
    /(?:f[üu]r\s+unseren\s+Standort|unseren\s+Standort|Standort)\s+(?:in\s+)?([A-ZÄÖÜ][A-Za-zäöüß.\-]+(?:\s+[A-ZÄÖÜ][A-Za-zäöüß.\-]+)?)/
  );
  if (standortMatch) {
    const fragment = standortMatch[1];
    for (const site of SITE_TABLE) {
      if (site.match.test(fragment)) {
        return { city: site.city, canton: site.canton, postalCode: site.postalCode };
      }
    }
  }

  // Signal 2: filename hints (e.g. "*_wattwil_*", "*_op_dispo_wattwil_*").
  for (const site of SITE_TABLE) {
    if (site.match.test(filename)) {
      return { city: site.city, canton: site.canton, postalCode: site.postalCode };
    }
  }

  // Signal 3: full-text scan (weakest — matches boilerplate too).
  for (const site of SITE_TABLE) {
    if (site.match.test(text)) {
      return { city: site.city, canton: site.canton, postalCode: site.postalCode };
    }
  }

  return { ...DEFAULT_SITE };
}

const PDF_TITLE_BLACKLIST_TOKENS = [
  /dienstagvormittag/i,
  /freitag/i,
  /montag/i,
  /jobsharing/i,
];

/**
 * Pick the strongest title signal between the filename-derived title and the
 * PDF-extracted title. The PDF title wins only when it is concise (<=80 chars),
 * looks like a real job title (contains either a percentage or a known job
 * keyword), and is not a calendar fragment.
 */
export function pickBestBeritTitle(filenameTitle = '', pdfTitle = '') {
  const filename = String(filenameTitle || '').trim();
  const pdf = String(pdfTitle || '').trim();
  if (!pdf) return filename;
  if (pdf.length > 80) return filename;
  if (PDF_TITLE_BLACKLIST_TOKENS.some((rx) => rx.test(pdf))) return filename;
  // Require percentage or job-noun cue in the PDF title.
  const looksLikeJob = /(%|Pflegefach|Logistik|Hotellerie|Praxisassistent|Sekret|Dispo|Koch|Köchin|Mitarbeiter|Praktikant|Assistenz)/i.test(pdf);
  if (!looksLikeJob) return filename;
  return pdf;
}

/**
 * Try to extract a cleaner job title from the PDF body. The Berit PDFs
 * place the title right before the phrase "für unseren Standort in".
 * Returns "" if no high-confidence title is found.
 */
export function extractBeritKlinikTitleFromPdf(pdfText = '') {
  const text = String(pdfText || '');
  // Look for "<Title> für unseren Standort in <City>" — title is the last
  // 4-10 words before "für unseren Standort".
  const m = text.match(/([A-ZÄÖÜ][A-Za-zäöüß.,:\s/\-\d%]{4,80}?)\s+f[üu]r\s+unseren\s+Standort/);
  if (!m) return '';
  let title = m[1].replace(/\s+/g, ' ').trim();
  // Strip any contact-block residue at the start (e.g. "hr@klinik.ch Logistiker:in").
  // Find the last capital-letter token group.
  const idx = title.search(/[A-ZÄÖÜ][a-zäöüß]+(?::\w+)?(?:[,\s]|\s+\d)/);
  if (idx > 0) title = title.slice(idx).trim();
  // Final sanity: title should contain at least one letter and be ≥3 chars.
  if (title.length < 3) return '';
  return title;
}

/**
 * Build a structured PDF-backed description for a Berit posting.
 *
 * @param {string} title       Resolved job title
 * @param {string} city        Resolved city
 * @param {string} pdfText     Raw PDF text (un-normalised — buildPdfBackedDescription normalises once)
 * @param {string} pdfUrl      Source PDF URL (added to footer)
 * @returns {{ description: string, warnings: string[] }}
 */
export function buildBeritKlinikDescription({ title, city, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `${BERIT_KLINIK_COMPANY_NAME} sucht für den Standort ${city} eine engagierte Persönlichkeit.`,
      `Position: ${title}.`,
    ],
    pdfText,
    fallbackText: `Stelleninserat ${title} bei ${BERIT_KLINIK_COMPANY_NAME}. Die vollständigen Angaben zu Aufgaben, Anforderungen und Bewerbungsweg entnehmen Sie dem offiziellen PDF.`,
    footerLines: [
      `Quelle (PDF): ${pdfUrl}`,
      `Karriereportal: ${BERIT_KLINIK_CAREERS_URL}`,
      `Sektor: Gesundheitswesen / Klinik`,
    ],
  });

  const warnings = [];
  if (pdfText && description.length < MIN_BERIT_KLINIK_DESC_LENGTH) {
    warnings.push(
      `Berit Klinik description too short (${description.length} chars < ${MIN_BERIT_KLINIK_DESC_LENGTH}) for "${title}" — PDF text may have changed`
    );
  }
  return { description, warnings };
}
