/**
 * Clause-tail peeling — runtime logic in plain .mjs so BOTH the TypeScript
 * render layer (via `titleSuffix.ts`, which re-exports these with types) AND
 * raw-node scripts (`scripts/create-article.mjs`, `services/newsletter-template.mjs`)
 * share ONE source of truth. A .ts module cannot be imported by a node script,
 * so the data lives here and the .ts is a typed thin re-export — same pattern as
 * `brandCanonicalMap.mjs` / `brandCanonicalMap.ts`.
 *
 * WHY this exists (issues #4356/#4357/#4358 — CTR under target on the
 * `/articoli-frontaliere/`, `/guida-frontaliere/` and `/tasse-e-pensione/`
 * template families): every truncation site in the codebase had grown its own
 * "strip the trailing junk" rule, and they had all drifted:
 *
 *   - `titleSuffix.ts::truncateHeadline`      stripped separators, no stopwords
 *   - `titleSuffix.ts::truncateTitleAtClauseBoundary` stripped both (the correct one)
 *   - `jobsSeoPagesPlugin.ts::truncMetaDesc`  had its OWN inline preposition list,
 *                                             missing tra/fra/sul/che/come/und/zu/et/qui/…
 *   - `create-article.mjs::truncateAtWordBoundary` stripped punctuation only
 *   - `newsletter-template.mjs::truncateAtWordBoundary` stripped punctuation only
 *
 * The measurable consequence: 2 936 shipped article descriptions end on a
 * dangling function word (1 844 on the literal "Dati aggiornati <year> per"),
 * and the article render path cut meta descriptions mid-WORD at 152 code units
 * ("…impatto su perme…"). A snippet that stops on a preposition reads as a
 * broken record in the SERP and makes Google likelier to discard the supplied
 * description and synthesise its own, losing control of the message.
 *
 * AGENTS.md Non-Negotiable #6: a literal duplicated in ≥2 files drifts by
 * construction — keep the list here and import it. Never copy it again.
 */

/**
 * Function words that must never dangle at the end of a truncated title or
 * snippet — conjunctions, prepositions, articles and interrogatives across the
 * 4 site locales (it/en/de/fr).
 */
export const TRAILING_STOPWORDS = new Set([
  // it
  'e', 'ed', 'o', 'od', 'a', 'ad', 'i', 'il', 'lo', 'la', 'le', 'un', 'una',
  'uno', 'di', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'da', 'dal',
  'dalla', 'in', 'nel', 'nella', 'nei', 'nelle', 'con', 'per', 'tra', 'fra',
  'su', 'sul', 'sulla', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'che',
  'come', 'quanto', 'quando', 'dove', 'cosa', 'se', 'non', 'senza', 'verso',
  // en
  'and', 'or', 'the', 'an', 'of', 'to', 'on', 'at', 'for', 'with', 'by',
  'from', 'how', 'what', 'which', 'when', 'where', 'why', 'is', 'are',
  'your', 'without',
  // de
  'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'einem', 'einen',
  'einer', 'eines', 'von', 'vom', 'zu', 'zum', 'zur', 'im', 'mit', 'für',
  'auf', 'aus', 'bei', 'beim', 'nach', 'wie', 'was', 'wann', 'wo', 'als',
  'den', 'dem', 'des', 'ohne', 'über',
  // fr
  'et', 'ou', 'le', 'les', 'une', 'des', 'de', 'du', 'en', 'dans', 'pour',
  'avec', 'par', 'sur', 'sous', 'comme', 'comment', 'que', 'qui', 'quand',
  'où', 'au', 'aux', 'à', 'sans', 'chez',
]);

/**
 * Trailing clause separators/delimiters that must never end a SERP title or
 * snippet. Union of the two sets that used to be maintained separately in
 * `truncateHeadline` (`[\s—–\-·|,;:&(]`) and `truncateTitleAtClauseBoundary`
 * (`[\s:,;.!?—–·-]`).
 */
export const CLAUSE_SEPARATOR_TAIL_RE = /[\s:,;.!?…—–·\-|&(]+$/u;

/**
 * Peel a truncated string back to the last COMPLETE clause: strip trailing
 * clause separators, then any dangling {@link TRAILING_STOPWORDS} function
 * word, repeating until the string ends on a content word.
 *
 *   "Stipendio netto frontaliere 2026: come"  → "Stipendio netto frontaliere 2026"
 *   "…requisiti e costi con B, C e"           → "…requisiti e costi con B, C"
 *   "…alcol e sigarette. Dati aggiornati 2026 per" → "…Dati aggiornati 2026"
 *
 * @param {string} s
 * @returns {string}
 */
export function peelDanglingClauseTail(s) {
  let out = String(s || '').trimEnd();
  for (;;) {
    const sepStripped = out.replace(CLAUSE_SEPARATOR_TAIL_RE, '');
    if (sepStripped !== out) {
      out = sepStripped;
      continue;
    }
    const lastWord = /(\S+)$/.exec(out)?.[1]?.toLowerCase() ?? '';
    if (lastWord && TRAILING_STOPWORDS.has(lastWord)) {
      out = out.slice(0, out.length - lastWord.length).trimEnd();
      continue;
    }
    return out;
  }
}

/**
 * Truncate to `maxLen` ending on a COMPLETE clause, never mid-word and never
 * on a function word. No ellipsis is appended — callers that want a truncation
 * marker add their own.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateToClause(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  // Always cut on a real word boundary — never mid-word.
  const cut = s.slice(0, maxLen + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return peelDanglingClauseTail((lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim());
}
