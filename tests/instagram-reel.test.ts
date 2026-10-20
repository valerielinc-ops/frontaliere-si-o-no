import { describe, expect, it } from 'vitest';

import {
  INSTAGRAM_REEL_VARIANTS,
  buildInstagramReelContent,
  chooseInstagramReelCreative,
  instagramReelLedgerFields,
} from '../scripts/lib/instagram-reel-creative.mjs';
import {
  pendingInstagramReel,
  recentInstagramReel,
} from '../scripts/lib/instagram-reel-queue.mjs';
import { buildReelSlidePlan } from '../scripts/lib/social-reel-image.mjs';
import { buildQueueEntry, selectNextPending } from '../scripts/lib/social-publish-queue.mjs';

const ITEM = {
  title: 'Infermiere/a EOC — Lugano',
  views: 312,
  slug: 'infermiere-eoc-lugano',
  path: '/cerca-lavoro-ticino/infermiere-eoc-lugano',
};

describe('Instagram Reel creative experiment', () => {
  it('keeps three distinct, measurable treatments', () => {
    const expectedMechanics = {
      comments: 'keyword-comment',
      shares: 'direct-share',
      saves: 'save-reminder',
    };
    expect(INSTAGRAM_REEL_VARIANTS).toHaveLength(3);
    expect(new Set(INSTAGRAM_REEL_VARIANTS.map((variant) => variant.id)).size).toBe(3);
    for (const variant of INSTAGRAM_REEL_VARIANTS) {
      expect(variant.objective).toBeTruthy();
      expect(variant.primaryMetric).toMatch(/comments|shares|saves/);
      expect(variant.hookType).toBeTruthy();
      expect(variant.attentionMechanic).toBeTruthy();
      expect(variant.engagementLoop).toBeTruthy();
      expect(variant.followUpFormat).toBeTruthy();
      expect(variant.hook.article.title).toBeTruthy();
      expect(variant.hook.job.title).toBeTruthy();
      expect(variant.cta.article).toBeTruthy();
      expect(variant.cta.job).toBeTruthy();
      expect(instagramReelLedgerFields(variant).engagementMechanic)
        .toBe(expectedMechanics[variant.primaryMetric]);
    }
  });

  it('rotates deterministically and keeps the source kind in the treatment', () => {
    const article = chooseInstagramReelCreative({ kind: 'article', day: '2026-10-10' });
    const sameArticle = chooseInstagramReelCreative({ kind: 'article', day: '2026-10-10' });
    const job = chooseInstagramReelCreative({ kind: 'job', day: '2026-10-10' });
    expect(article).toEqual(sameArticle);
    expect(article.kind).toBe('article');
    expect(job.kind).toBe('job');
    expect(job.id).not.toBe(article.id);
  });

  it('builds hook, proof and CTA cards without mixing carousel metadata', () => {
    const creative = chooseInstagramReelCreative({ kind: 'job', day: '2026-10-10' });
    const content = buildInstagramReelContent({ kind: 'job', dayLabel: '10 ottobre 2026', item: ITEM, creative });
    expect(content.slides).toHaveLength(3);
    expect(buildReelSlidePlan({ slides: content.slides })).toEqual(content.slides);
    expect(content.slides[0].title).toBe(creative.hook.title);
    expect(content.slides[1].title).toContain(ITEM.title);
    expect(content.slides[2].cta).toBeTruthy();
    expect(content.caption).toContain(creative.cta);
    expect(content.caption).toContain('link in bio');
    expect(instagramReelLedgerFields(creative)).toMatchObject({
      creativeBaseId: 'reel',
      creativeFormat: 'reel',
      primaryMetric: creative.primaryMetric,
      engagementMechanic: creative.primaryMetric === 'comments' ? 'keyword-comment' : expect.any(String),
      hookType: creative.hookType,
      attentionMechanic: creative.attentionMechanic,
      engagementLoop: creative.engagementLoop,
      followUpFormat: creative.followUpFormat,
    });
  });

  it('uses a low-friction keyword prompt for the comment treatment', () => {
    const article = chooseInstagramReelCreative({ kind: 'article', day: '2026-10-08' });
    const job = chooseInstagramReelCreative({ kind: 'job', day: '2026-10-07' });
    expect(article).toMatchObject({ id: 'reel-question', primaryMetric: 'comments' });
    expect(job).toMatchObject({ id: 'reel-question', primaryMetric: 'comments' });
    expect(article.cta).toContain('“GUIDA”');
    expect(job.cta).toContain('“LAVORO”');
    expect(instagramReelLedgerFields(article).engagementMechanic).toBe('keyword-comment');
  });

  it('does not guess a mechanic for an unknown future metric', () => {
    expect(instagramReelLedgerFields({ primaryMetric: 'replies' }).engagementMechanic).toBe('unknown');
  });

  it('accepts a verified vertical video in the same guarded queue', () => {
    const entry = buildQueueEntry({
      channel: 'instagram',
      kind: 'reel',
      day: '2026-10-10',
      caption: 'Una domanda utile\n#frontalieri',
      imageUrls: ['https://cdn.frontaliereticino.ch/images/social/instagram/reel-cover.jpg'],
      video: {
        url: 'https://cdn.frontaliereticino.ch/images/social/instagram/reel.mp4',
        bytes: 1234,
        sha256: 'a'.repeat(64),
        durationMs: 12000,
        width: 1080,
        height: 1920,
      },
      ledgerEntries: [{ id: 'job:infermiere-eoc-lugano', kind: 'reel' }],
    });
    expect(entry.id).toBe('reel-2026-10-10');
    expect(selectNextPending({ pending: [entry] }, { channel: 'instagram', now: Date.parse('2026-10-10T12:00:00Z') })).toMatchObject({
      id: 'reel-2026-10-10',
      video: { width: 1080, height: 1920 },
    });
  });

  it('does not replace an active Reel cohort before it is published', () => {
    const current = {
      id: 'reel-current',
      channel: 'instagram',
      kind: 'reel',
      createdAt: '2026-10-10T02:00:00Z',
      expiresAt: '2026-10-12T02:00:00Z',
      ledgerEntries: [{ creativeId: 'reel-number' }],
    };
    expect(pendingInstagramReel({ pending: [current] }, Date.parse('2026-10-10T10:00:00Z'))).toEqual(current);
    expect(pendingInstagramReel({ pending: [current] }, Date.parse('2026-10-12T02:00:00Z'))).toBeNull();
  });

  it('waits 72 hours before opening the next Reel cohort', () => {
    const posted = {
      queueId: 'reel-2026-10-11',
      kind: 'reel',
      ts: '2026-10-11T09:30:00Z',
      creativeId: 'reel-question',
    };
    expect(recentInstagramReel({ posted: [posted] }, Date.parse('2026-10-13T08:00:00Z'))).toEqual(posted);
    expect(recentInstagramReel({ posted: [posted] }, Date.parse('2026-10-14T09:30:00Z'))).toBeNull();
    expect(recentInstagramReel({ posted: [{ ...posted, ts: '2026-10-14T10:00:00Z' }] }, Date.parse('2026-10-13T08:00:00Z'))).toBeNull();
    expect(recentInstagramReel({ posted: [{ ...posted, kind: 'article' }] }, Date.parse('2026-10-13T08:00:00Z'))).toBeNull();
  });
});
