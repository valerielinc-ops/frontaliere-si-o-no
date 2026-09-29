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

import { meetsSourceBodyFloor, MIN_SOURCE_BODY_WORDS } from './source-body-floor.mjs';

/** Length (characters) under which a body is logged as thin; not a gate. */
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
 * The description the bank itself wrote for one Recruitee language — that
 * translation's own teaser, sections and requirements, never another
 * language's. Empty when the translation has no description of its own.
 *
 * @param {object} trans  `offer.translations.<locale>`
 * @returns {string}
 */
function ownLocaleDescription(trans) {
  if (!String(trans?.description || '').trim()) return '';
  return buildFullDescription(
    trans.description,
    trans.offer_sections || trans.sections || [],
    trans.requirements || '',
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

  // Each language's text is the bank's own for that language (teaser +
  // offer_sections + requirements of that translation). Earlier versions
  // filled a missing language with another one (`de: descDe || descEn ||
  // description`), publishing English under de/fr: those slots now stay
  // empty for the translation step.
  const descIt = ownLocaleDescription(itTrans);
  const descEn = ownLocaleDescription(enTrans);
  const descDe = ownLocaleDescription(deTrans);
  const descFr = ownLocaleDescription(frTrans);

  // Primary-language description. Recruitee's top-level `title`/`description`
  // /`requirements` carry the offer's PRIMARY language — the one the public
  // page jobs.corner.ch/o/<slug> renders — while `translations.<locale>` are
  // the company's own alternates. Cornèr's primary language is English on
  // every current offer, so preferring the Italian alternate here published a
  // description in a language the source page does not show (and labelled it
  // as the source language), which the source-detail audit reads as an
  // unrelated body (word overlap 2-12 %, #5253).
  const descPrimary = buildFullDescription(
    offer.description || '',
    offer.offer_sections || offer.sections || [],
    offer.requirements || ''
  );
  const description = descPrimary || descIt || descEn || '';

  // Locales the company wrote itself (not filled from another locale), so the
  // runner can keep them authoritative over machine translations.
  const ownDescriptions = { it: descIt, en: descEn, de: descDe, fr: descFr };
  const officialLocales = Object.keys(ownDescriptions).filter((locale) => ownDescriptions[locale]);

  // Gate in words (shared floor), not characters: without padding, a
  // character gate let a 20-49-word teaser through as a thin page.
  if (!meetsSourceBodyFloor(description)) {
    console.warn(
      `  ⚠️ Not publishing "${title}": the offer body is under ${MIN_SOURCE_BODY_WORDS} words`
    );
    return null;
  }
  if (description.length < MIN_CORNER_DESC_LENGTH) {
    console.warn(
      `  ⚠️ Short description for "${title}" (${description.length} chars < ${MIN_CORNER_DESC_LENGTH}) — ` +
      `offer_sections may be missing`
    );
  }

  return {
    title,
    description,
    // Only the languages the bank wrote; the runner adds the primary text
    // under its detected language and verifies each alternate's language.
    descriptionByLocale: Object.fromEntries(officialLocales.map((locale) => [locale, ownDescriptions[locale]])),
    officialLocales,
    requirements: parseBullets(itTrans.requirements || enTrans.requirements || offer.requirements || ''),
    titleByLocale: {
      it: itTrans.title || title,
      en: enTrans.title || title,
      de: deTrans.title || enTrans.title || title,
      fr: frTrans.title || enTrans.title || title,
    },
  };
}
