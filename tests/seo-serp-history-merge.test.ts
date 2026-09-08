import { describe, expect, it } from 'vitest';
import { MAX_SERP_HISTORY_SNAPSHOTS, mergeSeoSerpHistory } from '../scripts/lib/merge-seo-serp-experiment-history.mjs';

describe('merge SEO SERP experiment history', () => {
  it('unisce i writer concorrenti senza perdere snapshot e deduplica le chiavi', () => {
    const current = { updatedAt: '2026-09-08T09:00:00Z', snapshots: [{ createdAt: '2026-09-08T08:00:00Z', variant: 'a', period: 'week' }] };
    const incoming = { updatedAt: '2026-09-08T10:00:00Z', snapshots: [
      { createdAt: '2026-09-08T08:00:00Z', variant: 'a', period: 'week' },
      { createdAt: '2026-09-08T09:00:00Z', variant: 'b', period: 'week' },
    ] };
    const merged = mergeSeoSerpHistory(current, incoming);
    expect(merged.updatedAt).toBe(incoming.updatedAt);
    expect(merged.snapshots).toHaveLength(2);
    expect(merged.snapshots.map((snapshot) => snapshot.variant)).toEqual(['a', 'b']);
  });

  it(`mantiene solo le ultime ${MAX_SERP_HISTORY_SNAPSHOTS} osservazioni`, () => {
    const snapshots = Array.from({ length: MAX_SERP_HISTORY_SNAPSHOTS + 7 }, (_, index) => ({ createdAt: `2026-01-${String(index + 1).padStart(3, '0')}`, variant: 'a', period: 'week' }));
    const merged = mergeSeoSerpHistory({ snapshots: [] }, { snapshots });
    expect(merged.snapshots).toHaveLength(MAX_SERP_HISTORY_SNAPSHOTS);
    expect(merged.snapshots[0].createdAt).toBe(snapshots[7].createdAt);
  });
});
