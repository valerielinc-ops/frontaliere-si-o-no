/**
 * Allianz Suisse — Umantis ATS parser
 *
 * Listing page: POST https://recruitingapp-2872.umantis.com/Jobs/All
 *   - Filter by Region Tessin: searchSkill1004=38999405
 *   - Jobs in <tr class="tableaslist_contentrow1|2">
 *     - Agency in <span class="tableaslist_element_1152486">
 *     - Title+link in <span class="tableaslist_element_1152488"> → <a href="/Vacancies/{ID}/Description/{lang}">
 *     - Location in <span class="tableaslist_element_1152495">
 *
 * Detail page: /Vacancies/{ID}/Description/4 (Italian)
 *   - og:title = job title
 *   - og:site_name = agency name
 *   - Commented-out keywords meta = title, agency, role, location, contract type
 *   - Body text: "Cosa ti proponiamo" + "Cosa ti chiediamo" + address block
 */

import { JSDOM } from 'jsdom';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const BASE_URL = 'https://recruitingapp-2872.umantis.com';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&eacute;/g, 'é')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&rtri;/g, '▸')
    .replace(/\u00b7/g, '·')
    .replace(/\u2013/g, '–')
    .replace(/\u2019/g, "'")
    .trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

const TICINO_CITIES = [
  'bellinzona', 'lugano', 'locarno', 'mendrisio', 'chiasso', 'muralto',
  'giubiasco', 'biasca', 'airolo', 'faido', 'paradiso', 'massagno',
  'viganello', 'manno', 'mezzovico', 'agno', 'magliaso', 'stabio',
  'balerna', 'riva san vitale', 'cadenazzo', 'gordola', 'ascona',
  'minusio', 'tenero', 'capolago', 'vacallo', 'grono',
];

const TICINO_AGENCIES = [
  'agenzia generale bellinzona',
  'agenzia generale lugano',
  'tessin',
];

/**
 * Parse the listing page HTML and return an array of { vacancyId, title, agency, location, detailUrl }
 */
export function parseAllianzListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const rows = [...document.querySelectorAll('tr.tableaslist_contentrow1, tr.tableaslist_contentrow2')];
  const results = [];
  const seen = new Set();

  for (const row of rows) {
    const agencySpan = row.querySelector('.tableaslist_element_1152486');
    const titleSpan = row.querySelector('.tableaslist_element_1152488');
    const locationSpan = row.querySelector('.tableaslist_element_1152495');

    if (!titleSpan) continue;

    const anchor = titleSpan.querySelector('a[href*="/Vacancies/"]');
    if (!anchor) continue;

    const href = String(anchor.getAttribute('href') || '');
    const idMatch = href.match(/\/Vacancies\/(\d+)\//);
    if (!idMatch) continue;

    const vacancyId = idMatch[1];
    if (seen.has(vacancyId)) continue;
    seen.add(vacancyId);

    const title = normalizeSpace(anchor.textContent || '');
    const agency = normalizeSpace(agencySpan?.textContent || '');
    const locationText = normalizeSpace(locationSpan?.textContent || '').replace(/^\s*\|?\s*Arbeitsort:\s*/i, '');

    results.push({
      vacancyId,
      title,
      agency,
      location: locationText,
      detailUrl: `${BASE_URL}/Vacancies/${vacancyId}/Description/4`,
      applyUrl: `${BASE_URL}/Vacancies/${vacancyId}/Application/CheckLogin/4`,
    });
  }

  return results;
}

/**
 * Parse a detail page (Italian) and extract rich metadata.
 */
export function parseAllianzDetailPage(html = '', fallbackTitle = '', fallbackLocation = '') {
  const document = new JSDOM(html).window.document;

  // og:title
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
  // og:site_name = agency name
  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '';

  // <title> = "Job Title -- DE"
  const rawTitle = document.querySelector('title')?.textContent || '';
  const cleanTitle = rawTitle.replace(/\s*--\s*DE\s*$/i, '').trim();

  const title = normalizeSpace(ogTitle || cleanTitle || fallbackTitle);

  // Commented-out keywords meta: extract location + contract type
  let keywordsLocation = '';
  let contractType = '';
  const htmlText = html;
  const kwMatch = htmlText.match(/<!--\s*<meta name="keywords"\s+content="([^"]+)"/);
  if (kwMatch) {
    const parts = kwMatch[1].split(',').map((s) => s.trim());
    // Pattern: title, agency, role, location, contract-level, contract-type
    if (parts.length >= 4) {
      keywordsLocation = parts[parts.length - 3] || '';
      contractType = parts[parts.length - 1] || '';
    }
  }

  // Extract description text from the body
  const bodyHtml = html;
  let description = '';

  // Try to find the main content area (Allianz template uses table-based email-style HTML)
  const contentMatch = bodyHtml.match(/<td[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/td>/i) ||
    bodyHtml.match(/<div[^>]*class="[^"]*vacancy[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    description = stripHtml(contentMatch[1]);
  } else {
    // Fallback: extract all meaningful text between "Cosa ti proponiamo" and footer
    const stripped = stripHtml(bodyHtml);
    const startIdx = stripped.search(/Cosa ti (proponiamo|offriamo)|Was wir (dir bieten|Ihnen bieten)|What we offer/i);
    if (startIdx > -1) {
      const endIdx = stripped.indexOf('Ulteriori informazioni', startIdx);
      description = (endIdx > -1 ? stripped.slice(startIdx, endIdx) : stripped.slice(startIdx, startIdx + 3000)).trim();
    } else {
      // Last resort: look for substantial text blocks
      const lines = stripped.split('\n').filter((l) => l.trim().length > 40);
      description = lines.slice(0, 15).join('\n').trim();
    }
  }

  // Clean up description
  description = description
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim()
    .slice(0, 5000);

  // Extract address from body (e.g. "Piazza del Sole\n6500 Bellinzona")
  let locationFromBody = '';
  const postalMatch = description.match(/(\d{4})\s+([\p{L}\s]+?)(?:\s|$)/u);
  if (postalMatch) {
    const postalCode = postalMatch[1];
    const city = postalMatch[2].trim();
    if (/^6[5-9]\d{2}$/.test(postalCode) || /^7\d{3}$/.test(postalCode)) {
      locationFromBody = city;
    }
  }

  const location = normalizeSpace(locationFromBody || keywordsLocation || fallbackLocation);

  return {
    title,
    agency: normalizeSpace(ogSiteName),
    location,
    description,
    contractType: normalizeSpace(contractType),
  };
}

/**
 * Check if a job is relevant (Ticino or Grigioni) based on agency, location, or keywords.
 * Returns the canton code ('TI' or 'GR') if relevant, or '' if not.
 */
export function inferAllianzCanton(agency = '', location = '') {
  const signal = `${agency} ${location}`;
  const canton = inferSwissTargetCanton(signal);
  if (canton) return canton;

  // Extra agency-level checks for Allianz-specific naming
  const agencyLow = agency.toLowerCase();
  for (const a of TICINO_AGENCIES) {
    if (agencyLow.includes(a)) return 'TI';
  }

  return '';
}

/**
 * @deprecated Use inferAllianzCanton() instead. Kept for backward compatibility.
 */
export function isAllianzTicinoRelevant(agency = '', location = '') {
  return inferAllianzCanton(agency, location) !== '';
}

/**
 * Build localized content for a job.
 */
export function buildAllianzLocalizedContent(job) {
  const title = normalizeSpace(job.title);
  const description = normalizeSpace(job.description);
  const slug = slugify(title);

  // All Ticino Allianz jobs are published in Italian
  const titleByLocale = { it: title, en: title, de: title, fr: title };
  const descriptionByLocale = { it: description, en: '', de: '', fr: '' };
  const slugByLocale = { it: slug, en: slug, de: slug, fr: slug };

  return { titleByLocale, descriptionByLocale, slugByLocale };
}
