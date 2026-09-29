import { detectLang } from './dedicated-crawler-common.mjs';

/**
 * Source-locale content of one Groupe Mutuel posting (CSOD
 * `externalDescription`, already stripped to text).
 *
 * The crawler used to append an English company paragraph («Groupe Mutuel is
 * one of Switzerland's leading insurance groups…») to EVERY description and to
 * store a synthetic French stub («Poste ouvert chez Groupe Mutuel à …») in the
 * `fr` slot: neither comes from the advertisement, the English paragraph landed
 * in the German and French source slots, and it made the regional postings of
 * one role look like one shared body (issue 5253). Only the source text is
 * published, in the slot of the language it is written in; the other locales
 * are filled by the localization step.
 *
 * @returns {{ sourceLang: string, description: string, descriptionByLocale: Record<string,string>, titleByLocale: Record<string,string> } | null}
 *   null when the posting carries no text at all (nothing to publish).
 */
export function groupeMutuelSourceContent({ title = '', descriptionText = '' } = {}) {
  const description = String(descriptionText || '').trim();
  if (!description) return null;
  const sourceLang = detectLang(`${title} ${description}`, 'fr');
  return {
    sourceLang,
    description,
    descriptionByLocale: { [sourceLang]: description },
    titleByLocale: { [sourceLang]: title },
  };
}
