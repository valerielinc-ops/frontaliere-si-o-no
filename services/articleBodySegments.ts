import { normalizeArticleMarkdown } from '../packages/articles/engine/shared/normalizeArticleMarkdown';

/** Maximum number of body translations the article renderer probes. */
export const MAX_ARTICLE_BODY_SEGMENTS = 20;

/** Resolve one article translation key, as supplied by the i18n layer. */
export type ArticleBodyTranslation = (key: string) => string;

/**
 * Collect the same contiguous body segments used by the article renderer.
 * Missing `bodyN` stops the scan: later keys are not visible to production
 * once the first segment is absent.
 */
export function collectArticleBodySegments(
  articleId: string,
  translate: ArticleBodyTranslation,
): string[] {
  const parts: string[] = [];
  for (let index = 1; index <= MAX_ARTICLE_BODY_SEGMENTS; index += 1) {
    const key = `blog.article.${articleId}.body${index}`;
    const value = translate(key);
    if (typeof value !== 'string' || value === key) break;
    parts.push(normalizeArticleMarkdown(value));
  }
  return parts;
}

/** Exact word count used by the renderer's `bodyWordCount` gate. */
export function countArticleBodyWords(segments: readonly string[]): number {
  return segments.join(' ').split(/\s+/).filter(Boolean).length;
}

/** Exact character count used by the renderer's `bodyCharCount` gate. */
export function countArticleBodyChars(segments: readonly string[]): number {
  return segments.join(' ').trim().length;
}
