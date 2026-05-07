// tests/scripts/lib/discovery/sources/orphanQuerySource.test.ts

import { describe, expect, it } from 'vitest';

import { fetchOrphanCandidates } from '../../../../../scripts/lib/discovery/sources/orphanQuerySource.mjs';

describe('fetchOrphanCandidates', () => {
  it('returns [] when evidence is empty', () => {
    expect(fetchOrphanCandidates({})).toEqual([]);
    expect(fetchOrphanCandidates(null as any)).toEqual([]);
    expect(fetchOrphanCandidates({ gsc: {} })).toEqual([]);
  });

  it('converts orphanQueries entries to discovery candidates', () => {
    const evidence = {
      gsc: {
        orphanQueries: [
          { query: 'tassazione frontalieri ticino', imp: 800, pos: 14, ctr: 0.005, clicks: 4, topLandingPage: '/articoli-frontaliere/foo' },
          { query: 'permesso g rinnovo 2026', imp: 500, pos: 22, ctr: 0.01, clicks: 5, topLandingPage: '/articoli-frontaliere/bar' },
        ],
      },
    };
    const out = fetchOrphanCandidates(evidence);
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe('orphan');
    expect(out[0].headline).toBe('tassazione frontalieri ticino');
    expect(out[0].url).toBe('/articoli-frontaliere/foo');
    expect(out[0].meta.imp).toBe(800);
    expect(out[0].meta.pos).toBe(14);
  });

  it('drops malformed entries (missing query)', () => {
    const evidence = {
      gsc: {
        orphanQueries: [
          { query: 'good one', imp: 100, pos: 10, ctr: 0.01 },
          { imp: 100 },
          { query: '   ', imp: 100 },
          null,
        ],
      },
    };
    const out = fetchOrphanCandidates(evidence as any);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe('good one');
  });

  it('dedupes by lowercased headline', () => {
    const evidence = {
      gsc: {
        orphanQueries: [
          { query: 'Tassazione Frontalieri', imp: 500, pos: 10, ctr: 0.01 },
          { query: 'tassazione frontalieri', imp: 100, pos: 12, ctr: 0.005 },
        ],
      },
    };
    const out = fetchOrphanCandidates(evidence);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe('Tassazione Frontalieri');
  });

  it('coerces numeric metas to 0 when missing', () => {
    const evidence = {
      gsc: { orphanQueries: [{ query: 'x y z' }] },
    };
    const out = fetchOrphanCandidates(evidence as any);
    expect(out).toHaveLength(1);
    expect(out[0].meta.imp).toBe(0);
    expect(out[0].meta.pos).toBe(0);
    expect(out[0].meta.ctr).toBe(0);
  });
});
