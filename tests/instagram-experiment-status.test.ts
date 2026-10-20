import { describe, expect, it } from 'vitest';

import { parseArgs } from '../scripts/instagram-experiment-status.mjs';
import { buildExperimentStatus } from '../scripts/lib/instagram-experiment-status.mjs';

const AS_OF_MS = Date.now();
const AS_OF = new Date(AS_OF_MS).toISOString();

type LedgerOverrides = {
  queueId?: string;
  ts?: string;
  creativeId?: string;
  id?: string;
  [key: string]: unknown;
};

function ledgerEntry({ queueId = 'article-1', ts, creativeId = 'proof-local', id = 'card-1', ...overrides }: LedgerOverrides = {}) {
  return {
    id,
    kind: 'article',
    day: 'relative-fixture-day',
    queueId,
    ts: ts || new Date(AS_OF_MS - (4 * 24 * 3_600_000)).toISOString(),
    creativeId,
    creativeBaseId: 'proof',
    creativeVariant: 'local',
    creativeLabel: 'Dato locale',
    creativeObjective: 'share',
    primaryMetric: 'shares',
    engagementMechanic: 'direct-share',
    hookType: 'local-ranking',
    attentionMechanic: 'local-relevance',
    engagementLoop: 'share-to-local-group',
    followUpFormat: 'story-poll',
    ...overrides,
  };
}

function carouselLedger(queueId = 'article-1', creativeId = 'proof-local', publishedAt = null) {
  const ts = publishedAt || new Date(AS_OF_MS - (4 * 24 * 3_600_000)).toISOString();
  return Array.from({ length: 5 }, (_, index) => ledgerEntry({
    queueId,
    creativeId,
    ts,
    id: `${queueId}-card-${index + 1}`,
  }));
}

describe('Instagram experiment status', () => {
  it('counts a five-card carousel as one published post', () => {
    const status = buildExperimentStatus({
      ledger: { posted: carouselLedger() },
      asOf: AS_OF,
      hasCredentials: true,
    });

    expect(status.publishedPosts).toHaveLength(1);
    expect(status.publishedPosts[0]).toMatchObject({ entries: 5, eligibleForExperiment: true, hookType: 'local-ranking' });
    expect(status.cohorts[0]).toMatchObject({ publishedPosts: 1, observedPosts: 0, status: 'awaiting-insights', engagementLoop: 'share-to-local-group' });
    expect(status.insights.independentObservations).toBe(0);
  });

  it('surfaces a pending Reel and preserves its creative mechanism', () => {
    const status = buildExperimentStatus({
      queue: {
        pending: [{
          id: 'reel-relative',
          kind: 'reel',
          createdAt: AS_OF,
          ledgerEntries: [{
            creativeId: 'reel-question',
            creativeObjective: 'conversation',
            primaryMetric: 'comments',
            engagementMechanic: 'keyword-comment',
            hookType: 'question',
            attentionMechanic: 'specific-keyword',
            engagementLoop: 'keyword-comment-reply',
            followUpFormat: 'comment-reply-reel',
          }],
        }],
      },
      asOf: AS_OF,
      hasCredentials: true,
    });

    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]).toMatchObject({
      id: 'reel-relative',
      kind: 'reel',
      creativeId: 'reel-question',
      engagementMechanic: 'keyword-comment',
      engagementLoop: 'keyword-comment-reply',
    });
    expect(status.nextAction).toBe('publish-pending-creative');
  });

  it('does not report a queue item that the ledger already published for the same kind-day', () => {
    const status = buildExperimentStatus({
      ledger: { posted: carouselLedger('article-1', 'proof-local', new Date(AS_OF_MS - (4 * 24 * 3_600_000)).toISOString()) },
      queue: {
        pending: [{
          id: 'article-1',
          kind: 'article',
          day: 'relative-fixture-day',
          createdAt: AS_OF,
          ledgerEntries: [{ creativeId: 'proof-local', primaryMetric: 'shares' }],
        }],
      },
      asOf: AS_OF,
      hasCredentials: true,
    });

    expect(status.pending).toEqual([]);
    expect(status.nextActions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'publish-pending-creative' }),
    ]));
  });

  it('makes the Meta credential blocker explicit before claiming a result', () => {
    const status = buildExperimentStatus({
      ledger: { posted: carouselLedger() },
      asOf: AS_OF,
      hasCredentials: false,
    });

    expect(status.cohorts[0].status).toBe('awaiting-meta-credentials');
    expect(status.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'meta-credentials-missing' }),
      expect.objectContaining({ code: 'insights-snapshot-missing' }),
    ]));
    expect(status.nextAction).toBe('configure-meta-insights');
    expect(JSON.stringify(status)).not.toContain('access_token');
  });

  it('deduplicates media and queue identities and becomes comparable at three posts', () => {
    const posted = [
      ...carouselLedger('article-1', 'proof-local'),
      ...carouselLedger('article-2', 'proof-local', new Date(AS_OF_MS - (5 * 24 * 3_600_000)).toISOString()),
      ...carouselLedger('article-3', 'proof-local', new Date(AS_OF_MS - (6 * 24 * 3_600_000)).toISOString()),
    ];
    const insights = {
      posts: [
        { id: 'media-1', queueId: 'article-1', creativeId: 'proof-local', kind: 'article', windowHours: 72 },
        { id: 'media-1', queueId: 'article-1', creativeId: 'proof-local', kind: 'article', windowHours: 72 },
        { id: 'media-2', queueId: 'article-2', creativeId: 'proof-local', kind: 'article', windowHours: 72 },
        { id: 'media-3', queueId: 'article-3', creativeId: 'proof-local', kind: 'article', windowHours: 72 },
      ],
    };

    const status = buildExperimentStatus({
      ledger: { posted },
      insights,
      asOf: AS_OF,
      hasCredentials: true,
    });

    expect(status.publishedPosts).toHaveLength(3);
    expect(status.publishedPosts.every((post) => post.entries === 5)).toBe(true);
    expect(status.cohorts).toEqual([
      expect.objectContaining({
        creativeId: 'proof-local',
        publishedPosts: 3,
        observedPosts: 3,
        independentObservations: 3,
        eligible: true,
        status: 'ready-to-compare',
      }),
    ]);
    expect(status.insights).toMatchObject({ sourceRows: 4, acceptedRows: 3, independentObservations: 3 });
    expect(status.insights.rejectedRows).toEqual([
      expect.objectContaining({ reason: 'duplicate post/window observation' }),
    ]);
    expect(status.nextAction).toBe('compare-eligible-cohorts');
  });

  it('does not let a non-target window count as a 72h observation', () => {
    const status = buildExperimentStatus({
      ledger: { posted: carouselLedger() },
      insights: { posts: [{ id: 'media-1', queueId: 'article-1', windowHours: 24 }] },
      asOf: AS_OF,
      hasCredentials: true,
    });

    expect(status.cohorts[0]).toMatchObject({ observedPosts: 0, eligible: false });
    expect(status.insights.acceptedRows).toBe(0);
    expect(status.insights.rejectedRows[0].reason).toContain('target is 72h');
  });

  it('flags conflicting creative metadata instead of attributing an observation', () => {
    const status = buildExperimentStatus({
      ledger: {
        posted: [
          ledgerEntry({ id: 'card-1', creativeId: 'proof-local' }),
          ledgerEntry({ id: 'card-2', creativeId: 'save-checklist' }),
        ],
      },
      insights: { posts: [{ id: 'media-1', queueId: 'article-1', windowHours: 72 }] },
      asOf: AS_OF,
      hasCredentials: true,
    });

    expect(status.cohorts).toHaveLength(0);
    expect(status.publishedPosts[0]).toMatchObject({
      entries: 2,
      eligibleForExperiment: false,
      status: 'metadata-conflict',
    });
    expect(status.blockers[0].code).toBe('creative-metadata-incomplete');
  });

  it('parses safe CLI defaults and explicit status options', () => {
    expect(parseArgs(['--json', '--window-hours=24', '--min-observations', '2', '--queue', 'queue.json'])).toMatchObject({
      json: true,
      windowHours: 24,
      minimumObservations: 2,
      queue: 'queue.json',
    });
  });
});
