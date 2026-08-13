import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins the discovery safety-nets introduced in PR #887 (issue #893): the listing
// SHAPE auto-detect (bare array / `{data:[]}` / `{models:[]}`), the per-provider
// `maxAdd` cap, and the `offeredIds.size > 0` guard that stops a 200-with-empty-body
// from pre-exhausting (markStale) a whole provider's static chain entries. These are
// the headline regressions #887 fixed; without a committed test a future refactor of
// `_discoverProvider` (flip the guard, drop the cap) would stay green.

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as unknown as {
  _discoverProvider: (cfg: unknown) => Promise<{ added: number; stale: number }>;
  resetState: () => void;
  getStats: () => { exhaustedModels: string[] };
  prunedStaleModels: () => string[];
  DEFAULT_CHAIN: string[];
  DISCOVERY_PROVIDERS: ReadonlyArray<{ name: string; getList?: (d: unknown) => unknown[] }>;
};

const { _discoverProvider, resetState, getStats, prunedStaleModels, DEFAULT_CHAIN, DISCOVERY_PROVIDERS } = aiModels;

const PREFIX = 'testprov/';

type Cfg = Record<string, unknown>;

function makeCfg(overrides: Cfg = {}): Cfg {
  return {
    name: 'TestProv',
    prefix: PREFIX,
    getKey: () => 'fake-key',
    url: 'https://test.example/v1/models',
    pick: (m: { id?: string }) => m?.id ?? null,
    ...overrides,
  };
}

function mockFetch(body: unknown, { ok = true, status = 200 } = {}): void {
  // _discoverProvider only touches res.ok / res.status / res.json().
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok,
    status,
    json: async () => body,
  });
}

let originalFetch: typeof globalThis.fetch;
let baseChainLen = 0;

beforeEach(() => {
  resetState();
  originalFetch = globalThis.fetch;
  baseChainLen = DEFAULT_CHAIN.length;
});

afterEach(() => {
  // Drop anything discovery pushed onto the shared chain, and any seeded statics.
  DEFAULT_CHAIN.length = baseChainLen;
  resetState();
  globalThis.fetch = originalFetch;
});

describe('discovery listing SHAPE auto-detect (issue #893)', () => {
  it('bare top-level array (Together-style) → models added', async () => {
    mockFetch([{ id: 'm1' }, { id: 'm2' }]);
    const res = await _discoverProvider(makeCfg());
    expect(res.added).toBe(2);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}m1`);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}m2`);
  });

  it('OpenAI-compatible `{data:[]}` (most providers) → models added', async () => {
    mockFetch({ data: [{ id: 'm1' }] });
    const res = await _discoverProvider(makeCfg());
    expect(res.added).toBe(1);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}m1`);
  });

  it('`{models:[]}` via cfg.getList (Cohere-style) → models added', async () => {
    const cfg = makeCfg({
      getList: (d: { models?: unknown[] }) => (Array.isArray(d?.models) ? d.models : []),
      pick: (m: { name?: string }) => m?.name ?? null,
    });
    mockFetch({ models: [{ name: 'command-r' }] });
    const res = await _discoverProvider(cfg);
    expect(res.added).toBe(1);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}command-r`);
  });

  it('the real Cohere cfg.getList unwraps `{models:[]}` and rejects non-array bodies', () => {
    const cohere = DISCOVERY_PROVIDERS.find((p) => p.name === 'Cohere');
    if (!cohere?.getList) throw new Error('Cohere provider/getList missing');
    expect(cohere.getList({ models: [{ name: 'a' }, { name: 'b' }] })).toHaveLength(2);
    expect(cohere.getList({})).toEqual([]);
    expect(cohere.getList(null)).toEqual([]);
  });

  it('unrecognized body shape → empty list, nothing added', async () => {
    mockFetch({ unexpected: 'garbage' });
    const res = await _discoverProvider(makeCfg());
    expect(res.added).toBe(0);
    expect(DEFAULT_CHAIN.length).toBe(baseChainLen);
  });
});

describe('discovery `maxAdd` flood cap (issue #893)', () => {
  it('injects at most `maxAdd` new models even when the listing is larger', async () => {
    const listing = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}` }));
    mockFetch(listing);
    const res = await _discoverProvider(makeCfg({ maxAdd: 2 }));
    expect(res.added).toBe(2);
    // Exactly the first two (Set preserves listing order), the rest skipped.
    expect(DEFAULT_CHAIN.length).toBe(baseChainLen + 2);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}m0`);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}m1`);
    expect(DEFAULT_CHAIN).not.toContain(`${PREFIX}m2`);
  });
});

describe('discovery markStale empty-listing guard (issue #893 / #835)', () => {
  it('a 200 with an EMPTY body does NOT pre-exhaust the static chain', async () => {
    // Seed two static chain entries for this provider.
    DEFAULT_CHAIN.push(`${PREFIX}static-a`, `${PREFIX}static-b`);
    mockFetch([]); // glitch: usable listing came back empty
    const res = await _discoverProvider(makeCfg({ markStale: true }));
    expect(res.stale).toBe(0);
    const exhausted = getStats().exhaustedModels;
    expect(exhausted).not.toContain(`${PREFIX}static-a`);
    expect(exhausted).not.toContain(`${PREFIX}static-b`);
  });

  it('a NON-empty listing still pre-exhausts only the entries the provider dropped', async () => {
    DEFAULT_CHAIN.push(`${PREFIX}static-a`, `${PREFIX}static-b`);
    mockFetch([{ id: 'static-a' }]); // only static-a still offered
    const res = await _discoverProvider(makeCfg({ markStale: true }));
    expect(res.stale).toBe(1);
    const exhausted = getStats().exhaustedModels;
    expect(exhausted).toContain(`${PREFIX}static-b`); // decommissioned
    expect(exhausted).not.toContain(`${PREFIX}static-a`); // still live
  });
});

describe('discovery markStale POTATURA dal roster (corpus #203 — metà sito)', () => {
  // Misurato: `stale` 22-44 modelli per run, `quota` 0. I due motivi erano già distinti in
  // `_exhaustReason` e solo `quota` persiste (fino a mezzanotte UTC), il che è giusto — un
  // id dismesso non ha niente a che vedere con un budget giornaliero. Ma marcarlo e basta
  // lo lasciava NEL roster: ogni run lo ripercorreva, lo rimarcava, e qualunque percorso
  // che legge la chain prima della fine della discovery lo provava per davvero.
  it('un id che il provider non offre più esce dalla chain, non solo marcato', async () => {
    DEFAULT_CHAIN.push(`${PREFIX}static-a`, `${PREFIX}static-b`);
    mockFetch([{ id: 'static-a' }]);
    const res = await _discoverProvider(makeCfg({ markStale: true }));
    expect(res.stale).toBe(1);
    // La potatura, cioè il punto di questo cambio.
    expect(DEFAULT_CHAIN).not.toContain(`${PREFIX}static-b`);
    expect(prunedStaleModels()).toContain(`${PREFIX}static-b`);
    // Il vivo resta, e resta marcato per chi ha già una copia della chain.
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}static-a`);
    expect(getStats().exhaustedModels).toContain(`${PREFIX}static-b`);
    // Nessun modello marcato `stale` sopravvive nel roster: 22-44 → 0.
    const staleLeftInRoster = DEFAULT_CHAIN.filter((m) => prunedStaleModels().includes(m));
    expect(staleLeftInRoster).toEqual([]);
  });

  it('RIENTRO per evidenza: se il provider torna a offrirlo, la discovery lo re-inietta', async () => {
    DEFAULT_CHAIN.push(`${PREFIX}static-b`);
    mockFetch([{ id: 'static-a' }]); // static-b dismesso
    await _discoverProvider(makeCfg({ markStale: true }));
    expect(DEFAULT_CHAIN).not.toContain(`${PREFIX}static-b`);
    // Run successiva: il provider lo rimette in listing → rientra dal loop di add,
    // perché non è più fra gli `existingIds`. Nessun timer, nessuno stato persistito.
    resetState();
    mockFetch([{ id: 'static-a' }, { id: 'static-b' }]);
    const res = await _discoverProvider(makeCfg({ markStale: true }));
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}static-b`);
    expect(res.stale).toBe(0);
  });

  it('il guard sul listing vuoto viene PRIMA della potatura: un glitch non svuota il roster', async () => {
    DEFAULT_CHAIN.push(`${PREFIX}static-a`, `${PREFIX}static-b`);
    mockFetch([]); // 200 con body vuoto = glitch API
    const res = await _discoverProvider(makeCfg({ markStale: true }));
    expect(res.stale).toBe(0);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}static-a`);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}static-b`);
    expect(prunedStaleModels()).toEqual([]);
  });

  it('senza markStale il provider non pota niente (comportamento preesistente)', async () => {
    DEFAULT_CHAIN.push(`${PREFIX}static-b`);
    mockFetch([{ id: 'static-a' }]);
    const res = await _discoverProvider(makeCfg());
    expect(res.stale).toBe(0);
    expect(DEFAULT_CHAIN).toContain(`${PREFIX}static-b`);
  });
});

describe('discovery transport guard', () => {
  it('a non-ok API response is a no-op (keeps the static list)', async () => {
    mockFetch({}, { ok: false, status: 500 });
    const res = await _discoverProvider(makeCfg({ markStale: true }));
    expect(res).toEqual({ added: 0, stale: 0 });
    expect(DEFAULT_CHAIN.length).toBe(baseChainLen);
  });
});
