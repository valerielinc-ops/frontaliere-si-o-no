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
import { PROFESSION_TAXONOMY, matchProfession } from '@/scripts/lib/profession-taxonomy.mjs';

const ALIAS_TEXT_BY_PROFESSION_ID: ReadonlyMap<string, string> = new Map(
  (PROFESSION_TAXONOMY as ReadonlyArray<{ id: string; aliases: readonly string[] }>).map(
    (entry) => [entry.id, entry.aliases.join(' ')],
  ),
);

/**
 * Extra searchable text for a job title that matches a known profession —
 * every locale/gender alias for that profession, ready to append to a
 * haystack. A job titled "Infermiera" (it) gains "nurse", "infirmier",
 * "pflegefachfrau", ... as additional matchable tokens.
 */
export function professionSynonymText(title: string | undefined | null): string {
  const id = matchProfession(String(title || ''));
  return id ? (ALIAS_TEXT_BY_PROFESSION_ID.get(id) ?? '') : '';
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
    const id = matchProfession(kw);
    const aliasText = id ? ALIAS_TEXT_BY_PROFESSION_ID.get(id) : undefined;
    if (!aliasText) continue;
    for (const alias of aliasText.split(' ')) {
      if (alias) expanded.add(alias);
    }
  }
  return Array.from(expanded);
}
