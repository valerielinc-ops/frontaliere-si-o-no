import { describe, expect, it } from 'vitest';

import {
  ARTICLE_DETAIL_ATF_AD_TEST_VARIANT_RC_KEY,
  ARTICLE_DETAIL_ATF_CONTROL_VARIANT,
  ARTICLE_DETAIL_ATF_TREATMENT_VARIANT,
  resolveArticleDetailAtfAdVariant,
  shouldRenderArticleDetailAtfAd,
} from '@/packages/articles/engine/shared/articleAtfAdExperiment';

describe('article-detail near-ATF experiment', () => {
  it('fails closed to control for missing or unknown Remote Config values', () => {
    expect(ARTICLE_DETAIL_ATF_AD_TEST_VARIANT_RC_KEY).toBe('ARTICLE_DETAIL_ATF_AD_TEST_VARIANT');
    expect(resolveArticleDetailAtfAdVariant()).toBe(ARTICLE_DETAIL_ATF_CONTROL_VARIANT);
    expect(resolveArticleDetailAtfAdVariant('unknown')).toBe(ARTICLE_DETAIL_ATF_CONTROL_VARIANT);
    expect(shouldRenderArticleDetailAtfAd('unknown')).toBe(false);
  });

  it('normalizes the explicit treatment arm', () => {
    expect(resolveArticleDetailAtfAdVariant(' ATF ')).toBe(ARTICLE_DETAIL_ATF_TREATMENT_VARIANT);
    expect(shouldRenderArticleDetailAtfAd('atf')).toBe(true);
  });
});
