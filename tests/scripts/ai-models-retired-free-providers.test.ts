import { afterEach, describe, expect, it, vi } from 'vitest';

// Decisione del proprietario (2026-09-25, «Per le free ai provider,
// sostituiscile con codex luna Max»): i provider free che lo smoke-test trova a
// terra in modo permanente — Mistral, SambaNova, Cerebras, HuggingFace (HTTP
// 402), Together (401) e Fireworks (412), run 35602541133 / 35995800618 —
// escono da DEFAULT_CHAIN e dalla discovery. Le chiamate che servivano le
// prende Codex Luna Max dove il chiamante lo preferisce. Gemello del caso in
// generator/tests/ai-models-roster.test.mjs del corpus.

type AiModels = {
  AI_MODELS: Record<string, string>;
  DEFAULT_CHAIN: string[];
  DISCOVERY_PROVIDERS: ReadonlyArray<{ name: string }>;
  RETIRED_FREE_PROVIDERS: readonly string[];
  discoverFreeModels: () => Promise<string[]>;
  getProvider: (model: string) => string;
};

// Un modulo fresco per test: il latch della discovery del sito non si azzera
// con resetState().
async function freshAiModels(): Promise<AiModels> {
  vi.resetModules();
  return (await import('../../scripts/lib/ai-models.mjs')) as unknown as AiModels;
}

const SPENTI = ['mistral', 'sambanova', 'cerebras', 'huggingface', 'together', 'fireworks'];
const CHIAVI = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY',
  'NVIDIA_API_KEY', 'SAMBANOVA_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
  'COHERE_API_KEY',
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('provider free spenti (RETIRED_FREE_PROVIDERS)', () => {
  it('sono esattamente quelli trovati morti dallo smoke-test', async () => {
    const { RETIRED_FREE_PROVIDERS } = await freshAiModels();
    expect([...RETIRED_FREE_PROVIDERS].sort()).toEqual([...SPENTI].sort());
  });

  it('DEFAULT_CHAIN non offre piu\' nessun loro modello, il catalogo resta', async () => {
    const { AI_MODELS, DEFAULT_CHAIN, RETIRED_FREE_PROVIDERS, getProvider } = await freshAiModels();
    expect(DEFAULT_CHAIN.filter((m) => RETIRED_FREE_PROVIDERS.includes(getProvider(m)))).toEqual([]);
    expect(getProvider(AI_MODELS.MISTRAL_SMALL)).toBe('mistral');
    expect(getProvider(AI_MODELS.HF_LLAMA_3_3_70B)).toBe('huggingface');
  });

  it('la discovery non ne interroga il listing, e interroga ancora gli altri', async () => {
    for (const k of CHIAVI) vi.stubEnv(k, 'chiave-finta');
    const interrogati: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      interrogati.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errori = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ai = await freshAiModels();
    const catenaPrima = [...ai.DEFAULT_CHAIN];
    await ai.discoverFreeModels();

    for (const host of ['api.mistral.ai', 'api.cerebras.ai', 'api.sambanova.ai', 'api.together.xyz', 'api.fireworks.ai']) {
      expect(interrogati.some((url) => url.includes(host)), host).toBe(false);
    }
    // Senza questa meta' il test passerebbe anche con la discovery spenta del tutto.
    for (const host of ['openrouter.ai', 'api.groq.com', 'integrate.api.nvidia.com']) {
      expect(interrogati.some((url) => url.includes(host)), host).toBe(true);
    }
    expect(ai.DEFAULT_CHAIN).toEqual(catenaPrima);
    const righe = errori.mock.calls.map((args) => args.join(' '));
    expect(righe.filter((r) => r.includes('provider spenti non interrogati'))).toHaveLength(1);
    // Le voci restano, per il giorno in cui l'account torna utilizzabile.
    expect(ai.DISCOVERY_PROVIDERS.some((cfg) => cfg.name === 'Mistral')).toBe(true);
  });
});
