/**
 * Hoval — SAP Hybris job parser
 *
 * Listing API: https://www.hoval.it/jobs/results?q=:sortIndex:country:Switzerland
 *   - Returns JSON with { results: [...], pagination: {...} }
 *   - Each result: { jobDescription, country, location, language, department, link }
 *
 * Detail page: https://www.hoval.it/it_IT/job/{id}
 *   - Description in <div class="o-richtext o-richtext--large-article">
 *   - Apply URL in <a> with href to recruitingapp-2710.umantis.com
 */

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';

const BASE_URL = 'https://www.hoval.it';

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
    .replace(/\n{3,}/g, '\n\n')
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
 * Parse the JSON API response for Swiss job listings.
 * @param {object} json - The parsed JSON from /jobs/results?q=:sortIndex:country:Switzerland
 * @returns {{ items: Array, totalResults: number }}
 */
export function parseHovalListingJson(json = {}) {
  const results = json?.results || [];
  const totalResults = json?.pagination?.totalNumberOfResults || results.length;

  const items = results
    .filter((r) => r?.jobDescription && r?.link)
    .map((r) => {
      const jobId = String(r.link || '').replace(/^\/job\//, '');
      return {
        title: normalizeSpace(r.jobDescription),
        jobId,
        detailUrl: `${BASE_URL}/it_IT/job/${jobId}`,
        location: normalizeSpace(r.location || ''),
        country: normalizeSpace(r.country || ''),
        department: normalizeSpace(r.department || ''),
        language: normalizeSpace(r.language || ''),
      };
    });

  return { items, totalResults };
}

/**
 * Extract job description and apply URL from a Hoval detail page.
 * @param {string} html - Raw HTML of the detail page
 * @returns {{ description: string, applyUrl: string }}
 */
export function parseHovalDetailPage(html = '') {
  // Extract description from o-richtext blocks (there are typically 2: description + contact)
  const descBlocks = [];
  const richTextRegex = /<div\s+class="o-richtext\s+o-richtext--large-article[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let match;
  while ((match = richTextRegex.exec(html)) !== null) {
    const content = stripHtml(match[1]);
    // Skip contact/address blocks (short, contain typical address patterns)
    if (content.length > 80) {
      descBlocks.push(content);
    }
  }
  const description = descBlocks.join('\n\n');

  // Extract apply URL (umantis.com)
  let applyUrl = '';
  const applyMatch = html.match(/href="(https:\/\/recruitingapp[^"]+)"/);
  if (applyMatch) {
    applyUrl = applyMatch[1];
  }

  return { description, applyUrl };
}

/**
 * Build localized content for a Hoval job.
 */
export function buildHovalLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Svizzera';
  const description = String(job.description || '').trim();
  const department = String(job.department || '').trim();

  const deptClause = department ? ` nel reparto ${department}` : '';
  const itDesc = description
    || `Hoval ha aperto una selezione per il ruolo ${title}${deptClause} con sede a ${location}. Soluzioni di riscaldamento e climatizzazione all'avanguardia. Per candidarti utilizza il modulo ufficiale nella pagina Hoval.`;
  const enDesc = description
    ? description
    : `Hoval is hiring for the ${title} role based in ${location}. Leading heating and climate technology solutions. Apply through the official Hoval careers page.`;
  const deDesc = description
    ? description
    : `Hoval sucht derzeit für die Position ${title} am Standort ${location}. Führende Heiz- und Klimatechniklösungen. Bewirb dich über die offizielle Karriereseite von Hoval.`;
  const frDesc = description
    ? description
    : `Hoval recrute actuellement pour le poste ${title} basé à ${location}. Solutions de chauffage et de climatisation de pointe. Postulez via la page carrière officielle de Hoval.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: itDesc, en: enDesc, de: deDesc, fr: frDesc },
    slugByLocale: {
      it: slugify(`${title} hoval ${location}`),
      en: slugify(`${title} hoval ${location}`),
      de: slugify(`${title} hoval ${location}`),
      fr: slugify(`${title} hoval ${location}`),
    },
  };
}

/**
 * Check whether a location string is relevant to any target canton.
 */
export function isHovalTicinoRelevant(location = '') {
  const loc = normalizeSpace(location);
  if (!loc) return false;
  return isTargetSwissLocation(loc);
}

/**
 * Infer canton code from a location string via the BFS municipality dataset.
 */
export function inferHovalCanton(location = '') {
  return inferAnyCanton(normalizeSpace(location)) || 'CH';
}
