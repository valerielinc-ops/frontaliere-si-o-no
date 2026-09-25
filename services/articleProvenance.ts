/**
 * How a given article came to exist — the fact the editorial-transparency
 * disclosure states to the reader.
 *
 * Until now that fact was INFERRED from the author registry: `uid` set (a
 * Firebase Auth uid, which only guest journalists have) meant "written by a
 * human, no AI assistance", `uid` absent meant "AI-drafted". That inference
 * fixed the incident of 2026-09-03 (#7227: the AI wording printed over a guest
 * journalist's byline, which was false) but it answers a question about the
 * ARTICLE with a property of the AUTHOR, and those are not the same fact. A
 * guest journalist who drafts one piece with AI assistance gets a disclosure
 * that is false in the opposite direction — the site would claim no AI was
 * involved when it was. No amount of registry data can make the inference true
 * for an individual article, because provenance varies per article and `uid`
 * does not.
 *
 * So provenance is DECLARED per article and only inferred when nothing was
 * declared. `aiAssisted` on the article record (bundled data, or the published
 * overlay index for articles this build does not ship) is the source of truth;
 * the registry inference stays as the default so the ~3.7k articles that
 * predate the field keep the behaviour #7227 shipped instead of losing their
 * disclosure or regressing to the false wording.
 *
 * Not a registry field (`Author.aiAssisted`): that would be the same
 * wrong-granularity answer as `uid`, just spelled out — it still cannot
 * distinguish two articles by the same person.
 */

/** Where the answer came from — `declared` is a fact, `inferred-from-uid` is a default. */
export type ProvenanceBasis = 'declared' | 'inferred-from-uid';

export interface ArticleProvenance {
  /** True when the draft was produced with AI assistance. */
  aiAssisted: boolean;
  basis: ProvenanceBasis;
}

/** The article-side shape this needs; anything wider is accepted. */
export interface ProvenanceDeclaringArticle {
  aiAssisted?: boolean;
}

/** The registry-side shape this needs; anything wider is accepted. */
export interface ProvenanceInferableAuthor {
  uid?: string;
}

/**
 * Resolve the provenance of one article.
 *
 * Precedence is explicit-over-inferred and deliberately strict: only a real
 * boolean on the article counts as a declaration, so `undefined` (and any
 * malformed value arriving from the runtime overlay, which is untrusted JSON)
 * falls back to the registry default rather than silently reading as `false`
 * and asserting "no AI assistance" for an AI-drafted piece.
 */
export function resolveArticleProvenance(
  article: ProvenanceDeclaringArticle | null | undefined,
  author: ProvenanceInferableAuthor | null | undefined,
): ArticleProvenance {
  if (typeof article?.aiAssisted === 'boolean') {
    return { aiAssisted: article.aiAssisted, basis: 'declared' };
  }
  return { aiAssisted: !author?.uid, basis: 'inferred-from-uid' };
}
