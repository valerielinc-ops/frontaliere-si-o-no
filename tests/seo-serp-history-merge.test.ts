import { describe, expect, it } from 'vitest';
import { MAX_SERP_HISTORY_SNAPSHOTS, mergeSeoSerpHistory } from '../scripts/lib/merge-seo-serp-experiment-history.mjs';

describe('merge SEO SERP experiment history', () => {
  it('unisce i writer concorrenti senza perdere snapshot e deduplica le chiavi', () => {
    const current = {
      sourceOnly: 'preserve-me',
      updatedAt: '2026-09-08T09:00:00Z',
      snapshots: [{
        createdAt: '2026-09-08T08:00:00Z',
        variant: 'a',
        period: 'week',
        kpi: { clicks: 1 },
      }],
    };
    const incoming = { updatedAt: '2026-09-08T10:00:00Z', snapshots: [
      { createdAt: '2026-09-08T10:00:00+02:00', variant: 'a', period: 'week', kpi: { clicks: 1 } },
      { createdAt: '2026-09-08T08:00:00Z', variant: 'a', period: 'week', kpi: { clicks: 2 } },
      { createdAt: '2026-09-09T09:00:00Z', variant: 'b', period: 'week' },
    ] };
    const merged = mergeSeoSerpHistory(current, incoming);
    expect(merged.updatedAt).toBe(incoming.updatedAt);
    expect(merged.sourceOnly).toBe('preserve-me');
    expect(merged.snapshots).toHaveLength(3);
    expect(merged.snapshots.map((snapshot) => snapshot.variant)).toEqual(['a', 'a', 'b']);
    expect(merged.snapshots.filter((snapshot) => snapshot.kpi?.clicks === 1)).toHaveLength(1);
    expect(mergeSeoSerpHistory(merged, incoming)).toEqual(merged);
  });

  it(`mantiene solo le ultime ${MAX_SERP_HISTORY_SNAPSHOTS} osservazioni`, () => {
    const snapshots = Array.from(
      { length: MAX_SERP_HISTORY_SNAPSHOTS + 7 },
      (_, index) => ({
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        variant: 'a',
        period: 'week',
      }),
    );
    const merged = mergeSeoSerpHistory({ snapshots: [] }, { snapshots });
    expect(merged.snapshots).toHaveLength(MAX_SERP_HISTORY_SNAPSHOTS);
    expect(merged.snapshots[0].createdAt).toBe(snapshots[7].createdAt);
  });

  it('scarta i timestamp invalidi prima di applicare il tetto', () => {
    const snapshots = Array.from(
      { length: MAX_SERP_HISTORY_SNAPSHOTS + 1 },
      (_, index) => ({
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        variant: 'a',
        period: 'week',
      }),
    );
    snapshots.push({ createdAt: 'not-a-timestamp', variant: 'z', period: 'week' });

    const merged = mergeSeoSerpHistory({ snapshots: [] }, { snapshots });

    expect(merged.snapshots).toHaveLength(MAX_SERP_HISTORY_SNAPSHOTS);
    expect(merged.snapshots[0].createdAt).toBe(snapshots[1].createdAt);
    expect(merged.snapshots.every((snapshot) => snapshot.createdAt !== 'not-a-timestamp')).toBe(true);
  });

  it('ordina timestamp con fusi orari diversi per istante reale', () => {
    const merged = mergeSeoSerpHistory({ snapshots: [] }, {
      snapshots: [
        { createdAt: '2026-09-08T10:00:00+02:00', variant: 'early', period: 'week' },
        { createdAt: '2026-09-08T09:00:00Z', variant: 'late', period: 'week' },
      ],
    });

    expect(merged.snapshots.map((snapshot) => snapshot.variant)).toEqual(['early', 'late']);
  });
});
