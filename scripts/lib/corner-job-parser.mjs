/**
 * Cornèr Banca — Recruitee API offer parser
 *
 * The Recruitee API endpoint https://cornerbancasa.recruitee.com/api/offers/
 * returns offers with the following content fields:
 *
 *   offer.description       — short teaser / intro paragraph
 *   offer.requirements      — requirements bullet list
 *   offer.offer_sections    — array of { name, description } — the full vacancy body
 *   offer.translations.{locale}.{field} — per-locale equivalents
 *
 * The `description` field alone is a teaser (often < 200 chars). The complete
 * vacancy body lives in `offer_sections`. This parser combines all three sources:
 * description + offer_sections + requirements.
 *
 * Regression case: "candidatura-spontanea-apprendistato-corner-banca-switzerland"
 *   https://jobs.corner.ch/o/unsolicited-application-apprenticeship
 *   — only description was being read; offer_sections were ignored → teaser-only body
 */

/** Minimum accepted description length (characters). */
export const MIN_CORNER_DESC_LENGTH = 300;

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseBullets(html = '') {
  const items = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtml(m[1]).trim();
    if (text.length >= 10) items.push(text);
  }
  return items;
}

/**
 * Build a combined HTML string from Recruitee `offer_sections`.
 *
 * Each section has a `name` (heading) and `description` (HTML body).
 * Sections are concatenated in order, with the section name rendered as
 * a plain-text heading so stripHtml() preserves it.
 *
 * @param {Array<{ name?: string, description?: string }>} sections
 * @returns {string} combined HTML
 */
export function buildSectionsHtml(sections = []) {
  if (!Array.isArray(sections) || sections.length === 0) return '';
  return sections
    .map((s) => {
      const name = String(s?.name || '').trim();
      const body = String(s?.description || s?.body || '').trim();
      if (!body) return '';
      return name ? `<p><strong>${name}</strong></p>${body}` : body;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract offer_sections for a given locale, with fallbacks.
 *
 * Priority: localized sections → top-level sections → empty array.
 *
 * @param {object} locTrans   Localized translation object (e.g. offer.translations.it)
 * @param {object} fallbackTrans  Fallback locale translation (e.g. .en)
 * @param {object} offer      Top-level offer object
 * @returns {Array}
 */
function getSections(locTrans, fallbackTrans, offer) {
  return (
    locTrans?.offer_sections ||
    locTrans?.sections ||
    fallbackTrans?.offer_sections ||
    fallbackTrans?.sections ||
    offer?.offer_sections ||
    offer?.sections ||
    []
  );
}

/**
 * Build the full description for one locale by combining:
 *   1. description (teaser / intro)
 *   2. offer_sections (main vacancy body)
 *   3. requirements (bullet list)
 *
 * Returns an empty string when no usable content is found.
 *
 * @param {string} descHtml        HTML from the `description` field
 * @param {Array}  sections        Array of offer_sections
 * @param {string} reqHtml         HTML from the `requirements` field
 * @returns {string} plain-text combined description
 */
export function buildFullDescription(descHtml = '', sections = [], reqHtml = '') {
  const parts = [
    stripHtml(descHtml),
    stripHtml(buildSectionsHtml(sections)),
    stripHtml(reqHtml),
  ].map((s) => s.trim()).filter(Boolean);

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parse a Recruitee API offer object into a structured job record.
 *
 * Returns null when:
 *   - title is missing
 *   - combined description is < MIN_CORNER_DESC_LENGTH
 *
 * Emits console warnings for thin descriptions (available content is used
 * but will be < threshold).
 *
 * @param {object} offer - Raw offer object from Recruitee API
 * @returns {object|null}
 */
export function parseCornerOfferFull(offer) {
  if (!offer) return null;
  const translations = offer?.translations || {};
  const itTrans = translations.it || {};
  const enTrans = translations.en || {};
  const deTrans = translations.de || {};
  const frTrans = translations.fr || {};

  const title = itTrans.title || enTrans.title || offer.title || '';
  if (!title) return null;

  // Build full description per locale: teaser + offer_sections + requirements
  const descIt = buildFullDescription(
    itTrans.description || enTrans.description || offer.description || '',
    getSections(itTrans, enTrans, offer),
    itTrans.requirements || enTrans.requirements || offer.requirements || ''
  );
  const descEn = buildFullDescription(
    enTrans.description || offer.description || '',
    getSections(enTrans, null, offer),
    enTrans.requirements || offer.requirements || ''
  );
  const descDe = buildFullDescription(
    deTrans.description || '',
    getSections(deTrans, enTrans, offer),
    deTrans.requirements || ''
  );
  const descFr = buildFullDescription(
    frTrans.description || '',
    getSections(frTrans, enTrans, offer),
    frTrans.requirements || ''
  );

  // Primary description for guards
  const description = descIt || descEn || '';

  if (description.length < MIN_CORNER_DESC_LENGTH) {
    console.warn(
      `  ⚠️ Thin description for "${title}" (${description.length} chars < ${MIN_CORNER_DESC_LENGTH}) — ` +
      `offer_sections may be missing or vacancy has no body content`
    );
    if (description.length < 50) return null;
  }

  return {
    title,
    description,
    descriptionByLocale: {
      it: descIt || description,
      en: descEn || description,
      de: descDe || descEn || description,
      fr: descFr || descEn || description,
    },
    requirements: parseBullets(itTrans.requirements || enTrans.requirements || offer.requirements || ''),
    titleByLocale: {
      it: itTrans.title || title,
      en: enTrans.title || title,
      de: deTrans.title || enTrans.title || title,
      fr: frTrans.title || enTrans.title || title,
    },
  };
}
