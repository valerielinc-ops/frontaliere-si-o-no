import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * AFRY — JSON API job parser
 *
 * API: https://afry.com/en/api/afp-hr-smartrecruiteres-job-list
 *   Returns all global jobs as JSON: { Adverts: [...] }
 *   Each advert: { Id, Title, CompetenceAreas, Language, Location, Cities, Countries, LastApplyDate, DetailUrl }
 *
 * AFRY is a national engineering/consulting firm: we keep ALL Swiss jobs
 * (country=CH) across every canton, resolving the canton per job from the
 * cleanest single city signal. No regional pre-filter.
 *
 * Detail pages: https://afry.com{DetailUrl}
 *   Description in HTML, apply link via SmartRecruiters
 */

import { inferAnyCanton } from './target-swiss-locations.mjs';
import { isTargetCanton } from './crawler-location-config.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { extractMetaDescriptionRaw } from './meta-description-extract.mjs';
import { sourceLocaleDescription } from './source-locale-description.mjs';

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
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

/**
 * Parse the global JSON API response and extract Swiss jobs.
 * @param {object} data - Parsed JSON from the API
 * @returns {{ items: Array }}
 */
export function parseAfryApiResponse(data = {}) {
  const adverts = assertJsonListShape(data, { key: 'Adverts', source: 'afry' });
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
      const metaRaw = extractMetaDescriptionRaw(html);
      if (metaRaw !== null) {
        description = metaRaw.replace(/&amp;/g, '&').replace(/&#039;/g, "'");
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
 * Infer a Swiss canton (2-letter) for an AFRY job from its cleanest single
 * city signal. AFRY is a national engineering firm, so jobs span all 26
 * cantons. We resolve the canton from the FIRST Swiss city alone — never a
 * "city + region/location" combined string — because feeding multiple tokens
 * to inferAnyCanton can match the wrong canton via the TARGET_CANTONS array
 * order. Falls back to the joined location only when no city is present.
 * Returns '' if the signal does not resolve to a Swiss canton.
 */
export function inferAfryCanton(job = {}) {
  const cities = job.cities || [];
  const cleanCity = String(cities[0] || '').trim();
  if (cleanCity) {
    const canton = inferAnyCanton(cleanCity);
    if (canton) return canton;
  }
  return inferAnyCanton(String(job.location || '').toLowerCase());
}

/**
 * Check if an AFRY Swiss job resolves to a real Swiss canton (CH-wide).
 * Drops non-CH / unresolved jobs. Never defaults unresolved jobs to TI.
 */
export function isAfrySwissCanton(job = {}) {
  const canton = inferAfryCanton(job);
  return Boolean(canton) && isTargetCanton(canton);
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
 * Build localized content for an AFRY job. The description is the
 * SmartRecruiters posting text, whatever its length, published in its own
 * language slot only (`job.sourceLang`, set by the runner); the translation
 * step fills the other locales.
 *
 * This used to put a line of its own in front of the text ("<title> — AFRY,
 * <location>.") and copy the result — German for most Swiss postings — into
 * all four slots, so the Italian/English/French pages showed the German
 * posting and were never translated; under 50 words it published a paragraph
 * about AFRY of its own instead. A posting without text now gets no
 * description and takes the pipeline's thin-source path.
 */
export function buildAfryLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || 'Switzerland').trim();
  const source = sourceLocaleDescription(job.description, { defaultLang: 'de' });
  const sourceLang = String(job.sourceLang || '').trim() || source.sourceLang;

  return {
    description: source.description,
    sourceLang,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: source.description ? { [sourceLang]: source.description } : {},
    slugByLocale: {
      it: slugify(`${title} afry ${location}`),
      en: slugify(`${title} afry ${location}`),
      de: slugify(`${title} afry ${location}`),
      fr: slugify(`${title} afry ${location}`),
    },
  };
}

// Fossils of the former builder in stored jobs: the header line in front of
// the posting, or the substituted paragraph.
const AFRY_HEADER_RE = /^[^\n]{1,300}? — AFRY, [^\n]{1,80}?\.\s*\n/;
const AFRY_FALLBACK_RE = /^AFRY cerca /;

/**
 * Remove the former builder's text from a stored job: every slot held the
 * prefixed source (a copy, not a translation) or the substituted paragraph,
 * and the runner's merge keeps existing non-source slots, so all slots are
 * dropped and rebuilt by the translation step; the description keeps only the
 * posting text (nothing, when it was the substituted paragraph).
 *
 * @returns {boolean} true when the job carried the former text.
 */
export function dropAfryFabricatedText(job) {
  if (!job || typeof job !== 'object') return false;
  const texts = [job.description, ...Object.values(job.descriptionByLocale || {})].map((t) => String(t || '').trim());
  if (!texts.some((t) => AFRY_HEADER_RE.test(t) || AFRY_FALLBACK_RE.test(t))) return false;
  const description = String(job.description || '').trim();
  const body = AFRY_FALLBACK_RE.test(description) ? '' : description.replace(AFRY_HEADER_RE, '').trim();
  const sourceLang = String(job.sourceLang || '').trim() || sourceLocaleDescription(body, { defaultLang: 'de' }).sourceLang;
  job.description = body;
  job.descriptionByLocale = body ? { [sourceLang]: body } : {};
  job.needsRetranslation = true;
  return true;
}
