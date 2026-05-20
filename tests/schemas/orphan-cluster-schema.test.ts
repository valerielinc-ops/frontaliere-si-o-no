// tests/schemas/orphan-cluster-schema.test.ts
import { describe, it, expect } from 'vitest';
import { OrphanClusterSchema } from '../../scripts/lib/schemas/orphanCluster.mjs';

const valid = {
  clusterId: 'it-lavoro-magazziniere-ticino',
  locale: 'it',
  canonicalQuery: 'lavoro magazziniere ticino',
  canonicalSlug: 'lavoro-magazziniere-ticino',
  roleTokens: ['magazziniere', 'logistica'],
  regionTokens: ['ticino', 'lugano'],
  totalImpressions: 200,
  totalClicks: 6,
  queries: [
    { query: 'lavoro magazziniere ticino', impressions: 120, clicks: 4 },
    { query: 'magazziniere lugano', impressions: 80, clicks: 2 },
  ],
};

describe('OrphanClusterSchema', () => {
  it('accepts a valid cluster', () => {
    const r = OrphanClusterSchema.safeParse(valid);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });
  it('rejects empty queries', () => {
    expect(OrphanClusterSchema.safeParse({ ...valid, queries: [] }).success).toBe(false);
  });
  it('rejects missing canonicalQuery', () => {
    const { canonicalQuery, ...without } = valid;
    expect(OrphanClusterSchema.safeParse(without).success).toBe(false);
  });
});
