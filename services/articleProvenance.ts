/**
 * Site-side compatibility entry point. The engine owns the resolver so the
 * static renderer and SPA hydration share one implementation; existing site
 * imports continue to use this path during the package colocation migration.
 */
export {
  resolveArticleProvenance,
  resolveArticleTransparencyStatement,
  type ArticleProvenance,
  type ProvenanceBasis,
  type ProvenanceDeclaringArticle,
  type ProvenanceInferableAuthor,
} from '../packages/articles/engine/shared/articleProvenance';
