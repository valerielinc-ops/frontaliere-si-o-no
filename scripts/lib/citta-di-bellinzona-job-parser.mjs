/**
 * Città di Bellinzona — job listing parser
 *
 * Career page:
 *   https://www.bellinzona.ch/assunzioni
 *
 * HTML structure:
 *   Job postings are within table rows (<tr>) containing:
 *   - <h3> for position title
 *   - Publication date line (e.g., "Pubbl. 06.03.26")
 *   - Application deadline line (e.g., "Termine 27.03.2026 23:59")
 *   - "Bando di concorso" label with PDF download link
 *   - Online application form link at bellinz.pi-asp.de
 *
 * Application portal: bellinz.pi-asp.de/bewerber-web/
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('citta-di-bellinzona');

const CAREERS_URL = 'https://www.bellinzona.ch/assunzioni';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol|tr|td)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&agrave;/gi, 'à')
    .replace(/&egrave;/gi, 'è')
    .replace(/&igrave;/gi, 'ì')
    .replace(/&ograve;/gi, 'ò')
    .replace(/&ugrave;/gi, 'ù')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

export function slugify(value = '', suffix = '') {
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
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
  const t = title.trim().toLowerCase();
  if (/^concorso$/i.test(t)) return true;
  if (/^apprendistato$/i.test(t)) return true;
  if (/^bando$/i.test(t)) return true;
  if (t.length < 5) return true;
  return false;
}

/**
 * Parse date string from Bellinzona format (e.g., "06.03.26" or "27.03.2026").
 */
export function parseBellinzonaDate(dateStr = '') {
  const s = dateStr.trim();
  // Format: dd.mm.yy or dd.mm.yyyy
  const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return new Date().toISOString().split('T')[0];
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  let year = m[3];
  if (year.length === 2) year = `20${year}`;
  return `${year}-${month}-${day}`;
}

/**
 * Parse the Bellinzona assunzioni page HTML.
 * Returns array of job objects.
 */
export function parseBellinzonaListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Strategy 1: Look for h3 titles followed by date/deadline/PDF info
  const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;
  const h3Positions = [];

  while ((match = h3Re.exec(html)) !== null) {
    h3Positions.push({
      rawTitle: normalizeSpace(decodeHtmlEntities(stripHtml(match[1]))),
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  for (let i = 0; i < h3Positions.length; i++) {
    const { rawTitle, endIndex } = h3Positions[i];
    if (!rawTitle || rawTitle.length < 3) continue;

    const title = normalizeJobTitle(rawTitle);
    if (isTitleTooGeneric(title)) continue;

    // Extract context block after the h3 (up to next h3 or 2000 chars)
    const nextStart = i + 1 < h3Positions.length ? h3Positions[i + 1].index : endIndex + 2000;
    const contextBlock = html.slice(endIndex, Math.min(nextStart, endIndex + 2000));

    // Extract publication date
    const pubDateMatch = contextBlock.match(/Pubbl\.?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
    const datePosted = pubDateMatch ? parseBellinzonaDate(pubDateMatch[1]) : new Date().toISOString().split('T')[0];

    // Extract deadline
    const deadlineMatch = contextBlock.match(/Termine\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
    const deadline = deadlineMatch ? parseBellinzonaDate(deadlineMatch[1]) : null;

    // Extract PDF link (Bando di concorso)
    const pdfMatch = contextBlock.match(/href="([^"]*\.pdf[^"]*)"/i)
      || contextBlock.match(/href="([^"]*[Bb]ando[^"]*)"/i)
      || contextBlock.match(/href="([^"]*[Ss]carica[^"]*)"/i);
    const pdfUrl = pdfMatch ? new URL(pdfMatch[1], 'https://www.bellinzona.ch').href : null;

    // Extract apply URL (pi-asp.de)
    const applyMatch = contextBlock.match(/href="(https?:\/\/bellinz[^"]*pi-asp[^"]+)"/i);
    const applyUrl = applyMatch ? decodeHtmlEntities(applyMatch[1]) : null;

    const slug = slugify(title, 'bellinzona');
    const id = `citta-di-bellinzona-${slug}`;

    jobs.push({
      id,
      title,
      rawTitle,
      slug,
      datePosted,
      deadline,
      pdfUrl,
      applyUrl,
      url: applyUrl || pdfUrl || CAREERS_URL,
      location: 'Bellinzona',
      canton: HQ.canton,
    });
  }

  return jobs;
}

/**
 * Fetch and parse the Bellinzona careers page.
 */
export async function fetchBellinzonaJobs(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseBellinzonaListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Bellinzona careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
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
