import { describe, expect, it } from 'vitest';

import {
  buildSnapshotDocument,
  collectSnapshots,
  groupPostedLedger,
  matchLedgerToMedia,
  normalizeMediaInsights,
  selectSnapshotCandidates,
} from '../scripts/lib/instagram-insights-snapshot.mjs';
import { parseArgs } from '../scripts/instagram-insights-snapshot.mjs';

const AS_OF = '2026-10-10T12:00:00.000Z';
const PUBLISHED = '2026-10-07T12:00:00.000Z';

function ledgerEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    kind: 'article',
    day: '2026-10-07',
    queueId: 'article-2026-10-07',
    ts: PUBLISHED,
    creativeId: 'proof-local',
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

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('Instagram Insights snapshot collector', () => {
  it('groups carousel ledger rows and skips a window already recorded', () => {
    const ledger = {
      posted: [ledgerEntry(), ledgerEntry({ id: 'item-2' })],
    };
    const groups = groupPostedLedger(ledger);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      queueId: 'article-2026-10-07',
      creativeId: 'proof-local',
      engagementMechanic: 'direct-share',
      hookType: 'local-ranking',
      engagementLoop: 'share-to-local-group',
      entries: 2,
    });

    const selected = selectSnapshotCandidates(
      ledger,
      { posts: [{ queueId: 'article-2026-10-07', windowHours: 72 }] },
      { asOf: AS_OF, windowHours: 72 },
    );
    expect(selected.candidates).toHaveLength(0);
    expect(selected.skipped).toContainEqual({ reason: 'snapshot-already-recorded' });
  });

  it('does not guess when creative metadata conflicts inside one carousel', () => {
    const selected = selectSnapshotCandidates(
      { posted: [ledgerEntry(), ledgerEntry({ id: 'item-2', creativeId: 'save-checklist' })] },
      null,
      { asOf: AS_OF, windowHours: 72 },
    );
    expect(selected.candidates).toHaveLength(0);
    expect(selected.skipped).toContainEqual({ reason: 'conflicting-creative-metadata' });
  });

  it('matches a timestamp only when one media candidate is clearly closest', () => {
    const group = { identity: 'article-1', publishedAtMs: Date.parse(PUBLISHED), mediaId: null };
    const result = matchLedgerToMedia(
      [group],
      [{ id: 'm-1', timestamp: '2026-10-07T11:59:00Z', permalink: 'https://instagram.test/p/1' }],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].method).toBe('confirmation-timestamp');
  });

  it('rejects an ambiguous timestamp and a ledger media id missing from the account result', () => {
    const group = { identity: 'article-1', publishedAtMs: Date.parse(PUBLISHED), mediaId: null };
    const ambiguous = matchLedgerToMedia(
      [group],
      [
        { id: 'm-1', timestamp: '2026-10-07T11:59:30Z' },
        { id: 'm-2', timestamp: PUBLISHED },
      ],
    );
    expect(ambiguous.matches).toHaveLength(0);
    expect(ambiguous.unmatched[0].reason).toBe('ambiguous-media-timestamp');

    const missingId = matchLedgerToMedia(
      [{ ...group, mediaId: 'm-authoritative' }],
      [{ id: 'm-other', timestamp: PUBLISHED }],
    );
    expect(missingId.matches).toHaveLength(0);
    expect(missingId.unmatched[0].reason).toBe('ledger-media-id-not-returned');
  });

  it('normalizes Meta-like nested metric data and aliases saved to saves', () => {
    expect(normalizeMediaInsights({ insights: { data: [
      { name: 'reach', values: [{ value: 120 }] },
      { name: 'saved', values: [{ value: 9 }] },
      { name: 'shares', values: [{ value: 4 }] },
      { name: 'comments', values: [{ value: 2 }] },
    ] } })).toEqual({
      reach: 120,
      saves: 9,
      shares: 4,
      comments: 2,
      profileVisits: 0,
      linkClicks: 0,
    });
  });

  it('collects one read-only snapshot and preserves the creative join', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('/account-1/media?')) {
        return response({ data: [{
          id: 'm-1',
          timestamp: PUBLISHED,
          media_type: 'CAROUSEL_ALBUM',
          permalink: 'https://instagram.test/p/1',
        }] });
      }
      if (url.includes('/m-1/insights?')) {
        return response({ data: [
          { name: 'reach', values: [{ value: 100 }] },
          { name: 'saved', values: [{ value: 8 }] },
          { name: 'shares', values: [{ value: 12 }] },
          { name: 'comments', values: [{ value: 3 }] },
        ] });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await collectSnapshots({
      ledger: { posted: [ledgerEntry()] },
      accountId: 'account-1',
      accessToken: 'token-not-printed',
      asOf: AS_OF,
      fetchImpl,
    });

    expect(result.status).toBe('snapshots-added');
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({
      mediaId: 'm-1',
      creativeId: 'proof-local',
      creativeBaseId: 'proof',
      creativeVariant: 'local',
      creativeLabel: 'Dato locale',
      primaryMetric: 'shares',
      engagementMechanic: 'direct-share',
      hookType: 'local-ranking',
      attentionMechanic: 'local-relevance',
      engagementLoop: 'share-to-local-group',
      followUpFormat: 'story-poll',
      reach: 100,
      shares: 12,
      saves: 8,
      matchMethod: 'confirmation-timestamp',
    });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('token-not-printed');
  });

  it('returns a clean non-network result without credentials', async () => {
    const result = await collectSnapshots({
      ledger: { posted: [ledgerEntry()] },
      asOf: AS_OF,
      accountId: '',
      accessToken: '',
      fetchImpl: async () => { throw new Error('network must not be called'); },
    });
    expect(result).toMatchObject({ status: 'credentials-missing', candidates: 1, additions: [] });
  });

  it('builds a deduplicated snapshot document', () => {
    const addition = {
      postId: 'm-1',
      queueId: 'article-2026-10-07',
      windowHours: 72,
      snapshotAt: AS_OF,
      creativeId: 'proof-local',
      reach: 100,
      shares: 12,
    };
    const document = buildSnapshotDocument(
      { posts: [addition] },
      [addition],
      { generatedAt: AS_OF, windowHours: 72 },
    );
    expect(document.posts).toHaveLength(1);
    expect(document).toMatchObject({ schemaVersion: 1, windowHours: 72, generatedAt: AS_OF });
  });

  it('parses safe CLI defaults and explicit preview options', () => {
    expect(parseArgs(['--dry-run', '--json', '--as-of', AS_OF, '--tolerance-hours=0'])).toMatchObject({
      dryRun: true,
      json: true,
      asOf: AS_OF,
      toleranceHours: 0,
      windowHours: 72,
    });
  });
});
