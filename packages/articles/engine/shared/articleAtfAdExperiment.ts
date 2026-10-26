/**
 * Build-frozen experiment contract for the article-detail near-ATF slot.
 *
 * The static article HTML and the hydrated SPA must use the same arm. The
 * deploy workflow loads the Remote Config value before SSG and writes the
 * validated value to both the Node and Vite build environments. Missing or
 * unknown values are always control.
 */

export const ARTICLE_DETAIL_ATF_AD_TEST_VARIANT_RC_KEY = 'ARTICLE_DETAIL_ATF_AD_TEST_VARIANT';
export const ARTICLE_DETAIL_ATF_EXPERIMENT_ID = 'article-detail-atf-ad-v1';
export const ARTICLE_DETAIL_ATF_CONTROL_VARIANT = 'control';
export const ARTICLE_DETAIL_ATF_TREATMENT_VARIANT = 'atf';

export type ArticleDetailAtfAdVariant =
  | typeof ARTICLE_DETAIL_ATF_CONTROL_VARIANT
  | typeof ARTICLE_DETAIL_ATF_TREATMENT_VARIANT;

export function resolveArticleDetailAtfAdVariant(
  rawValue?: string,
): ArticleDetailAtfAdVariant {
  return rawValue?.trim().toLowerCase() === ARTICLE_DETAIL_ATF_TREATMENT_VARIANT
    ? ARTICLE_DETAIL_ATF_TREATMENT_VARIANT
    : ARTICLE_DETAIL_ATF_CONTROL_VARIANT;
}

export function shouldRenderArticleDetailAtfAd(rawValue?: string): boolean {
  return resolveArticleDetailAtfAdVariant(rawValue) === ARTICLE_DETAIL_ATF_TREATMENT_VARIANT;
}
