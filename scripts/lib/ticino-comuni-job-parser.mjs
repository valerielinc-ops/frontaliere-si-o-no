/**
 * Testo condiviso dai crawler comunali ticinesi.
 *
 * Generalizzati da citta-di-bellinzona-job-parser.mjs, che continua a
 * esportarli: la famiglia `comune-di-*` e Bellinzona usano lo stesso codice e
 * non possono divergere. Il modulo e' puro apposta: i parser lo importano senza
 * tirarsi dietro il template dei crawler.
 */
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function slugify(value = '', suffix = '') {
  const MAX_LEN = 90;
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    // Reserve room for the suffix so the combined slug fits MAX_LEN.
    const reserved = suffix.length + 1; // +1 for joining '-'
    const headroom = Math.max(1, MAX_LEN - reserved);
    s = `${truncateSlugAtWordBoundary(s, headroom)}-${suffix}`.replace(/--+/g, '-');
  }
  return truncateSlugAtWordBoundary(s, MAX_LEN);
}

/**
 * Normalize a municipal job title: strip leading quantities and generic prefixes.
 */
export function normalizeJobTitle(rawTitle = '') {
  let t = normalizeSpace(rawTitle);
  if (!t) return t;
  // Strip "Concorso per l'assunzione di" prefix (must be first)
  t = t.replace(/^concorso\s+per\s+l['']assunzione\s+di\s+/i, '');
  // Strip leading number prefix (e.g., "1 ", "3 ")
  t = t.replace(/^\d+\s+/, '');
  // Strip "Cercansi" prefix
  t = t.replace(/^cercansi\s+/i, '');
  // Strip "un/a", "un/una", "un o una/un" prefixes
  t = t.replace(/^un\/a\s+/i, '');
  t = t.replace(/^un\s*\/?\s*una?\s+/i, '');
  t = t.replace(/^un\s+o\s+un[ao]?\s+/i, '');
  // Capitalize first letter
  if (t.length > 0) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t;
}

/**
 * Check if a title is too generic to be useful.
 */
export function isTitleTooGeneric(title = '') {
  const t = String(title || '').trim().toLowerCase();
  if (/^concorso$/i.test(t)) return true;
  if (/^apprendistato$/i.test(t)) return true;
  if (/^bando$/i.test(t)) return true;
  if (t.length < 5) return true;
  return false;
}

/**
 * Parse the numeric dd.mm.yy / dd.mm.yyyy date of the municipal pages.
 * Returns '' for anything that is not a real calendar date.
 */
export function parseMunicipalDate(dateStr = '') {
  const s = String(dateStr || '').trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/);
  if (!m) return '';
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  let year = m[3];
  if (year.length === 2) year = `20${year}`;
  const iso = `${year}-${month}-${day}`;
  const calendar = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== iso) return '';
  return iso;
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
