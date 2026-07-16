/**
 * Query-time synonym bridge for job search matching.
 *
 * `scripts/lib/profession-taxonomy.mjs` already curates ~70 professions with
 * it/de/fr/en aliases (gender variants, CH-specific spellings, acronyms) —
 * built for SEO keyword-opportunity scripts, not wired into any live search.
 * This module is the single point where that taxonomy is reused by the
 * interactive matchers (`components/community/JobBoard.tsx`,
 * `services/chatbotTools.ts`) so a query in one language can surface job
 * titles written in another, without duplicating the alias data.
 */
import {
  PROFESSION_TAXONOMY,
  matchProfession,
  normalizeText,
  SEARCH_STOP_WORDS,
  LOCALITY_TOKENS,
} from '@/scripts/lib/profession-taxonomy.mjs';

const ALIAS_TEXT_BY_PROFESSION_ID: ReadonlyMap<string, string> = new Map(
  (PROFESSION_TAXONOMY as ReadonlyArray<{ id: string; aliases: readonly string[] }>).map(
    (entry) => [entry.id, entry.aliases.join(' ')],
  ),
);

/**
 * matchProfession() rescans the whole taxonomy (~70 professions × aliases)
 * per call. Job titles repeat across re-sorts/rebuilds (JobBoard's search
 * index rebuilds on every `sortedJobs` change) and keywords repeat across
 * a single query's expansion, so cache the resolved id by input string —
 * same idiom as HEADING_PREFIX_REGEXP_CACHE in services/jobs/canonicalFallback.ts.
 */
const PROFESSION_ID_CACHE = new Map<string, string | null>();
function cachedMatchProfession(text: string): string | null {
  let id = PROFESSION_ID_CACHE.get(text);
  if (id === undefined) {
    id = matchProfession(text);
    PROFESSION_ID_CACHE.set(text, id);
  }
  return id;
}

/**
 * Extra searchable text for a job title that matches a known profession —
 * every locale/gender alias for that profession, ready to append to a
 * haystack. A job titled "Infermiera" (it) gains "nurse", "infirmier",
 * "pflegefachfrau", ... as additional matchable tokens.
 */
export function professionSynonymText(title: string | undefined | null): string {
  const id = cachedMatchProfession(String(title || ''));
  return id ? (ALIAS_TEXT_BY_PROFESSION_ID.get(id) ?? '') : '';
}

/**
 * A keyword is only worth a profession-taxonomy lookup if, once normalized,
 * it has at least one token that isn't a search stopword, a locality name,
 * or pure digits — otherwise it can't plausibly name a profession and
 * scanning the taxonomy for it just risks an accidental alias collision
 * (e.g. a short acronym alias matching an unrelated word). Reuses the same
 * SEARCH_STOP_WORDS/LOCALITY_TOKENS split that classifySearchTerm() in
 * profession-taxonomy.mjs already applies for this exact purpose.
 */
function isPlausibleProfessionToken(keyword: string): boolean {
  const tokens = normalizeText(keyword)
    .split(' ')
    .filter((t) => t.length >= 2 && !SEARCH_STOP_WORDS.has(t) && !LOCALITY_TOKENS.has(t) && !/^\d+$/.test(t));
  return tokens.length > 0;
}

/**
 * Expand a query keyword list with sibling-profession alias tokens. A
 * keyword that resolves to a taxonomy profession (e.g. "infermiera") pulls
 * in every alias for that profession (English/German/French synonyms) as
 * additional candidate tokens for substring/keyword scoring.
 */
export function expandKeywordsWithSynonyms(keywords: readonly string[]): string[] {
  const expanded = new Set<string>(keywords);
  for (const kw of keywords) {
    if (!isPlausibleProfessionToken(kw)) continue;
    const id = cachedMatchProfession(kw);
    const aliasText = id ? ALIAS_TEXT_BY_PROFESSION_ID.get(id) : undefined;
    if (!aliasText) continue;
    for (const alias of aliasText.split(' ')) {
      if (alias) expanded.add(alias);
    }
  }
  return Array.from(expanded);
}
