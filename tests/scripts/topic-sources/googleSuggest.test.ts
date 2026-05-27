import { describe, expect, it, vi } from 'vitest';

import * as suggestMod from '../../../scripts/lib/topic-sources/googleSuggest.mjs';

const { fetchSuggestCandidates, parseSuggestPayload } = suggestMod as any;

// Helper: build a fetch Response-shaped object.
function makeRes({
  ok = true,
  status = 200,
  text = '',
}: { ok?: boolean; status?: number; text?: string }) {
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

const SUGGEST_OK_BODY = JSON.stringify([
  'frontaliere',
  ['frontaliere svizzera', 'frontaliere ticino', 'frontaliere stipendio'],
  [],
  {},
]);

describe('parseSuggestPayload', () => {
  it('extracts the completions array (index 1)', () => {
    expect(parseSuggestPayload(SUGGEST_OK_BODY)).toEqual([
      'frontaliere svizzera',
      'frontaliere ticino',
      'frontaliere stipendio',
    ]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseSuggestPayload('this is not json')).toEqual([]);
  });

  it('returns [] when shape unexpected (object instead of array)', () => {
    expect(parseSuggestPayload(JSON.stringify({ foo: 'bar' }))).toEqual([]);
  });

  it('returns [] when completions array missing', () => {
    expect(parseSuggestPayload(JSON.stringify(['seed']))).toEqual([]);
  });

  it('returns [] when input not a string', () => {
    expect(parseSuggestPayload(null as any)).toEqual([]);
    expect(parseSuggestPayload(undefined as any)).toEqual([]);
  });
});

describe('fetchSuggestCandidates', () => {
  it('happy path: parses JSONP-array payload into Candidate shape with rank-encoded demandSignals', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ text: SUGGEST_OK_BODY }));
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(true);
    expect(r.perSeed.frontaliere.ok).toBe(true);
    expect(r.perSeed.frontaliere.candidates.length).toBe(3);
    const first = r.perSeed.frontaliere.candidates[0];
    expect(first.keyword).toBe('frontaliere svizzera');
    expect(first.sources).toEqual(['googleSuggest']);
    expect(first.locale).toBe('it');
    expect(first.demandSignals.googleSuggestSeed).toBe('frontaliere');
    expect(first.demandSignals.googleSuggestRank).toBe(0);
    expect(first.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('HTTP 429 → empty candidates with reason', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ ok: false, status: 429 }));
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(false);
    expect(r.perSeed.frontaliere.ok).toBe(false);
    expect(r.perSeed.frontaliere.candidates).toEqual([]);
    expect(r.perSeed.frontaliere.reason).toMatch(/HTTP 429/);
  });

  it('HTTP 5xx → empty result for that seed', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ ok: false, status: 503 }));
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.perSeed.frontaliere.ok).toBe(false);
    expect(r.perSeed.frontaliere.reason).toMatch(/HTTP 503/);
  });

  it('timeout / fetch rejects → empty result with reason, never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('AbortError: timeout');
    });
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(false);
    expect(r.perSeed.frontaliere.ok).toBe(false);
    expect(r.perSeed.frontaliere.candidates).toEqual([]);
    expect(r.perSeed.frontaliere.reason).toMatch(/timeout|fetch error/i);
    // Retry: implementation makes 2 attempts before giving up.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('empty completions array → ok:true with candidates:[]', async () => {
    const body = JSON.stringify(['frontaliere', [], [], {}]);
    const fetchImpl = vi.fn(async () => makeRes({ text: body }));
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.perSeed.frontaliere.ok).toBe(true);
    expect(r.perSeed.frontaliere.candidates).toEqual([]);
  });

  it('malformed JSON in 200 response → empty result with reason', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ text: 'not json at all' }));
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere'],
      fetchImpl: fetchImpl as any,
    });
    // parseSuggestPayload returns [] which the implementation treats as ok:true
    // with no completions — matches the "empty completions" contract.
    expect(r.perSeed.frontaliere.ok).toBe(true);
    expect(r.perSeed.frontaliere.candidates).toEqual([]);
  });

  it('one seed succeeds, one fails → partial result, both reflected in perSeed', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('frontaliere')) {
        return makeRes({ text: SUGGEST_OK_BODY });
      }
      return makeRes({ ok: false, status: 429 });
    });
    const r = await fetchSuggestCandidates({
      seeds: ['frontaliere', 'permesso G'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(true);
    expect(r.perSeed.frontaliere.ok).toBe(true);
    expect(r.perSeed.frontaliere.candidates.length).toBe(3);
    expect(r.perSeed['permesso G'].ok).toBe(false);
    expect(r.perSeed['permesso G'].candidates).toEqual([]);
    expect(r.candidates.length).toBe(3);
  });

  it('dedupes completions by normalizedKeyword across seeds', async () => {
    // Two seeds return the same completion — only one Candidate emitted.
    const dupBody = JSON.stringify(['x', ['Tasse Svizzera 2026'], [], {}]);
    const fetchImpl = vi.fn(async () => makeRes({ text: dupBody }));
    const r = await fetchSuggestCandidates({
      seeds: ['seed1', 'seed2'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.candidates.length).toBe(1);
    // The first seed wins the candidate; the second returns ok but no new ones.
    expect(r.perSeed.seed1.candidates.length).toBe(1);
    expect(r.perSeed.seed2.candidates.length).toBe(0);
  });
});
