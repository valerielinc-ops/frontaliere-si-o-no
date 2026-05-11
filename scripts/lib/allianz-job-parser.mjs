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
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { titleOverlap, MIN_TITLE_OVERLAP } from './title-utils.mjs';

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
    .replace(/<li[^>]*>/gi, '\n• ')
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
 * Return true if a title string is generic or consists solely of the site name.
 * @param {string} title
 * @param {string} siteName
 */
function isGenericTitle(title, siteName) {
  if (!title || title.length < 4) return true;
  if (siteName && normalizeSpace(title.toLowerCase()) === normalizeSpace(siteName.toLowerCase())) return true;
  return false;
}

/**
 * Parse a detail page (Italian) and extract rich metadata.
 *
 * Title extraction priority:
 *   1. First `h1` in the page body (most reliable on Umantis detail pages)
 *   2. `og:title` meta tag — validated against h1 with overlap guard
 *   3. `<title>` tag — strip " -- {anything}" suffix (Umantis format)
 *   4. fallbackTitle from listing page
 *
 * Overlap guard: if og:title diverges significantly from the h1 (overlap < 0.7),
 * the h1 is preferred as the authoritative source.
 */
export function parseAllianzDetailPage(html = '', fallbackTitle = '', fallbackLocation = '') {
  const document = new JSDOM(html).window.document;

  // og:site_name = agency name
  const ogSiteName = normalizeSpace(
    document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || ''
  );

  // 1. h1 from page body — most reliable on Umantis detail pages
  const h1El = document.querySelector('h1');
  const h1Title = h1El ? normalizeSpace(h1El.textContent || '') : '';

  // 2. og:title meta tag
  const ogTitle = normalizeSpace(
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''
  );

  // 3. <title> tag — Umantis format: "Job Title -- {SiteName}" or "Job Title -- DE"
  //    Strip everything from " --" onwards to get the bare vacancy title.
  const rawPageTitle = document.querySelector('title')?.textContent || '';
  const cleanPageTitle = normalizeSpace(rawPageTitle.replace(/\s*--\s*.+$/, '').trim());

  // Resolve: prefer h1 when non-generic; validate og:title against h1 with overlap guard
  let title = '';
  if (!isGenericTitle(h1Title, ogSiteName)) {
    // h1 is available and specific — use it as the ground truth
    if (!isGenericTitle(ogTitle, ogSiteName) && titleOverlap(ogTitle, h1Title) >= MIN_TITLE_OVERLAP) {
      // og:title agrees with h1 → og:title is usually cleaner (no extra noise from DOM)
      title = ogTitle;
    } else {
      // og:title absent or diverges from h1 → h1 wins
      title = h1Title;
    }
  } else if (!isGenericTitle(ogTitle, ogSiteName)) {
    title = ogTitle;
  } else if (!isGenericTitle(cleanPageTitle, ogSiteName)) {
    title = cleanPageTitle;
  } else {
    title = fallbackTitle;
  }

  title = normalizeSpace(title || fallbackTitle);

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
  const canton = inferAnyCanton(signal);
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
  let description = normalizeSpace(job.description);
  const slug = slugify(title);
  const location = normalizeSpace(job.location) || 'Ticino';

  // If description is thin (<50 words), enrich with company context
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) {
    const agencyText = job.agency ? ` presso l'${job.agency}` : '';
    description = [
      description || `${title} — Allianz Suisse${agencyText}, ${location}.`,
      `Allianz Suisse è una delle principali compagnie assicurative in Svizzera, parte del gruppo Allianz, leader mondiale nel settore assicurativo e della gestione patrimoniale. Con una rete capillare di agenzie generali in tutto il Paese, Allianz Suisse offre soluzioni assicurative complete per privati e aziende nei settori vita, non vita e previdenza professionale. L'azienda si distingue per l'attenzione al cliente, la consulenza personalizzata e un ambiente di lavoro dinamico con opportunità di crescita professionale e formazione continua. Sede regionale in Ticino con agenzie a Bellinzona e Lugano.`,
      `Candidati online tramite il portale recruitingapp-2872.umantis.com.`,
    ].join('\n');
  }

  // All Ticino Allianz jobs are published in Italian
  const titleByLocale = { it: title, en: title, de: title, fr: title };
  const descriptionByLocale = { it: description, en: '', de: '', fr: '' };
  const slugByLocale = { it: slug, en: slug, de: slug, fr: slug };

  return { titleByLocale, descriptionByLocale, slugByLocale };
}
