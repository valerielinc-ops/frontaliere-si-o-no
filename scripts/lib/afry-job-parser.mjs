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

import { isTargetSwissLocation, inferAnyCanton } from './target-swiss-locations.mjs';

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
    .replace(/<li[^>]*>/gi, '\n• ')
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
 * Tries the afry.com detail page first, then falls back to SmartRecruiters.
 * @param {string} html - Raw HTML of the detail page
 * @returns {{ description: string, applyUrl: string }}
 */
export function parseAfryDetailPage(html = '') {
  let description = '';

  // Primary: job description in div.advert--body (contains h3 sections + paragraphs)
  const bodyMatch = html.match(
    /<div[^>]*class="[^"]*advert--body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*additional--info/i,
  );
  if (bodyMatch) {
    description = stripHtml(bodyMatch[1]);
  }

  // Fallback: older layout used advert--description
  if (!description) {
    const descMatch = html.match(
      /<div[^>]*class="[^"]*advert--description[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*advert--apply/i,
    );
    if (descMatch) {
      description = stripHtml(descMatch[1]);
    }
  }

  // Fallback: field--name-field-description or meta description
  if (!description) {
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
 * Parse a SmartRecruiters job detail page for AFRY.
 *
 * SmartRecruiters pages use standard HTML sections with h2 headings
 * and paragraph/list content. The description sections typically include:
 *   - "Descrizione del lavoro" / "Job Description"
 *   - "COMPITI" / "Tasks" / "Responsibilities"
 *   - "Qualifiche" / "Qualifications"
 *   - "Informazioni aggiuntive" / "What we offer"
 *
 * @param {string} html - Raw HTML of the SmartRecruiters page
 * @returns {string} Extracted description text
 */
export function parseSmartRecruitersPage(html = '') {
  // Narrow to main content area first to avoid sidebar "similar jobs" contamination.
  const mainAreaMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<section[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  const searchArea = mainAreaMatch ? mainAreaMatch[1] : html;

  // Strategy 1: Extract section-by-section using h2 headings
  const sections = [];
  const sectionRegex = /<h2>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2>|<footer|<div[^>]*class="[^"]*footer|$)/gi;
  let match;
  const skipHeadings = /apply|candidat|share|condivid|teilen|partag|similar|simil/i;

  while ((match = sectionRegex.exec(searchArea)) !== null) {
    const heading = stripHtml(match[1]).trim();
    if (!heading || heading.length > 100 || skipHeadings.test(heading)) continue;

    const content = stripHtml(match[2]).trim();
    if (!content || content.length < 15) continue;
    sections.push(`## ${heading}\n${content}`);
  }

  if (sections.length > 0) {
    const text = sections.join('\n\n');
    if (text.split(/\s+/).length >= 50) return text;
  }

  // Strategy 2: Extract all content from the main body
  const bodyMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (bodyMatch) {
    const text = stripHtml(bodyMatch[1]).trim();
    if (text.split(/\s+/).length >= 50) return text;
  }

  // Strategy 3: Extract all substantial paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = pRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]).trim();
    if (text.length > 30) paragraphs.push(text);
  }
  // Also extract list items
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((match = liRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]).trim();
    if (text.length > 10) paragraphs.push(`- ${text}`);
  }

  if (paragraphs.length > 0) {
    const text = paragraphs.join('\n');
    if (text.split(/\s+/).length >= 50) return text;
  }

  return '';
}

/**
 * Check if an AFRY Swiss job is in any target canton.
 */
export function isAfryTicinoRelevant(job = {}) {
  const cities = job.cities || [];
  const title = String(job.title || '').toLowerCase();
  const location = String(job.location || '').toLowerCase();
  return isTargetSwissLocation(`${title} ${location} ${cities.join(' ')}`);
}

/**
 * Infer canton from city name via the BFS municipality dataset.
 */
export function inferAfryCanton(job = {}) {
  const cities = job.cities || [];
  const location = String(job.location || '').toLowerCase();
  return inferAnyCanton(`${location} ${cities.join(' ')}`);
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
  const competence = String(job.competenceArea || '').trim();

  // Use the crawled description only if it has enough content (>= 50 words)
  const descWordCount = description ? description.split(/\s+/).length : 0;
  const hasRichDescription = descWordCount >= 50;

  // Build a rich fallback that includes job-specific context (always >= 50 words)
  const competenceLine = competence ? ` nell'area ${competence}` : '';
  const fallbackDesc = [
    `AFRY cerca ${title} con sede a ${location}${competenceLine}.`,
    `AFRY è un'azienda internazionale leader nel settore dell'ingegneria, della progettazione e della consulenza, con oltre 19.000 collaboratori in tutto il mondo.`,
    `L'azienda offre servizi di ingegneria, gestione di progetti e consulenza a supporto della transizione energetica e industriale.`,
    `AFRY combina una presenza internazionale con competenze locali specializzate nei settori dell'energia, delle infrastrutture, dell'industria e della digitalizzazione.`,
    `In Svizzera, AFRY è attiva in progetti complessi per mobilità, opere civili, impianti tecnici, tunnel e transizione energetica, con sedi a Zurigo, Bellinzona e Airolo.`,
    `Offriamo un contesto tecnico multidisciplinare, clienti di primo piano, formazione continua e percorsi di crescita professionale.`,
    `Candidati online su afry.com.`,
  ].join(' ');

  // If the crawled description is rich enough, prepend a meta line; otherwise use fallback
  const finalDesc = hasRichDescription
    ? `${title} — AFRY, ${location}.\n\n${description}`
    : fallbackDesc;

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: {
      it: finalDesc,
      en: finalDesc,
      de: finalDesc,
      fr: finalDesc,
    },
    slugByLocale: {
      it: slugify(`${title} afry ${location}`),
      en: slugify(`${title} afry ${location}`),
      de: slugify(`${title} afry ${location}`),
      fr: slugify(`${title} afry ${location}`),
    },
  };
}
