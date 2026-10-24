/**
 * How a given article came to exist — the fact the editorial-transparency
 * disclosure states to the reader.
 *
 * Provenance is declared per article and only inferred when nothing was
 * declared. `aiAssisted` on the article record (bundled data, or the
 * published overlay index for articles this build does not ship) is the
 * source of truth; the registry inference stays as the default for legacy
 * articles that predate the field.
 *
 * This helper lives in the article engine so the static renderer and the SPA
 * hydration path cannot answer the same question with different rules.
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
 * boolean on the article counts as a declaration, so malformed values from
 * the runtime overlay fall back to the registry default rather than silently
 * asserting "no AI assistance".
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
