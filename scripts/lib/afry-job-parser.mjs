/**
 * AFRY — JSON API job parser
 *
 * API: https://afry.com/en/api/afp-hr-smartrecruiteres-job-list
 *   Returns all global jobs as JSON: { Adverts: [...] }
 *   Each advert: { Id, Title, CompetenceAreas, Language, Location, Cities, Countries, LastApplyDate, DetailUrl }
 *
 * Detail pages: https://afry.com{DetailUrl}
 *   Description in HTML, apply link via SmartRecruiters
 */

import { isTicinoRelevant, isGrigioniRelevant, isTargetSwissLocation } from './target-swiss-locations.mjs';

const BASE_URL = 'https://afry.com';

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
 * Parse the global JSON API response and extract Swiss jobs.
 * @param {object} data - Parsed JSON from the API
 * @returns {{ items: Array }}
 */
export function parseAfryApiResponse(data = {}) {
  const adverts = data.Adverts || [];
  const swissJobs = adverts.filter((a) =>
    (a.Countries || []).some((c) => String(c.Id).toLowerCase() === 'ch'),
  );

  const items = swissJobs.map((a) => {
    const swissCities = (a.Cities || [])
      .filter((c) => String(c.CountryId).toLowerCase() === 'ch')
      .map((c) => c.Name);
    const competence = (a.CompetenceAreas || []).map((c) => c.Name).join(', ');
    return {
      id: String(a.Id),
      title: normalizeSpace(a.Title),
      cities: swissCities,
      location: swissCities.join(', ') || 'Switzerland',
      competenceArea: competence,
      language: a.Language || 'en',
      lastApplyDate: a.LastApplyDate || '',
      detailPath: a.DetailUrl || '',
      detailUrl: a.DetailUrl ? `${BASE_URL}${a.DetailUrl}` : '',
    };
  });

  return { items, totalGlobal: adverts.length, totalSwiss: items.length };
}

/**
 * Extract job description and apply URL from a detail page.
 * @param {string} html - Raw HTML of the detail page
 * @returns {{ description: string, applyUrl: string }}
 */
export function parseAfryDetailPage(html = '') {
  let description = '';

  // Description is in div.advert--description or in the main content paragraph
  const descMatch = html.match(
    /<div[^>]*class="[^"]*advert--description[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*advert--apply/i,
  );
  if (descMatch) {
    description = stripHtml(descMatch[1]);
  } else {
    // Fallback: extract from field--name-field-description or meta description
    const fieldMatch = html.match(
      /<div[^>]*class="[^"]*field--name-field-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (fieldMatch) {
      description = stripHtml(fieldMatch[1]);
    } else {
      const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
      if (metaMatch) {
        description = metaMatch[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'");
      }
    }
  }

  // Apply URL from SmartRecruiters link
  let applyUrl = '';
  const applyMatch = html.match(/href="(https:\/\/jobs\.smartrecruiters\.com\/AFRY\/[^"]+)"/i);
  if (applyMatch) {
    applyUrl = applyMatch[1];
  }

  return { description, applyUrl };
}

/**
 * Check if an AFRY Swiss job is Ticino/Grigioni relevant.
 */
export function isAfryTicinoRelevant(job = {}) {
  const cities = job.cities || [];
  const title = String(job.title || '').toLowerCase();
  const location = String(job.location || '').toLowerCase();
  const combined = `${title} ${location} ${cities.join(' ')}`.toLowerCase();

  // Direct city match for Ticino cities
  for (const city of cities) {
    if (isTicinoRelevant(city) || isGrigioniRelevant(city)) return true;
    if (isTargetSwissLocation(city)) return true;
  }

  // Keywords in title or location
  const ticinoKeywords = [
    'ticino', 'tessin', 'lugano', 'bellinzona', 'locarno', 'mendrisio',
    'chiasso', 'airolo', 'biasca', 'manno', 'stabio', 'rivera',
    'mezzovico', 'cadenazzo', 'giubiasco', 'gordola', 'muralto',
    'gottardo', 'san gottardo', 'gotthard',
    'chur', 'coira', 'grigioni', 'graubünden', 'graubunden',
    'poschiavo', 'bregaglia', 'mesolcina', 'calanca',
  ];

  return ticinoKeywords.some((kw) => combined.includes(kw));
}

/**
 * Infer canton from city name.
 */
export function inferAfryCanton(job = {}) {
  const cities = job.cities || [];
  const location = String(job.location || '').toLowerCase();
  const combined = `${location} ${cities.join(' ')}`.toLowerCase();

  if (/chur|coira|grigioni|graubünden|graubunden|poschiavo|bregaglia|mesolcina|calanca/i.test(combined)) return 'GR';
  return 'TI';
}

/**
 * Map competence area to a category.
 */
export function inferAfryCategory(competenceArea = '', title = '') {
  const haystack = `${competenceArea} ${title}`.toLowerCase();
  if (/civil|structural|geolog|underground|tunnel|bau/i.test(haystack)) return 'engineering';
  if (/electric|elektro|electrical|telecom/i.test(haystack)) return 'engineering';
  if (/mechanical|machine|maschin/i.test(haystack)) return 'engineering';
  if (/automation|robotics/i.test(haystack)) return 'engineering';
  if (/energy|power|renewable|wasserkraft|hydro/i.test(haystack)) return 'engineering';
  if (/environment|umwelt|ambiente/i.test(haystack)) return 'engineering';
  if (/digital|software|ict|it\b/i.test(haystack)) return 'it';
  if (/business|management|consulting/i.test(haystack)) return 'management';
  if (/project.*lead|projektleit|chef.*projet/i.test(haystack)) return 'management';
  if (/team.*lead|abteilung/i.test(haystack)) return 'management';
  if (/assistant|segretari|admin/i.test(haystack)) return 'admin';
  if (/life.*science|food|pharma/i.test(haystack)) return 'science';
  if (/water|wasser|acqua|abwasser/i.test(haystack)) return 'engineering';
  return 'engineering';
}

/**
 * Build localized content for an AFRY job.
 */
export function buildAfryLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || 'Switzerland').trim();
  const description = String(job.description || '').trim();

  const fallbackDesc = `AFRY cerca ${title} con sede a ${location}. Azienda internazionale di ingegneria, progettazione e consulenza con 18.000 collaboratori. Candidati online su afry.com.`;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: {
      it: description || fallbackDesc,
      en: description || fallbackDesc,
      de: description || fallbackDesc,
      fr: description || fallbackDesc,
    },
    slugByLocale: {
      it: slugify(`${title} afry ${location}`),
      en: slugify(`${title} afry ${location}`),
      de: slugify(`${title} afry ${location}`),
      fr: slugify(`${title} afry ${location}`),
    },
  };
}
