/**
 * Città di Locarno — job listing parser
 *
 * Career page:
 *   https://www.locarno.ch/it/albo-comunale/assunzioni-personale
 *
 * HTML structure:
 *   Job postings are within <li> elements containing:
 *   - Date paragraph (e.g., "13.03.2026")
 *   - Link to PDF with the job title as anchor text
 *   - Optional "Candidatura online" application link
 *   - File size indicator with download icon
 *
 * Pattern:
 *   <li>
 *     <p>DATE</p>
 *     <p><a href="PDF_URL">Job Title</a><br/>↳ <a href="APP_URL">Candidatura online</a></p>
 *     <p><a href="PDF_URL"><img/>SIZE</a></p>
 *   </li>
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('citta-di-locarno');

const CAREERS_URL = 'https://www.locarno.ch/it/albo-comunale/assunzioni-personale';
const CAREERS_BASE = 'https://www.locarno.ch';
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
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
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
    s = `${s.slice(0, headroom).replace(/-+$/, '')}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, MAX_LEN);
}

/**
 * Normalize a municipal job title.
 */
export function normalizeJobTitle(rawTitle = '') {
  let t = normalizeSpace(rawTitle);
  if (!t) return t;
  // Strip "Concorso per l'assunzione di" prefix
  t = t.replace(/^concorso\s+per\s+l['']assunzione\s+di\s+/i, '');
  // Strip leading number prefix
  t = t.replace(/^\d+\s+/, '');
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
 * Check if a title is too generic.
 */
export function isTitleTooGeneric(title = '') {
  const t = title.trim().toLowerCase();
  if (/^concorso$/i.test(t)) return true;
  if (/^bando$/i.test(t)) return true;
  if (t.length < 5) return true;
  return false;
}

/**
 * Parse a date string from Locarno format (e.g., "13.03.2026").
 */
export function parseLocarnoDate(dateStr = '') {
  const s = dateStr.trim();
  const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return new Date().toISOString().split('T')[0];
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Parse the Locarno assunzioni page HTML.
 * Returns array of job objects.
 */
export function parseLocarnoListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Split into <li> blocks
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = liRe.exec(html)) !== null) {
    const block = match[1];

    // Extract date
    const dateMatch = block.match(/>(\d{1,2}\.\d{1,2}\.\d{4})</);
    if (!dateMatch) continue;
    const datePosted = parseLocarnoDate(dateMatch[1]);

    // Extract PDF link and title
    // The title is the anchor text of the first link (which points to a PDF)
    const pdfLinkMatch = block.match(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!pdfLinkMatch) continue;

    const pdfHref = pdfLinkMatch[1];
    const rawTitle = normalizeSpace(decodeHtmlEntities(stripHtml(pdfLinkMatch[2])));

    // Skip download size links (e.g., "0.2 MB") and image-only links
    if (!rawTitle || rawTitle.length < 5) continue;
    if (/^\d+(\.\d+)?\s*[KMG]?B$/i.test(rawTitle)) continue;
    if (/icon_download/i.test(pdfLinkMatch[0])) continue;

    const title = normalizeJobTitle(rawTitle);
    if (isTitleTooGeneric(title)) continue;

    // Build full PDF URL
    const pdfUrl = pdfHref.startsWith('http')
      ? pdfHref
      : new URL(pdfHref, CAREERS_BASE).href;

    // Extract application URL (Candidatura online)
    const applyMatch = block.match(/<a\s+[^>]*href="([^"]*)"[^>]*>[^<]*[Cc]andidatura[^<]*<\/a>/i);
    const applyUrl = applyMatch
      ? (applyMatch[1].startsWith('http') ? applyMatch[1] : new URL(applyMatch[1], CAREERS_BASE).href)
      : null;

    const slug = slugify(title, 'locarno');
    const id = `citta-di-locarno-${slug}`;

    jobs.push({
      id,
      title,
      rawTitle,
      slug,
      datePosted,
      pdfUrl,
      applyUrl,
      url: applyUrl || pdfUrl || CAREERS_URL,
      location: 'Locarno',
      canton: HQ.canton,
    });
  }

  return jobs;
}

/**
 * Fetch and parse the Locarno careers page.
 */
export async function fetchLocarnoJobs(timeoutMs = 15000) {
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
    return parseLocarnoListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Locarno careers page: ${err.message}`);
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
