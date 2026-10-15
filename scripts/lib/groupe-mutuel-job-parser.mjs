import { detectLang } from './dedicated-crawler-common.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

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
 *   null when the posting carries no vacancy text: none at all, or a text
 *   under the shared 50-word floor (source-body-floor.mjs), which is thin
 *   content, not a body.
 */
export function groupeMutuelSourceContent({ title = '', descriptionText = '' } = {}) {
  const description = String(descriptionText || '').trim();
  if (!meetsSourceBodyFloor(description)) return null;
  const sourceLang = detectLang(`${title} ${description}`, 'fr');
  return {
    sourceLang,
    description,
    descriptionByLocale: { [sourceLang]: description },
    titleByLocale: { [sourceLang]: title },
  };
}

/**
 * Fragment only the crawler's former text wrote: the company paragraph
 * appended to every description — in English, and in the German, French and
 * Italian translations made from it («… mit Sitz in Martigny (Valais)») — and
 * the French stub stored in the `fr` slot («Poste ouvert chez Groupe Mutuel à
 * …»). The paragraph is recognised only together with its «Martigny (Valais)»
 * clause, which no advertisement carries.
 */
export const GROUPE_MUTUEL_FABRICATED_DESCRIPTION_RE =
  /Groupe Mutuel (?:is one of Switzerland[’']s leading insurance groups|ist eine der führenden Versicherungsgruppen|est l[’']un des principaux groupes d[’']assurances?|è uno dei principali gruppi assicurativi)[^\n]*Martigny \(Valais\)|Poste ouvert chez Groupe Mutuel à /;
