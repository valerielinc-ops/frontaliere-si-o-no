/**
 * fuzzySearchSuggestions.ts — plain-string "did you mean" suggestions for
 * zero-result searches (issue #4301, JobBoard "smart 0 results").
 *
 * Generalizes the substring/prefix-overlap scoring already used by
 * `components/shared/SiteSearch.tsx`'s `noResultsSuggestions` (which is
 * inlined there against its own `fullSearchIndex` item shape) into a
 * dependency-free, plain-`string[]`-candidate version reusable outside the
 * site-nav search index — e.g. against job titles/companies/locations.
 */

interface ScoredTerm {
  term: string;
  score: number;
}

function scoreTerm(query: string, candidate: string): number {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (!q || !c) return 0;
  const qStart = q.slice(0, Math.max(3, Math.ceil(q.length * 0.6)));
  let score = 0;
  if (c.startsWith(q)) score += 6;
  if (c.includes(q)) score += 4;
  if (qStart.length >= 3 && c.includes(qStart)) score += 3;
  else if (c.length >= 3 && qStart.includes(c.slice(0, 3))) score += 1;
  return score;
}

/**
 * Ranks `candidates` by similarity to `query` and returns the top `limit`
 * distinct terms (case-insensitive dedupe), excluding exact matches to the
 * query itself (an exact match would not be a "did you mean" suggestion).
 * Returns `[]` for queries shorter than 2 chars or when nothing scores > 0.
 */
export function suggestSimilarTerms(
  query: string,
  candidates: readonly string[],
  limit = 5,
): string[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const qLower = q.toLowerCase();
  const seen = new Set<string>();
  const scored: ScoredTerm[] = [];
  for (const candidate of candidates) {
    const clean = candidate.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (key === qLower || seen.has(key)) continue;
    const score = scoreTerm(q, clean);
    if (score <= 0) continue;
    seen.add(key);
    scored.push({ term: clean, score });
  }
  scored.sort((a, b) => b.score - a.score || a.term.length - b.term.length);
  return scored.slice(0, limit).map((s) => s.term);
}
