/**
 * MTIC Group / SPS InterCert S.A. — TYPO3 CMS careers page parser
 *
 * Listing page: https://www.mtic-group.org/it/opportunita-di-lavoro
 *   - Jobs organized by subsidiary in <h3> headers inside fce-2-col sections
 *   - Swiss subsidiary: "SPS InterCert S.A. | Lugano Paradiso - Switzerland"
 *   - Job links in <ul><li><a href="..."> within each section
 *   - Links go to main domain or subdomain (mticintercertsrl.mtic-group.org, spsintercertsa.mtic-group.org)
 *
 * Detail pages: /it/opportunita-di-lavoro/open-position-{slug}
 *   - Title in <h2>
 *   - Full HTML description in content body
 *   - No JSON-LD JobPosting (TYPO3 plain content)
 *   - Location may be mentioned in description text (e.g., "Rho (MI)", "Lugano")
 */

import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const BASE_URL = 'https://www.mtic-group.org';

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
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
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

/**
 * Parse the listing page and extract jobs grouped by subsidiary.
 * Returns all jobs with their subsidiary info for later filtering.
 */
export function parseMticListingPage(html = '') {
  const document = new JSDOM(html).window.document;

  // Each subsidiary section is a fce-2-col with left=<h3> and right=job list
  const sections = [...document.querySelectorAll('.fce-2-col')];
  const results = [];
  const seen = new Set();

  for (const section of sections) {
    const h3 = section.querySelector('h3');
    if (!h3) continue;
    const sectionTitle = normalizeSpace(h3.textContent);

    // Determine subsidiary and location from section header
    const subsidiary = extractSubsidiary(sectionTitle);

    // Get all job links from this section
    const anchors = [...section.querySelectorAll('a[href*="/opportunita-di-lavoro/"], a[href*="/job-opportunities/"]')];
    for (const a of anchors) {
      let href = String(a.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;

      // Resolve relative URLs
      if (href.startsWith('/')) {
        href = `${BASE_URL}${href}`;
      } else if (!href.startsWith('http')) {
        href = `${BASE_URL}/${href}`;
      }

      // Deduplicate by URL
      const normalized = href.toLowerCase().replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const title = normalizeSpace(a.textContent);
      if (!title) continue;

      results.push({
        title,
        detailUrl: href,
        subsidiary: subsidiary.name,
        subsidiaryLocation: subsidiary.location,
        subsidiaryCountry: subsidiary.country,
        sectionTitle,
      });
    }
  }

  return results;
}

/**
 * Extract subsidiary name, location, and country from section header text.
 * Examples:
 *   "MTIC InterCert S.r.l. | Rho (MI) / Fiume Veneto (PN)" → Italy
 *   "SPS InterCert S.A. | Lugano Paradiso - Switzerland" → Switzerland/TI
 *   "InterCert GmbH - Group of MTIC - | Bonn - Germany" → Germany
 *   "MTIC Group | Sedi Internazionali" → International
 */
function extractSubsidiary(headerText = '') {
  const text = normalizeSpace(headerText);

  if (/SPS\s+InterCert/i.test(text) || /Lugano|Paradiso|Switzerland|Svizzera|Schweiz/i.test(text)) {
    return { name: 'SPS InterCert S.A.', location: 'Lugano Paradiso', country: 'CH' };
  }
  if (/MTIC\s+InterCert.*S\.?r\.?l/i.test(text) || /Rho.*MI|Fiume\s+Veneto/i.test(text)) {
    return { name: 'MTIC InterCert S.r.l.', location: 'Rho (MI)', country: 'IT' };
  }
  if (/InterCert\s+GmbH/i.test(text) || /Bonn.*Germany|Germania/i.test(text)) {
    return { name: 'InterCert GmbH', location: 'Bonn', country: 'DE' };
  }
  if (/MTIC\s+Academy/i.test(text)) {
    return { name: 'MTIC Academy Sagl', location: 'Lugano', country: 'CH' };
  }
  return { name: 'MTIC Group', location: '', country: '' };
}

/**
 * Parse a job detail page and extract title, description, location.
 * MTIC uses plain TYPO3 content — no JSON-LD JobPosting.
 */
export function parseMticDetailPage(html = '', fallbackTitle = '') {
  const document = new JSDOM(html).window.document;

  // Title from <h2> in content
  const h2 = document.querySelector('.content_main h2');
  const title = normalizeSpace(h2?.textContent || '') || fallbackTitle;

  // Description from main content area
  const contentMain = document.querySelector('.content_main');
  let descriptionHtml = '';
  if (contentMain) {
    // Grab all text blocks, excluding navigation
    const textBlocks = [...contentMain.querySelectorAll('.frame-type-text, .frame-type-textpic')];
    descriptionHtml = textBlocks
      .map((block) => block.innerHTML || '')
      .join('\n');
  }
  const description = stripHtml(descriptionHtml);

  // Try to extract location from description text
  const location = extractLocationFromText(description);

  // Date — TYPO3 pages don't have explicit dates; use today
  const datePosted = new Date().toISOString().slice(0, 10);

  return { title, location, description, datePosted };
}

/**
 * Try to extract a location mention from job description text.
 * Looks for patterns like "sede a Lugano", "Rho (MI)", "Paradiso", etc.
 */
function extractLocationFromText(text = '') {
  // Swiss Ticino locations
  const tiMatch = text.match(
    /\b(Lugano(?:\s+Paradiso)?|Paradiso|Massagno|Bellinzona|Locarno|Mendrisio|Chiasso|Manno|Bioggio|Lamone|Mezzovico|Agno|Rivera|Magliaso)\b/i,
  );
  if (tiMatch) return tiMatch[1];

  // Other Swiss locations
  const chMatch = text.match(
    /\b(Zurigo|Zürich|Ginevra|Genève|Berna|Bern|Basilea|Basel|Losanna|Lausanne|Lucerna|Luzern)\b/i,
  );
  if (chMatch) return chMatch[1];

  // Italian locations in description
  const itMatch = text.match(/\b(Rho\s*\(?MI\)?|Fiume\s+Veneto\s*\(?PN\)?|Milano|Roma|Torino)\b/i);
  if (itMatch) return itMatch[1];

  return '';
}

/**
 * Build localized content for an MTIC Group job.
 */
export function buildMticLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Lugano Paradiso';
  const description = String(job.description || '').trim();

  const itDesc = description
    || `MTIC Group / SPS InterCert S.A. ricerca ${title} con sede a ${location}. Certificazioni, ispezioni e prove nel settore tecnico. Candidati tramite il sito ufficiale MTIC Group.`;
  const enDesc = `MTIC Group / SPS InterCert S.A. is hiring for the ${title} role based in ${location}. Certifications, inspections and testing in technical sectors. Apply through the official MTIC Group careers page.`;
  const deDesc = `MTIC Group / SPS InterCert S.A. sucht derzeit für die Position ${title} am Standort ${location}. Zertifizierungen, Inspektionen und Prüfungen im technischen Bereich. Bewirb dich über die offizielle MTIC Group Karriereseite.`;
  const frDesc = `MTIC Group / SPS InterCert S.A. recrute actuellement pour le poste ${title} basé à ${location}. Certifications, inspections et essais dans les secteurs techniques. Postulez via le site officiel de MTIC Group.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} mtic-group ${location}`),
      en: slugify(`${title} mtic-group ${location}`),
      de: slugify(`${title} mtic-group ${location}`),
      fr: slugify(`${title} mtic-group ${location}`),
    },
  };
}

/**
 * Check whether a job is relevant to Ticino/Swiss cross-border area.
 * Primary: Swiss subsidiary (SPS InterCert S.A. in Lugano Paradiso)
 * Secondary: any job with Swiss location mentioned
 */
export function isMticTicinoRelevant(job = {}) {
  // Swiss subsidiary jobs are always relevant
  if (job.subsidiaryCountry === 'CH') return true;

  // Check location string
  const loc = normalizeSpace(job.location || job.subsidiaryLocation || '').toLowerCase();
  if (!loc) return false;

  return isTargetSwissLocation(loc);
}
