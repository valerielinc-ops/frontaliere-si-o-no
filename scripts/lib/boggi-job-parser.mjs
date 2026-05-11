/**
 * Boggi Milano — Recruitee API parser
 *
 * API endpoint: https://boggimilano1.recruitee.com/api/offers
 * Returns all offers as JSON — no HTML parsing needed.
 * Italian careers page: https://boggimilano1.recruitee.com/l/it
 *
 * Each offer includes:
 *   - id, guid, slug, title, description (HTML)
 *   - locations[] with city, state, country, country_code
 *   - translations.{locale}.title, translations.{locale}.description
 *   - employment_type_code, department, category_code
 *   - careers_url, careers_apply_url
 *   - published_at, on_site, remote, hybrid
 */

import { JSDOM } from 'jsdom';
import { detectLanguage } from './detect-language.mjs';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';

const DETAIL_URL_BASE = 'https://boggimilano1.recruitee.com/l/it/o';

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

/** Minimum character count for a Boggi/Recruitee description to be "full". */
export const MIN_BOGGI_DESC_LENGTH = 400;

/**
 * Combine all HTML description sections from a Recruitee API offer into one
 * unified HTML string. Fields: description, requirements, education, experience.
 * Handles both top-level and translations.{lang} variants.
 */
export function combineRecruiteeDescriptionSections(offer = {}, lang = 'it') {
  const trans = offer.translations?.[lang] || {};
  const parts = [];

  // All Recruitee section fields (vary by configuration)
  const SECTION_FIELDS = ['description', 'requirements', 'education', 'experience'];
  for (const field of SECTION_FIELDS) {
    const html = String(trans[field] || offer[field] || '').trim();
    if (html) parts.push(html);
  }

  return parts.join('\n');
}

/**
 * Parse the full job description body from a Recruitee hosted detail page HTML.
 *
 * Recruitee uses styled-components (random class names). Strategy:
 *   1. Try known semantic selectors (#description, .offer__description, …)
 *   2. Fall back to the element with the most combined text among <section>/<article>/<main> descendants
 *
 * Returns { title, body, sourceBodyLength } where:
 *   - title          — text from the first <h1>
 *   - body           — plain text extracted from the best content element
 *   - sourceBodyLength — length of the extracted plain text (for the 25% guard)
 */
export function parseBoggiDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const { document } = new JSDOM(html).window;

  // ── Title ────────────────────────────────────────────────────
  const titleEl = document.querySelector('h1');
  const title = normalizeSpace(titleEl?.textContent || '');

  // ── Body ─────────────────────────────────────────────────────
  const BODY_SELECTORS = [
    '#description',
    '#offer-description',
    '[data-test-id="offer-description"]',
    '[data-testid="offer-description"]',
    '.offer__description',
    '.offer-description',
    '[class*="offerDescription"]',
    '[class*="jobDescription"]',
    '[class*="description"]',
    'main article',
    'main [role="main"]',
    'main',
  ];

  let body = '';

  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = stripHtml(el.innerHTML || '');
    if (text.length > body.length) body = text;
    if (text.length >= MIN_BOGGI_DESC_LENGTH) break;
  }

  // Fallback: element with most text content in a structural container
  if (body.length < MIN_BOGGI_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen > body.length) {
      body = stripHtml(best.innerHTML || '');
    }
  }

  return { title, body, sourceBodyLength: body.length };
}

/**
 * Parse the Recruitee API response and filter to Swiss/Ticino jobs.
 * @param {object} apiResponse - Raw JSON from /api/offers
 * @returns {Array<object>} Array of Ticino-relevant offer objects
 */
export function parseBoggiApiResponse(apiResponse = {}) {
  const offers = apiResponse?.offers || [];
  return offers.filter(isBoggiTicinoRelevant);
}

/**
 * Check whether an offer is relevant to any target Swiss canton.
 * Checks both the top-level country_code and each location entry.
 */
export function isBoggiTicinoRelevant(offer = {}) {
  if (offer.country_code === 'CH') return true;

  const locations = offer.locations || [];
  for (const loc of locations) {
    if (loc.country_code === 'CH') return true;
    const combined = [loc.city, loc.state, loc.country].filter(Boolean).join(' ');
    if (isTargetSwissLocation(combined)) return true;
  }

  const locStr = String(offer.location || '');
  if (/svizzera|switzerland|schweiz|suisse/i.test(locStr)) return true;
  return isTargetSwissLocation(locStr);
}

/**
 * Transform a Recruitee API offer into the standard job format.
 */
export function buildBoggiJobFromApi(offer = {}) {
  // Extract Italian translation (preferred)
  const itTrans = offer.translations?.it || {};
  const title = normalizeSpace(itTrans.title || offer.title || '');
  // Combine all Recruitee description sections (description + requirements +
  // education + experience) so we don't lose content from secondary sections.
  const combinedHtml = combineRecruiteeDescriptionSections(offer, 'it');
  const descHtml = combinedHtml || itTrans.description || offer.description || '';
  const description = stripHtml(descHtml);

  // Build location from the first Swiss location only. We must NOT fall back to
  // a non-Swiss location (Italy, etc.) — this is a Swiss frontaliere board, and
  // a non-CH location would propagate misleading city/state into downstream
  // SEO and canton inference.
  const swissLoc = (offer.locations || []).find((l) => l.country_code === 'CH');
  if (!swissLoc) {
    const offerTitle = normalizeSpace(itTrans.title || offer.title || '');
    console.log(`  ⏭️  No Swiss location — skipping: ${offerTitle}`);
    return null;
  }
  const city = normalizeSpace(swissLoc.city || offer.city || 'Mendrisio');
  const state = normalizeSpace(swissLoc.state || offer.state_name || 'Ticino');
  const locationStr = `${city}, ${state}`;

  // Employment type mapping
  const empMap = {
    fulltime_permanent: 'full-time',
    fulltime_fixed_term: 'full-time',
    parttime: 'part-time',
    internship: 'internship',
    freelance: 'freelance',
  };
  const employmentType = empMap[offer.employment_type_code] || 'full-time';

  // Work model
  let workModel = 'on-site';
  if (offer.remote) workModel = 'remote';
  else if (offer.hybrid) workModel = 'hybrid';

  // Date
  const datePosted = offer.published_at
    ? String(offer.published_at).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  return {
    title,
    city,
    state,
    location: locationStr,
    description,
    descriptionHtml: descHtml,
    slug: offer.slug || '',
    guid: offer.guid || '',
    detailUrl: `${DETAIL_URL_BASE}/${offer.slug}`,
    applyUrl: offer.careers_apply_url || `${DETAIL_URL_BASE}/${offer.slug}/c/new`,
    department: offer.department || '',
    employmentType,
    workModel,
    datePosted,
    validThrough: offer.close_at ? String(offer.close_at).slice(0, 10) : '',
  };
}

/**
 * Build localized content for a Boggi Milano job.
 */
export function buildBoggiLocalizedContent(job = {}) {
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim() || 'Mendrisio';
  const description = String(job.description || '').trim();
  const sourceLang = description ? detectLanguage(`${title}\n${description}`, 'it') : 'it';

  const fallbackIt = `Boggi Milano cerca ${title} con sede a ${location}. Moda maschile italiana, design e qualità. Candidati sulla pagina ufficiale Boggi Milano.`;
  const enDesc = `Boggi Milano is hiring for the ${title} position in ${location}. Italian men's fashion, design and quality. Apply through the official Boggi Milano careers page.`;
  const deDesc = `Boggi Milano sucht aktuell für die Position ${title} am Standort ${location}. Italienische Herrenmode, Design und Qualität. Bewirb dich über die offizielle Karriereseite von Boggi Milano.`;
  const frDesc = `Boggi Milano recrute pour le poste ${title} à ${location}. Mode masculine italienne, design et qualité. Postulez via la page carrière officielle de Boggi Milano.`;

  const descriptionByLocale = {
    it: description || fallbackIt,
    en: enDesc,
    de: deDesc,
    fr: frDesc,
  };

  if (description) {
    descriptionByLocale[sourceLang] = description;
    if (sourceLang !== 'it') {
      descriptionByLocale.it = description;
    }
  }

  return {
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale,
    slugByLocale: {
      it: slugify(`${title} boggi-milano ${location}`),
      en: slugify(`${title} boggi-milano ${location}`),
      de: slugify(`${title} boggi-milano ${location}`),
      fr: slugify(`${title} boggi-milano ${location}`),
    },
  };
}

/**
 * Infer job category from title and department.
 */
export function inferBoggiCategory(title = '', department = '') {
  const haystack = `${title} ${department}`.toLowerCase();
  if (/retail|sales|vendita|advisor|store|boutique/i.test(haystack)) return 'sales';
  if (/hr|human\s*resource|risorse\s*umane/i.test(haystack)) return 'hr';
  if (/treasury|financ|contabil|accounting/i.test(haystack)) return 'finance';
  if (/marketing|communication|digital/i.test(haystack)) return 'marketing';
  if (/logistic|import|export|supply/i.test(haystack)) return 'logistics';
  if (/stage|intern|tirocin/i.test(haystack)) return 'internship';
  if (/it\b|software|developer|data/i.test(haystack)) return 'it';
  if (/design|visual|creative/i.test(haystack)) return 'design';
  return 'retail';
}
