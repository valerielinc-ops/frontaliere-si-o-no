/**
 * Search-cluster query tokens that are NOT content: canton names, canton marker
 * words and cross-border context words.
 *
 * Both search-landing families match a query's words against job titles /
 * haystacks: `orphanQueryData.ts` (`/ricerca/<slug>/`, GSC orphan clusters) and
 * `relatedSearchClustersPlugin.ts` (`/…/ricerca-<slug>/`). A query such as
 * "offerte di lavoro canton ticino per frontalieri" carries three words that
 * describe WHERE and FOR WHOM, never WHAT: "canton", "ticino" (a canton name) and
 * "frontalieri". Treated as content they must all appear in a job title, so the
 * page found no job, shipped `noindex` and said "no openings" while its
 * sibling "offerte di lavoro canton ticino" only matched by coincidence
 * (jobs whose title/company happens to contain "canton", e.g. "Banca
 * Cantonale"). Measured on `data/gsc-orphan-queries-clusters.json`
 * (2026-11-28): 103 clusters carry such a token, 13 GSC clicks on the first.
 *
 * Interpretation (owner decision 2026-11-28):
 *   - a canton name (4 locales; "canton/cantone/kanton" are markers) is a
 *     FILTER on the job's canton, never a content token;
 *   - "frontaliere/frontalieri/frontalier/grenzgänger/cross-border" are context
 *     stopwords: they never narrow the result;
 *   - a query left with no content token shows the canton's jobs (or all
 *     Switzerland when it names no canton).
 *
 * Pure, no I/O. Tokens are compared in three spellings (raw, `stemToken` of
 * scripts/lib/query-tokenizer.mjs, `stemSearchToken` of services/searchStem.mjs)
 * because the two families stem differently.
 */
import { CANTON_CODES, expandCantonGroup, getCantonLabel, type CantonLocale } from '../../services/cantonList';
import { stemSearchToken } from '../../services/searchStem.mjs';
import { stemToken } from '../../scripts/lib/query-tokenizer.mjs';

/** "canton of …" words: they announce a canton name, they are not content. */
const CANTON_MARKER_WORDS = ['canton', 'cantone', 'cantoni', 'cantons', 'kanton', 'kantone', 'kantons'];

/**
 * Cross-border context words (who the page is for). Deliberately only the
 * unambiguous ones: `frontal` is the stem the clustering script produces for
 * "frontaliere"; `cross`/`border` come from the English "cross-border".
 */
const CONTEXT_WORDS = [
  'frontaliere', 'frontalieri', 'frontaliera', 'frontaliers', 'frontaliere', 'frontalier', 'frontal',
  'grenzganger', 'grenzgangerin', 'grenzgangers', 'grenzgaenger', 'cross', 'border', 'crossborder',
];

/**
 * Connectives left dangling once a context/canton word is removed ("per",
 * "für"). Dropped ONLY when the query already had a removal, so an ordinary
 * "assistente di cura" keeps its words and its current matching.
 */
const CONNECTIVE_WORDS = [
  'per', 'di', 'da', 'del', 'della', 'dei', 'in', 'nel', 'nella', 'con', 'e', 'il', 'lo', 'la', 'le', 'gli', 'i',
  'for', 'in', 'of', 'the', 'and', 'to',
  'fur', 'uber', 'in', 'und', 'mit', 'von', 'bei', 'im', 'am', 'aus', 'der', 'die', 'das',
  'pour', 'de', 'du', 'des', 'en', 'et', 'dans', 'au', 'aux', 'les',
];

function normalizeWord(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim();
}

function spellings(word: string): string[] {
  return [...new Set([word, stemToken(word), stemSearchToken(word)].filter(Boolean))];
}

function toSet(words: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const word of words) for (const s of spellings(normalizeWord(word))) out.add(s);
  return out;
}

const MARKERS = toSet(CANTON_MARKER_WORDS);
const CONTEXT = toSet(CONTEXT_WORDS);
const CONNECTIVES = toSet(CONNECTIVE_WORDS);

const LOCALES: readonly CantonLocale[] = ['it', 'en', 'de', 'fr'];

// Names that are not in the URL-slug table but appear in real queries.
const EXTRA_SINGLE_WORD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  SG: ['sangallo', 'gallen', 'gallo'],
  FR: ['friborgo'],
  TI: ['tessin'],
};

/** Multi-word names → codes; matched longest-first on a raw word list. */
const PHRASES: Array<{ words: readonly string[]; codes: readonly string[] }> = [];

const CODES_BY_SPELLING = new Map<string, Set<string>>();

function addSpelling(word: string, codes: readonly string[]): void {
  for (const s of spellings(word)) {
    let set = CODES_BY_SPELLING.get(s);
    if (!set) CODES_BY_SPELLING.set(s, (set = new Set<string>()));
    for (const code of codes) set.add(code);
  }
}

(() => {
  for (const code of CANTON_CODES) {
    for (const locale of LOCALES) {
      const words = normalizeWord(getCantonLabel(code, locale)).split(/[\s-]+/).filter(Boolean);
      if (words.length === 1) addSpelling(words[0], [code]);
      else if (words.length > 1) PHRASES.push({ words, codes: [code] });
    }
    for (const alias of EXTRA_SINGLE_WORD_ALIASES[code] ?? []) addSpelling(alias, [code]);
  }
  // Half-canton group names ("basilea", "appenzell") name both members. The
  // single word is the first word of every member label: add it for the group.
  for (const group of ['BASILEA', 'APPENZELLO']) {
    const members = expandCantonGroup(group);
    if (members.length < 2) continue;
    const firstWords = new Set<string>();
    for (const code of members) {
      for (const locale of LOCALES) {
        const first = normalizeWord(getCantonLabel(code, locale)).split(/[\s-]+/)[0];
        if (first) firstWords.add(first);
      }
    }
    for (const word of firstWords) addSpelling(word, members);
  }
  // Multi-word names plus the "st/sankt/saint gallen" family.
  PHRASES.push(
    { words: ['san', 'gallo'], codes: ['SG'] },
    { words: ['st', 'gallen'], codes: ['SG'] },
    { words: ['sankt', 'gallen'], codes: ['SG'] },
    { words: ['saint', 'gall'], codes: ['SG'] },
  );
  PHRASES.sort((a, b) => b.words.length - a.words.length);
})();

export type ClusterTokenClass =
  | { readonly kind: 'marker' }
  | { readonly kind: 'context' }
  | { readonly kind: 'canton'; readonly codes: readonly string[] };

/** Classify ONE token (raw or stemmed); null = ordinary content word. */
export function classifyClusterToken(token: string): ClusterTokenClass | null {
  const t = normalizeWord(token);
  if (!t) return null;
  if (MARKERS.has(t)) return { kind: 'marker' };
  if (CONTEXT.has(t)) return { kind: 'context' };
  const codes = CODES_BY_SPELLING.get(t);
  if (codes) return { kind: 'canton', codes: [...codes] };
  return null;
}

export interface SplitClusterTokens {
  /** Content tokens, original order, unchanged spelling. */
  readonly content: string[];
  /** Cantons named by the query (half-canton groups expanded), sorted. */
  readonly cantonCodes: string[];
  /** True when at least one marker / context / canton token was removed. */
  readonly removed: boolean;
}

/**
 * Split a token list into content and the canton filter.
 * `tokens` may be raw words or stems; multi-word canton names ("san gallo") are
 * recognised on raw words only.
 */
export function splitClusterTokens(tokens: readonly string[]): SplitClusterTokens {
  const words = tokens.map(normalizeWord);
  const consumed = new Array<boolean>(tokens.length).fill(false);
  const cantons = new Set<string>();
  let removed = false;

  for (const phrase of PHRASES) {
    const n = phrase.words.length;
    for (let i = 0; i + n <= words.length; i++) {
      if (consumed.slice(i, i + n).some(Boolean)) continue;
      if (phrase.words.every((w, k) => words[i + k] === w)) {
        for (let k = 0; k < n; k++) consumed[i + k] = true;
        for (const code of phrase.codes) cantons.add(code);
        removed = true;
      }
    }
  }
  // A bare group word ("basilea") must not be swallowed by a longer phrase,
  // so single-word classification runs on what is left.
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const cls = classifyClusterToken(tokens[i]);
    if (!cls) continue;
    consumed[i] = true;
    removed = true;
    if (cls.kind === 'canton') for (const code of cls.codes) cantons.add(code);
  }

  const content: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    if (removed && CONNECTIVES.has(words[i])) continue;
    content.push(tokens[i]);
  }
  return { content, cantonCodes: [...cantons].sort(), removed };
}
