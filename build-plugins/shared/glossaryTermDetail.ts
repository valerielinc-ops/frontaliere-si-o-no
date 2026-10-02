/**
 * glossaryTermDetail — the part of a glossary term page that belongs to THAT
 * term, in the page's own language.
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * The SSG term pages (`/glossario-frontaliere/<term>/` and the localized
 * `/en/cross-border-glossary/`, `/de/grenzgaenger-glossar/`,
 * `/fr/glossaire-frontalier/`) were the section editorial of the glossary
 * repeated on every term, with only the term id swapped in. On the en/de/fr
 * pages the lede was literally the placeholder «Definition und Erklärung von
 * <term> für Grenzgänger…» that #4409 had removed from the Italian ones:
 * `audit:information-gain` on run 36977215802 (2026-10-02) measured the three
 * localized cohorts at 0 % median, 12 pages out of 20 without a single
 * sentence their siblings did not carry.
 *
 * The term content already existed, translated, in the SPA glossary
 * (`services/locales/<locale>-stats.ts`, keys `glossary.terms.<id>.title|desc|
 * example`, all 41 terms × 4 locales): the static page simply never read it.
 * This module reads it — the static HTML now says what the SPA says.
 *
 * WHAT IT ADDS
 *   - the term's definition in the page language (lede + meta description of
 *     the localized pages, via `localizedGlossaryLede`);
 *   - the worked example the SPA shows under each term;
 *   - the term's names in the other site languages. For a cross-border worker
 *     this is the practical part: the Swiss payslip says «NBU», the Italian
 *     paperwork says «AINP», the French one «AANP». The Italian original is
 *     given with its Italian definition on the localized pages, because that
 *     is the wording the reader meets on Italian documents.
 *
 * Nothing here is generated prose: every sentence is a translation string the
 * site already ships, so the four locales stay in parity by construction.
 */

import itStats from '../../services/locales/it-stats';
import enStats from '../../services/locales/en-stats';
import deStats from '../../services/locales/de-stats';
import frStats from '../../services/locales/fr-stats';
import { truncateForMetaDescription } from '../../services/seo/glossaryTermDefinitions';

export type GlossaryDetailLocale = 'it' | 'en' | 'de' | 'fr';

const STATS: Record<GlossaryDetailLocale, Record<string, string>> = {
  it: itStats,
  en: enStats,
  de: deStats,
  fr: frStats,
};

const LOCALE_ORDER: readonly GlossaryDetailLocale[] = ['it', 'de', 'fr', 'en'];

export interface GlossaryTermFacts {
  title: string;
  desc: string;
  example: string;
}

/** The SPA glossary strings for one term, or null when any of the three is missing. */
export function glossaryTermFacts(termId: string, locale: GlossaryDetailLocale): GlossaryTermFacts | null {
  const t = STATS[locale];
  const title = t[`glossary.terms.${termId}.title`];
  const desc = t[`glossary.terms.${termId}.desc`];
  const example = t[`glossary.terms.${termId}.example`];
  if (!title || !desc || !example) return null;
  return { title, desc, example };
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ensure a sentence ends with terminal punctuation, so two strings never run together. */
const sentence = (s: string): string => (/[.!?…)]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const COPY = {
  heading: { it: 'In breve', en: 'In short', de: 'Kurz erklärt', fr: 'En bref' },
  languageName: {
    it: { it: 'italiano', en: 'inglese', de: 'tedesco', fr: 'francese' },
    en: { it: 'Italian', en: 'English', de: 'German', fr: 'French' },
    de: { it: 'Italienisch', en: 'Englisch', de: 'Deutsch', fr: 'Französisch' },
    fr: { it: 'italien', en: 'anglais', de: 'allemand', fr: 'français' },
  },
  otherLanguages: {
    it: (list: string) => `Lo stesso concetto nelle altre lingue del sito: ${list}.`,
    en: (list: string) => `The same concept in the site's other languages: ${list}.`,
    de: (list: string) => `Derselbe Begriff in den anderen Sprachen der Website: ${list}.`,
    fr: (list: string) => `La même notion dans les autres langues du site : ${list}.`,
  },
  italianOriginal: {
    en: (title: string, desc: string) => `On Italian documents the term reads «${title}»: ${desc}`,
    de: (title: string, desc: string) => `Auf italienischen Dokumenten heisst der Begriff «${title}»: ${desc}`,
    fr: (title: string, desc: string) => `Sur les documents italiens, le terme s’écrit «${title}» : ${desc}`,
  },
} as const;

/**
 * Lede / meta description for a localized term page: the term's own name and
 * definition in the page language, instead of the «Definition und Erklärung
 * von …» placeholder. Returns null when the locale strings are missing, so the
 * caller keeps its fallback.
 */
export function localizedGlossaryLede(termId: string, locale: GlossaryDetailLocale): string | null {
  const facts = glossaryTermFacts(termId, locale);
  if (!facts) return null;
  return `${facts.title} — ${sentence(facts.desc)}`;
}

/**
 * Editorial blocks (raw HTML, block-level tags first) for one term page.
 *
 * Every block is a single text node on purpose: an inline `<strong>` would
 * split a sentence at the tag boundary, and the halves would no longer read
 * as the sentence they are.
 */
export function renderGlossaryTermDetail(termId: string, locale: GlossaryDetailLocale): string[] {
  const facts = glossaryTermFacts(termId, locale);
  if (!facts) return [];
  const blocks: string[] = [`<h2 class="s-o3IET6">${esc(COPY.heading[locale])}</h2>`];

  // The Italian page's lede is the hand-written definition from
  // `services/seo/glossaryTermDefinitions.ts`; the localized pages get the SPA
  // definition as their lede (`localizedGlossaryLede`). Either way the
  // definition is already above this block, so the block does not repeat it —
  // unless the lede was truncated.
  // When the localized lede had to be cut to the meta-description budget, the
  // full definition is given here so the page never shows half of it.
  if (locale !== 'it') {
    const lede = localizedGlossaryLede(termId, locale);
    if (lede && truncateForMetaDescription(lede) !== lede) {
      blocks.push(`<p class="s-F2hp6o">${esc(`${facts.title}${locale === 'fr' ? '\u00a0: ' : ': '}${sentence(facts.desc)}`)}</p>`);
    }
  }
  const exampleLabel = STATS[locale]['glossary.example'] ?? 'Example';
  // French puts a (non-breaking) space before the colon.
  const colon = locale === 'fr' ? '\u00a0: ' : ': ';
  blocks.push(`<p class="s-F2hp6o">${esc(`${exampleLabel}${colon}${sentence(facts.example)}`)}</p>`);

  if (locale !== 'it') {
    const italian = glossaryTermFacts(termId, 'it');
    if (italian) {
      blocks.push(`<p class="s-F2hp6o">${esc(COPY.italianOriginal[locale](italian.title, sentence(italian.desc)))}</p>`);
    }
  }

  const others = LOCALE_ORDER.filter((l) => l !== locale && !(locale !== 'it' && l === 'it'))
    .map((l) => {
      const f = glossaryTermFacts(termId, l);
      return f ? `${COPY.languageName[locale][l]} «${f.title}»` : null;
    })
    .filter((s): s is string => s !== null);
  if (others.length > 0) {
    blocks.push(`<p class="s-F2hp6o">${esc(COPY.otherLanguages[locale](others.join(', ')))}</p>`);
  }
  return blocks;
}
