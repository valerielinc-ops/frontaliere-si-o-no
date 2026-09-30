import { describe, expect, it } from 'vitest';
import {
  campaignRotationIndex,
  resolveNewsletterArticle,
} from '../scripts/lib/newsletter-article-selection.mjs';

const WINNERS = [
  { slug: 'news-a', cluster: 'novita', score: 12 },
  { slug: 'news-b', cluster: 'mobilita', score: 10 },
  { slug: 'news-c', cluster: 'pratico', score: 8 },
];

const subscriber = {
  engagementLevel: 'hot',
  sourceRouteFamily: 'article_detail',
};

const localizeArticle = (slug: string, locale: string) => ({
  title: `${locale}:${slug}`,
  excerpt: `excerpt:${slug}`,
  url: `/articoli-frontaliere/${slug}/`,
});

const fallbackArticle = () => ({
  title: 'fallback',
  excerpt: 'fallback excerpt',
  url: '/articoli-frontaliere/fallback/',
});

describe('campaignRotationIndex', () => {
  it('advances by one for consecutive weekly campaigns', () => {
    const current = campaignRotationIndex('weekly_2026-09-28');
    const next = campaignRotationIndex('weekly_2026-10-05');
    expect(next).toBe(current! + 1);
  });

  it('returns null for ad-hoc campaign ids', () => {
    expect(campaignRotationIndex('test-preview')).toBeNull();
  });
});

describe('resolveNewsletterArticle', () => {
  const options = {
    subscriber,
    locale: 'it',
    winners: WINNERS,
    localizeArticleFn: localizeArticle,
    featuredArticleFn: fallbackArticle,
    seasonalContentFn: () => null,
  };

  it('rotates the selected article between weekly campaigns', () => {
    const current = resolveNewsletterArticle({ ...options, campaignId: 'weekly_2026-09-28' });
    const next = resolveNewsletterArticle({ ...options, campaignId: 'weekly_2026-10-05' });

    expect(current.segment).toBe('hot_articles');
    expect(current.article?.title).not.toBe(next.article?.title);
  });

  it('keeps a resumed campaign on the same article', () => {
    const first = resolveNewsletterArticle({ ...options, campaignId: 'weekly_2026-09-28' });
    const resumed = resolveNewsletterArticle({ ...options, campaignId: 'weekly_2026-09-28' });
    expect(resumed).toEqual(first);
  });

  it('keeps seasonal utility content ahead of winner rotation', () => {
    const seasonal = {
      title: 'Seasonal utility',
      excerpt: 'Seasonal excerpt',
      url: '/calcolatore-stipendio/',
    };
    const result = resolveNewsletterArticle({
      ...options,
      subscriber: { engagementLevel: 'hot', sourceComponent: 'TaxCalendar' },
      campaignId: 'weekly_2026-09-28',
      seasonalContentFn: () => seasonal,
    });
    expect(result.segment).toBe('hot_utility');
    expect(result.article).toEqual(seasonal);
  });

  it('uses the global fallback when no ranked winner localizes', () => {
    const result = resolveNewsletterArticle({
      ...options,
      campaignId: 'weekly_2026-09-28',
      localizeArticleFn: () => null,
    });
    expect(result.article).toEqual(fallbackArticle());
  });
});
