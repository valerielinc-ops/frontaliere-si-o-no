import { describe, expect, it } from 'vitest';
import * as rankingModule from '../functions/src/lib/jobEmailRanking.js';
import { MAX_SAFE_SCORE } from '../functions/src/lib/jobEmailRankingLinks.js';
import { buildNewsletter } from '../services/newsletter-template.mjs';

describe('job email ranking link attribution', () => {
  it('adds one per-send/per-job attribution link to newsletter cards', () => {
    const html = buildNewsletter({
      locale: 'it',
      matchedJobs: [{
        title: 'Software Engineer',
        slug: 'software-engineer',
        url: '/cerca-lavoro-ticino/software-engineer/',
        company: 'Acme SA',
        location: 'Lugano',
        ranking: {
          rankingScore: 0.81,
          relevanceScore: 8,
          ctrShrink: 0.11,
          randomBoost: 0.4,
        },
      }],
      rankingDeliveryId: 'jer_newsletter_test',
      rankingVariant: 'treatment',
      rankingSurfaceId: 'newsletter_weekly',
      newsletterId: 'weekly_2026-09-07',
      totalJobs: 1,
    });
    const href = html.match(/href="([^"]*je=1[^"]*)"/)?.[1];
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.searchParams.get('job_id')).toBe('software-engineer');
    expect(url.searchParams.get('delivery_id')).toBe('jer_newsletter_test');
    expect(url.searchParams.get('position')).toBe('1');
    expect(url.searchParams.get('variant')).toBe('treatment');
  });

  it('keeps legacy template calls free of ranking parameters', () => {
    const html = buildNewsletter({
      locale: 'it',
      matchedJobs: [{
        title: 'Software Engineer',
        slug: 'software-engineer',
        url: '/cerca-lavoro-ticino/software-engineer/',
        company: 'Acme SA',
      }],
    });
    expect(html).not.toContain('je=1');
  });

  it('keeps the Node ranking module from re-exporting browser link helpers', () => {
    expect(MAX_SAFE_SCORE).toBe(1_000_000);
    expect(rankingModule).not.toHaveProperty('MAX_SAFE_SCORE');
    expect(rankingModule).not.toHaveProperty('appendJobRankingParams');
    expect(rankingModule).not.toHaveProperty('parseJobRankingClick');
  });
});
