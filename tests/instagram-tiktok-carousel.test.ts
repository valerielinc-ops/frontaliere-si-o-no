/**
 * Guard for the Instagram/TikTok carousel posters (scripts/post-to-instagram.mjs,
 * scripts/post-to-tiktok.mjs + the shared libs they introduced). Sibling of
 * tests/linkedin-member-daily.test.ts — pickFirstUnposted's carousel-format
 * counterpart, the UTM identity contract extended to two more channels, and
 * the same fail-soft file-content guards.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { pickTopNUnposted } from '../scripts/lib/daily-top-content.mjs';
import { formatDayIt, buildCarouselCaption } from '../scripts/lib/social-post-utils.mjs';
import {
  instagramUrl,
  INSTAGRAM_UTM_SOURCE,
  INSTAGRAM_CAMPAIGN_ARTICLE,
  INSTAGRAM_CAMPAIGN_JOB,
  INSTAGRAM_CAMPAIGN_BORDER,
} from '../scripts/lib/instagram-links.mjs';
import {
  tiktokUrl,
  TIKTOK_UTM_SOURCE,
  TIKTOK_CAMPAIGN_ARTICLE,
  TIKTOK_CAMPAIGN_JOB,
  TIKTOK_CAMPAIGN_BORDER,
} from '../scripts/lib/tiktok-links.mjs';

describe('pickTopNUnposted — the carousel-format sibling of pickFirstUnposted', () => {
  const ranked = [
    { slug: 'a', views: 100 },
    { slug: 'b', views: 90 },
    { slug: 'c', views: 80 },
    { slug: 'd', views: 70 },
    { slug: 'e', views: 60 },
    { slug: 'f', views: 50 },
  ];

  it('takes the top N when nothing was posted', () => {
    const { picks, skipped } = pickTopNUnposted(ranked, new Set(), 5);
    expect(picks.map((p) => p.slug)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(skipped).toBe(0);
  });

  it('skips already-posted items and fills from further down the ranking', () => {
    const { picks, skipped } = pickTopNUnposted(ranked, new Set(['a', 'c']), 3);
    expect(picks.map((p) => p.slug)).toEqual(['b', 'd', 'e']);
    expect(skipped).toBe(2);
  });

  it('returns a shorter carousel rather than padding when the pool runs out', () => {
    const { picks } = pickTopNUnposted(ranked, new Set(['a', 'b', 'c', 'd', 'e', 'f']), 5);
    expect(picks).toHaveLength(0);
  });

  it('returns empty picks for limit 0 or a negative limit, never throws', () => {
    expect(pickTopNUnposted(ranked, new Set(), 0).picks).toHaveLength(0);
    expect(pickTopNUnposted(ranked, new Set(), -3).picks).toHaveLength(0);
  });

  it('never returns more than `limit` picks even with a huge candidate pool', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ slug: `s${i}`, views: 50 - i }));
    expect(pickTopNUnposted(big, new Set(), 5).picks).toHaveLength(5);
  });
});

describe('formatDayIt', () => {
  it('renders an Italian dd/mm/yyyy date', () => {
    expect(formatDayIt('2026-08-23')).toBe('23/08/2026');
  });

  it('returns the input unchanged when it is not a YYYY-MM-DD string', () => {
    expect(formatDayIt('not-a-date')).toBe('not-a-date');
  });
});

describe('buildCarouselCaption', () => {
  const picks = [
    { title: 'Infermiere/a EOC', statValue: '312 visualizzazioni' },
    { title: 'Magazziniere Migros', statValue: '210 visualizzazioni' },
  ];

  it('numbers every pick and never emits a clickable URL — Instagram/TikTok captions cannot carry one', () => {
    const caption = buildCarouselCaption({ kind: 'job', dayLabel: '23/08/2026', picks });
    expect(caption).toContain('1. Infermiere/a EOC — 312 visualizzazioni');
    expect(caption).toContain('2. Magazziniere Migros — 210 visualizzazioni');
    expect(caption).not.toMatch(/https?:\/\//);
    expect(caption).toContain('link');
  });

  it('picks distinct copy per kind so job/article/border are never confused', () => {
    const job = buildCarouselCaption({ kind: 'job', dayLabel: 'x', picks });
    const article = buildCarouselCaption({ kind: 'article', dayLabel: 'x', picks });
    const border = buildCarouselCaption({ kind: 'border', dayLabel: 'x', picks });
    expect(new Set([job, article, border]).size).toBe(3);
    expect(border).toContain('dogane');
  });
});

describe('UTM identity — Instagram and TikTok each get one stable GA4 source row', () => {
  it('tags every campaign with the correct source/medium', () => {
    for (const campaign of [INSTAGRAM_CAMPAIGN_ARTICLE, INSTAGRAM_CAMPAIGN_JOB, INSTAGRAM_CAMPAIGN_BORDER]) {
      const u = new URL(instagramUrl('https://frontaliereticino.ch/articoli-frontaliere/x/', campaign, 'x'));
      expect(u.searchParams.get('utm_source')).toBe(INSTAGRAM_UTM_SOURCE);
      expect(u.searchParams.get('utm_medium')).toBe('social');
      expect(u.searchParams.get('utm_campaign')).toBe(campaign);
    }
    for (const campaign of [TIKTOK_CAMPAIGN_ARTICLE, TIKTOK_CAMPAIGN_JOB, TIKTOK_CAMPAIGN_BORDER]) {
      const u = new URL(tiktokUrl('https://frontaliereticino.ch/articoli-frontaliere/x/', campaign, 'x'));
      expect(u.searchParams.get('utm_source')).toBe(TIKTOK_UTM_SOURCE);
      expect(u.searchParams.get('utm_medium')).toBe('social');
      expect(u.searchParams.get('utm_campaign')).toBe(campaign);
    }
  });

  it('keeps instagram and tiktok as distinct GA4 source rows from every other channel', () => {
    const sources = new Set([INSTAGRAM_UTM_SOURCE, TIKTOK_UTM_SOURCE, 'linkedin', 'telegram', 'facebook', 'reddit']);
    expect(sources.size).toBe(6);
  });

  it('returns an unparseable URL verbatim rather than dropping the link', () => {
    expect(instagramUrl('not a url', INSTAGRAM_CAMPAIGN_JOB, 'x')).toBe('not a url');
    expect(tiktokUrl('not a url', TIKTOK_CAMPAIGN_JOB, 'x')).toBe('not a url');
  });
});

describe('fail-soft posture — Instagram/TikTok posters never exit non-zero', () => {
  const root = path.resolve(__dirname, '..', 'scripts');
  for (const file of ['post-to-instagram.mjs', 'post-to-tiktok.mjs']) {
    it(`${file} always exits 0, even on a caught error`, () => {
      const src = fs.readFileSync(path.join(root, file), 'utf-8');
      expect(src).toContain('process.exit(0)');
      expect(src).not.toMatch(/process\.exit\([1-9]/);
    });

    it(`${file} tags every link it builds with its channel's UTM helper`, () => {
      const src = fs.readFileSync(path.join(root, file), 'utf-8');
      const helper = file.includes('instagram') ? 'instagramUrl(' : 'tiktokUrl(';
      expect(src).toContain(helper);
    });
  }
});
