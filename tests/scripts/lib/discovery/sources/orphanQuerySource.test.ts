// tests/scripts/lib/discovery/sources/orphanQuerySource.test.ts

import { describe, expect, it } from 'vitest';

import {
  fetchOrphanCandidates,
  isArticleableOrphanQuery,
} from '../../../../../scripts/lib/discovery/sources/orphanQuerySource.mjs';

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

  it('drops generic job-search orphans that lack a frontaliere article angle', () => {
    for (const query of [
      'lavoro a chiasso',
      'offerte di lavoro a chiasso',
      'cerco lavoro a chiasso svizzera',
    ]) {
      expect(isArticleableOrphanQuery(query)).toBe(false);
    }

    for (const query of [
      'lavoro ticino frontalieri permesso g',
      'busta paga svizzera frontalieri',
      'disoccupazione frontalieri',
    ]) {
      expect(isArticleableOrphanQuery(query)).toBe(true);
    }
  });

  it('filters generic job-search orphan candidates before scoring', () => {
    const evidence = {
      gsc: {
        orphanQueries: [
          { query: 'lavoro a chiasso', imp: 1000, pos: 8 },
          { query: 'offerte lavoro ticino frontalieri permesso g', imp: 500, pos: 11 },
        ],
      },
    };
    const out = fetchOrphanCandidates(evidence);
    expect(out.map((c) => c.headline)).toEqual([
      'offerte lavoro ticino frontalieri permesso g',
    ]);
  });

  it('does not treat "offerte"/"posti" alone as job-search intent (ambiguous outside retail/parking context)', () => {
    for (const query of [
      'offerte black friday svizzera',
      'offerte migros ticino',
      'posti auto lugano',
      'posti letto affitto chiasso',
    ]) {
      expect(isArticleableOrphanQuery(query)).toBe(true);
    }
  });

  it('still treats "offerte"/"posti" as job-search intent when a job word is also present', () => {
    for (const query of [
      'offerte lavoro parrucchiere svizzera',
      'posti di lavoro coiffure',
    ]) {
      expect(isArticleableOrphanQuery(query)).toBe(false);
    }
  });

  it('recognises measured vocational phrases that disambiguate "offerte"/"posti"', () => {
    for (const query of [
      'apprendistato ticino posti liberi',
      'posti di apprendistato in ticino',
      'offerte apprendistato ticino',
      'offerte di stage ticino',
      'offerte stage ticino',
      'posti di tirocinio ticino',
      'posti vacanti ticino',
    ]) {
      expect(isArticleableOrphanQuery(query)).toBe(false);
    }
  });

  it('does not let an unrelated vocational word turn a bare weak token into job intent', () => {
    for (const query of [
      'posti auto vicino allo stage musicale',
      'offerte hotel per apprendisti',
      'posti letto per tirocinanti',
      'stage teatrale posti numerati',
    ]) {
      expect(isArticleableOrphanQuery(query)).toBe(true);
    }
  });
});
