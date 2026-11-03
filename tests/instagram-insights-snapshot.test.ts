import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  buildSnapshotDocument,
  collectSnapshots,
  fetchOptionalReelInsights,
  groupPostedLedger,
  matchLedgerToMedia,
  normalizeMediaInsights,
  selectSnapshotCandidates,
} from '../scripts/lib/instagram-insights-snapshot.mjs';
import { parseArgs } from '../scripts/instagram-insights-snapshot.mjs';
import { buildNativeSocialPerformanceBrief } from '../scripts/social-copy/native-performance-brief.mjs';

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
    copyMode: 'codex',
    copySlot: 'article',
    copyAssignmentMode: 'firebase-balanced',
    copyExperimentId: 'social-copy-balanced-v1',
    copyRegistrationHash: 'a'.repeat(64),
    copyBlockId: 'b'.repeat(64),
    copyBlockCycle: 0,
    copyPromptVersion: 'frontaliere-social-copy-v1',
    copyPackId: '0123456789abcdef',
    copyTemplateId: 'ig-article-uno',
    copyObjective: 'share',
    copyHook: 'Un dettaglio utile per chi lavora oltre confine',
    copyCta: 'Approfondisci dal link in bio',
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
  it('loads only the Remote Config decision keys used by the evaluator', () => {
    const workflow = readFileSync(new URL('../.github/workflows/instagram-insights-snapshot.yml', import.meta.url), 'utf8');
    expect([...workflow.matchAll(/load-rc-env\.mjs/gu)]).toHaveLength(1);
    const allowlist = workflow.match(/(?:node\s+)?(?:\.\/)?scripts\/load-rc-env\.mjs\s+--only-env=([A-Z0-9_,]+)/u)?.[1];
    expect(allowlist).toBe('INSTAGRAM_INSIGHTS_AUTONOMOUS_DECISIONS_ENABLED,INSTAGRAM_INSIGHTS_DECISION_WINDOW_HOURS,INSTAGRAM_INSIGHTS_MIN_OBSERVATIONS,INSTAGRAM_INSIGHTS_MIN_RELATIVE_LIFT,INSTAGRAM_INSIGHTS_MIN_ABSOLUTE_LIFT,INSTAGRAM_AUTONOMOUS_CREATIVE_WINNERS,INSTAGRAM_CAROUSEL_BACKGROUND_AB_WINNERS');
  });

  it('groups carousel ledger rows and skips a window already recorded', () => {
    const ledger = {
      posted: [ledgerEntry(), ledgerEntry({ id: 'item-2' })],
    };
    const groups = groupPostedLedger(ledger);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      queueId: 'article-2026-10-07',
      creativeId: 'proof-local',
      copySlot: 'article',
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-balanced-v1',
      copyRegistrationHash: 'a'.repeat(64),
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

  it('does not pool cards when their background arm conflicts inside one carousel', () => {
    const selected = selectSnapshotCandidates(
      {
        posted: [
          ledgerEntry({ backgroundVariant: 'navy-gradient' }),
          ledgerEntry({ id: 'item-2', backgroundVariant: 'paper-amber' }),
        ],
      },
      null,
      { asOf: AS_OF, windowHours: 72 },
    );
    expect(selected.candidates).toHaveLength(0);
    expect(selected.skipped).toContainEqual({ reason: 'conflicting-creative-metadata' });
  });

  it('does not pool carousel cards with conflicting copy attribution', () => {
    const selected = selectSnapshotCandidates(
      {
        posted: [
          ledgerEntry({
            copyAngleId: 'article-practical-question',
            copyPillarId: 'strumenti-utili',
            copyAngleIntent: 'both',
          }),
          ledgerEntry({ id: 'item-2' }),
        ],
      },
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
      profileVisits: null,
      linkClicks: null,
      views: null,
      availableMetrics: ['comments', 'reach', 'saves', 'shares'],
    });
  });

  it('rejects snapshots collected after the measurement window expired', () => {
    const selected = selectSnapshotCandidates(
      { posted: [ledgerEntry()] },
      null,
      { asOf: '2026-10-11T00:00:00.000Z', windowHours: 72, toleranceHours: 6 },
    );
    expect(selected.candidates).toHaveLength(0);
    expect(selected.skipped).toContainEqual({ reason: 'window-expired' });
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
      ledger: { posted: [ledgerEntry({
        instagramMediaId: 'm-1',
        copyAngleId: 'article-practical-question',
        copyPillarId: 'strumenti-utili',
        copyAngleIntent: 'both',
      })] },
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
      copyMode: 'codex',
      copySlot: 'article',
      copyAssignmentMode: 'firebase-balanced',
      copyExperimentId: 'social-copy-balanced-v1',
      copyRegistrationHash: 'a'.repeat(64),
      copyBlockId: 'b'.repeat(64),
      copyBlockCycle: 0,
      copyPromptVersion: 'frontaliere-social-copy-v1',
      copyPackId: '0123456789abcdef',
      copyTemplateId: 'ig-article-uno',
      copyObjective: 'share',
      copyAngleId: 'article-practical-question',
      copyPillarId: 'strumenti-utili',
      copyAngleIntent: 'both',
      copyHook: 'Un dettaglio utile per chi lavora oltre confine',
      copyCta: 'Approfondisci dal link in bio',
      copyAttributionStatus: 'exact',
      reach: 100,
      shares: 12,
      saves: 8,
      matchMethod: 'ledger-media-id',
    });
    const brief = buildNativeSocialPerformanceBrief({
      asOf: new Date(AS_OF),
      minimumObservations: 1,
      instagramInsights: { posts: result.additions },
    });
    expect(brief.variants[0]).toMatchObject({
      channel: 'instagram',
      copySlot: 'article',
      assignmentMode: 'firebase-balanced',
      templateId: 'ig-article-uno',
      metrics: {
        savesPerThousandReach: { status: 'descriptive-sample', observations: 1, median: 80 },
      },
    });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('token-not-printed');
  });

  it('keeps timestamp-matched creative metadata out of the Codex performance brief', async () => {
    const fetchImpl = async (url: string) => {
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
          { name: 'shares', values: [{ value: 12 }] },
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

    expect(result.additions[0]).toMatchObject({
      matchMethod: 'confirmation-timestamp',
      copyAttributionStatus: 'inferred',
    });
    const brief = buildNativeSocialPerformanceBrief({
      asOf: new Date(AS_OF),
      minimumObservations: 1,
      instagramInsights: { posts: result.additions },
    });
    expect(brief.variants).toEqual([]);
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

  it('probes each optional Reel metric independently and retains unsupported metrics as unavailable', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const metric = new URL(url).searchParams.get('metric');
      if (metric === 'views') return response({ data: [{ name: 'views', values: [{ value: 900 }] }] });
      if (metric === 'follows') return response({ error: { code: 100, message: 'Unsupported metric' } }, 400);
      if (metric === 'ig_reels_avg_watch_time') return response({ data: [{ name: metric, values: [{ value: 2.75 }] }] });
      if (metric === 'ig_reels_video_view_total_time') return response({ data: [{ name: metric, values: [{ value: 45000 }] }] });
      if (metric === 'reels_skip_rate') return response({ data: [{ name: metric, values: [{ value: 0.35 }] }] });
      throw new Error(`unexpected metric: ${metric}`);
    };

    const result = await fetchOptionalReelInsights('reel-media', 'secret-token', { fetchImpl });

    expect(calls).toHaveLength(5);
    expect(calls.every((url) => new URL(url).searchParams.get('metric')?.split(',').length === 1)).toBe(true);
    expect(result).toEqual({
      metrics: {
        views: 900,
        follows: null,
        igReelsAvgWatchTime: 2.75,
        igReelsVideoViewTotalTime: 45000,
        reelsSkipRate: 0.35,
      },
      metricStatus: {
        views: 'available',
        follows: 'metric-unavailable',
        igReelsAvgWatchTime: 'available',
        igReelsVideoViewTotalTime: 'available',
        reelsSkipRate: 'available',
      },
      availableMetrics: ['views', 'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate'],
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('retries Reel snapshots with a transiently unavailable metric, but not an explicitly unsupported metric', () => {
    const existingRow = {
      mediaId: 'reel-media',
      kind: 'reel',
      day: '2026-10-07',
      creativeId: 'proof-local',
      publishedAt: PUBLISHED,
      snapshotAt: AS_OF,
      snapshotAgeHours: 72,
      windowHours: 72,
      mediaType: 'VIDEO',
      metricStatus: { follows: 'unavailable' },
    };
    const ledger = { posted: [ledgerEntry({ kind: 'reel', instagramMediaId: 'reel-media' })] };
    expect(selectSnapshotCandidates(ledger, { posts: [existingRow] }, { asOf: AS_OF }).candidates).toHaveLength(1);
    const explicitlyUnsupported = Object.fromEntries([
      'views', 'follows', 'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate',
    ].map((metric) => [metric, 'metric-unavailable']));
    expect(selectSnapshotCandidates(ledger, {
      posts: [{ ...existingRow, metricStatus: explicitlyUnsupported }],
    }, { asOf: AS_OF }).candidates).toHaveLength(0);
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
    expect(document).toMatchObject({ schemaVersion: 2, windowHours: 72, generatedAt: AS_OF });
  });

  it('refreshes an existing exact-media snapshot when an optional metric becomes available', () => {
    const existing = {
      mediaId: 'reel-media', windowHours: 72, snapshotAt: AS_OF,
      metricStatus: { follows: 'unavailable' }, follows: null,
    };
    const updated = { ...existing, metricStatus: { follows: 'available' }, follows: 4 };
    const document = buildSnapshotDocument({ posts: [existing] }, [updated], { generatedAt: AS_OF });
    expect(document.posts).toEqual([updated]);
  });

  it('parses safe CLI defaults and explicit preview options', () => {
    expect(parseArgs(['--dry-run', '--json', '--output=insights.json', '--as-of', AS_OF, '--tolerance-hours=0'])).toMatchObject({
      dryRun: true,
      json: true,
      asOf: AS_OF,
      toleranceHours: 0,
      windowHours: 72,
    });
  });
});
