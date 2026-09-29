/**
 * BPS (Banca Popolare di Sondrio) Suisse — bps-suisse.ch job parser
 *
 * BPS Suisse is a banking institution based in Lugano, TI.
 * Their careers page at bps-suisse.ch/lavora-in-bps-suisse.php lists
 * open positions as simple anchor elements linking to detail pages
 * (carriera-{slug}.php). Detail pages often contain a link to a PDF
 * with the full job description.
 *
 * This module exports:
 *   parseBpsSuisseListingPage(html)  — extract job URLs from listing page
 *   parseBpsSuisseDetailPage(html)   — extract job data from a detail page
 *   isTicinoBpsJob(job)              — deprecated legacy compatibility helper
 *   buildBpsSuisseDescriptionFields  — the posting's own text, keyed by language
 *   dropBpsSuisseFabricatedText(job) — remove the former wrapper from a stored job
 */
import { buildPdfBackedDescription } from './pdf-job-content.mjs';
import {
  dropTranslationsOfFabricatedSource,
  sourceLocaleDescription,
} from './source-locale-description.mjs';

/** Minimum body length for a "full" BPS job description. */
export const MIN_BPS_FULL_DESC = 200;

/**
 * Description fields of one posting: the PDF call when BPS links one (it
 * carries the whole ad), else the detail-page body — in its own language.
 *
 * The runner used to wrap that text in lines of its own ("## <title>",
 * "BPS (Banca Popolare di Sondrio) SUISSE — posizione aperta a Lugano (TI).",
 * "**Settore:** Bancario / Finanziario", "**Sede:** Via Giacomo Bentina 5…",
 * a link to the PDF) and to substitute a paragraph about the bank when both
 * were empty; BPS publishes none of it. A posting without text gets no
 * description and takes the pipeline's thin-source path.
 *
 * @param {{ pdfText?: string, bodyText?: string }} source
 */
export function buildBpsSuisseDescriptionFields({ pdfText = '', bodyText = '' } = {}) {
  return sourceLocaleDescription(
    buildPdfBackedDescription({ pdfText, fallbackText: bodyText }),
    { defaultLang: 'it' },
  );
}

// Fossils of the former wrapper in stored jobs (header line, or the
// substituted bank paragraph).
const BPS_WRAPPER_RE = /BPS \(Banca Popolare di Sondrio\) SUISSE — posizione aperta a |— posizione aperta presso BPS \(Banca Popolare di Sondrio\) SUISSE/;
// The substituted paragraph is ours from start to end: nothing to keep.
const BPS_SUBSTITUTE_RE = /— posizione aperta presso BPS \(Banca Popolare di Sondrio\) SUISSE/;
// Title heading + intro sentence, also when a later pass flattened the
// newlines ("## <title> BPS (…) SUISSE — posizione aperta a Lugano (TI). …").
const BPS_INTRO_RE = /^[\s\S]{0,300}?BPS \(Banca Popolare di Sondrio\) SUISSE — posizione aperta a [^\n]*?\([A-Z]{2}\)\.\s*/;
// The footers exactly as the runner wrote them.
const BPS_FOOTER_RES = [
  /\s*\*\*Settore:\*\*\s*Bancario \/ Finanziario/g,
  /\s*\*\*Sede:\*\*\s*Via Giacomo Bentina 5, 6901 Lugano, TI, Svizzera/g,
  /\s*\[Bando ufficiale \(PDF\)\]\([^)\s]*\)/g,
];

/**
 * The posting text inside a wrapped stored description, '' when the whole
 * text was the substituted paragraph, or null when `text` has no wrapper.
 */
function stripBpsWrapper(text) {
  const value = String(text || '');
  if (!BPS_WRAPPER_RE.test(value)) return null;
  if (BPS_SUBSTITUTE_RE.test(value)) return '';
  let out = value.replace(BPS_INTRO_RE, '');
  for (const re of BPS_FOOTER_RES) out = out.replace(re, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove the former wrapper from a stored job. The wrapped text sat in the
 * top-level `description` (with `descriptionByLocale` often empty) and, when
 * present, in the source slot; the other slots were translated from it.
 *
 * - `description` and the source slot keep only the posting text (the PDF
 *   call or page body between the header line and the footers); the
 *   substituted bank paragraph leaves them empty.
 * - The source slot is rebuilt from the cleaned `description` when it was
 *   missing or wrapped.
 * - The translations made from the wrapped text are dropped and the job is
 *   flagged for retranslation.
 *
 * The runner's merge keeps existing fields, so without this they would
 * outlive the fix.
 *
 * @returns {boolean} true when the job carried the wrapper.
 */
export function dropBpsSuisseFabricatedText(job) {
  if (!job || typeof job !== 'object') return false;
  const sourceLang = String(job.sourceLang || '').trim() || 'it';
  const derived = dropTranslationsOfFabricatedSource(job, BPS_WRAPPER_RE);

  const cleanDescription = stripBpsWrapper(job.description);
  if (cleanDescription !== null) job.description = cleanDescription;

  const byLocale = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
    ? job.descriptionByLocale
    : null;
  // A wrapped source slot is the same text as the wrapped `description`
  // (sometimes with its newlines flattened): rebuild it from the cleaned
  // description when there is one, else strip it on its own.
  let cleanSlot = byLocale ? stripBpsWrapper(byLocale[sourceLang]) : null;
  if (cleanSlot !== null && cleanDescription) cleanSlot = cleanDescription;
  if (cleanSlot !== null) {
    if (cleanSlot) byLocale[sourceLang] = cleanSlot;
    else delete byLocale[sourceLang];
  }

  const changed = derived || cleanDescription !== null || cleanSlot !== null;
  if (changed && job.description && !String(byLocale?.[sourceLang] || '').trim()) {
    job.descriptionByLocale = { ...(byLocale || {}), [sourceLang]: job.description };
  }
  return changed;
}

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
 * Extract all job detail URLs from the BPS Suisse listing page.
 * Links follow the pattern: href="carriera-{slug}.php"
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string }[]}
 */
export function parseBpsSuisseListingPage(html = '') {
  if (!html) return [];

  const results = [];
  // Match links to career detail pages
  const linkPattern = /href="(carriera-[^"]+\.php)"[^>]*>([^<]*)</gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const relativeUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (relativeUrl && rawTitle) {
      results.push({
        url: `https://www.bps-suisse.ch/${relativeUrl}`,
        title: rawTitle,
      });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Extract job data from a BPS Suisse detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, pdfUrl: string } | null}
 */
export function parseBpsSuisseDetailPage(html = '') {
  if (!html) return null;

  // Extract title from <h2> or <h1>
  const titleMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Extract location — look for "Sede:" pattern
  const locationMatch = html.match(/Sede\s*:\s*([^<\n]+)/i);
  const location = locationMatch ? normalizeSpace(locationMatch[1]) : 'Lugano';

  // Extract body text from the main content area
  // Try to find the main article/content section
  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    body = stripHtml(contentMatch[1]);
  }

  // Extract PDF URL if present
  const pdfMatch = html.match(/href="([^"]*\.pdf)"/i);
  const pdfUrl = pdfMatch
    ? (pdfMatch[1].startsWith('http')
        ? pdfMatch[1]
        : `https://www.bps-suisse.ch/${pdfMatch[1].replace(/^\/+/, '')}`)
    : '';

  if (!title && !body) return null;

  return {
    title,
    body,
    location,
    pdfUrl,
    meetsMinLength: body.length >= MIN_BPS_FULL_DESC,
  };
}

/**
 * Deprecated legacy compatibility predicate retained for existing callers and
 * tests. The active BPS crawler does not use this Ticino-only helper.
 * @param {{ location?: string, canton?: string }} job
 * @returns {boolean}
 */
export function isTicinoBpsJob(job) {
  if (!job) return false;
  const loc = String(job.location || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  // BPS Suisse jobs in Lugano are always relevant
  const ticinoKeywords = ['lugano', 'ticino', 'ti', 'bellinzona', 'locarno', 'mendrisio', 'chiasso'];
  return (
    canton === 'ti' ||
    ticinoKeywords.some((kw) => loc.includes(kw))
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
