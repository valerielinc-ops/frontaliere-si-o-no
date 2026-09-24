/**
 * Query-time synonym bridge for job search matching.
 *
 * `scripts/lib/profession-taxonomy.mjs` already curates ~70 professions with
 * it/de/fr/en aliases (gender variants, CH-specific spellings, acronyms) —
 * built for SEO keyword-opportunity scripts, not wired into any live search.
 * This facade is the single point where that taxonomy is reused by the
 * interactive matchers (`components/community/JobBoard.tsx`,
 * `services/chatbotTools.ts`). The runtime-safe implementation lives in the
 * sibling `.mjs` core so Node senders can use the same alias data too.
 */
import {
  expandKeywordsWithSynonyms as expandKeywordsWithSynonymsCore,
  professionSynonymText as professionSynonymTextCore,
} from './professionSynonymsCore.mjs';

/**
 * Extra searchable text for a job title that matches a known profession —
 * every locale/gender alias for that profession, ready to append to a
 * haystack. A job titled "Infermiera" (it) gains "nurse", "infirmier",
 * "pflegefachfrau", ... as additional matchable tokens.
 */
export function professionSynonymText(title: string | undefined | null): string {
  return professionSynonymTextCore(title);
}

/**
 * Expand a query keyword list with sibling-profession alias tokens. A
 * keyword that resolves to a taxonomy profession (e.g. "infermiera") pulls
 * in every alias for that profession (English/German/French synonyms) as
 * additional candidate tokens for substring/keyword scoring.
 */
export function expandKeywordsWithSynonyms(keywords: readonly string[]): string[] {
  return expandKeywordsWithSynonymsCore(keywords);
}
